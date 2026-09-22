import { Injectable, Logger } from '@nestjs/common';
import { ContractStatus, Prisma } from '@prisma/client';
import {
  DuplicateOperationException,
  ResourceNotFoundException,
} from '../../common/exceptions/business.exception';
import { buildPaginated, PaginatedResult, resolveOrderBy } from '../../common/utils/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { CONTRACT_STATUS_LABELS } from '../contracts/contract.service';
import { BRAND_LEVEL_LABELS, BrandLevel, CreateBrandDto, QueryBrandDto, UpdateBrandDto } from './dto/brand.dto';

/**
 * 品牌（客户）主数据服务。
 *
 * 业务定位：品牌是「钱的来源」，合同与项目都必须挂在品牌上，否则无法回答
 * 「这个客户今年贡献了多少流水、还有多少合同在跑」这类商务最关心的问题。
 * 因此本模块对外提供两个能力：
 *   1) 品牌档案 CRUD（含账期、发票信息等开票必需字段）；
 *   2) 品牌视角的汇总（合同数/在跑合同数/项目数/内容流水），供商务与经营看板使用。
 *
 * 两个刻意的设计：
 *   - 不做数据范围过滤：品牌是公司级客户资产，不是某个商务的私产；
 *     如果按 ownerId 收敛，会出现「换商务后客户资料消失」的数据事故。
 *     写权限仍然由 BRAND_WRITE 权限点控制（见 Controller）。
 *   - 删除只做软删除且被引用时拒绝：合同与项目都指向品牌，
 *     物理删除或强行软删会让历史合同的客户信息断链，财务对账时无法解释。
 */
@Injectable()
export class BrandService {
  private readonly logger = new Logger(BrandService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 品牌列表。所有筛选下推到数据库，避免把全量品牌读进内存再过滤 */
  async list(_user: AuthUser, query: QueryBrandDto): Promise<PaginatedResult<BrandListItem>> {
    const where: Prisma.BrandWhereInput = {
      deletedAt: null,
      level: query.level,
    };

    if (query.keyword) {
      const keyword = query.keyword.trim();
      // 关键词覆盖「品牌名 / 对接人 / 发票抬头」：财务找客户时记的是开票名称，
      // 商务找客户时记的是对接人，两条路径都要能命中。
      where.OR = [
        { name: { contains: keyword, mode: 'insensitive' } },
        { contactName: { contains: keyword, mode: 'insensitive' } },
        { invoiceTitle: { contains: keyword, mode: 'insensitive' } },
      ];
    }

    const orderBy = resolveOrderBy(
      query.sortBy,
      query.sortOrder,
      ['createdAt', 'updatedAt', 'name', 'level', 'paymentTermDays'] as const,
      'createdAt',
    );

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.brand.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.take,
        include: {
          // 过滤式计数：软删除的合同/项目不应再计入，否则列表数字与详情页对不上
          _count: {
            select: {
              contracts: { where: { deletedAt: null } },
              projects: { where: { deletedAt: null } },
            },
          },
        },
      }),
      this.prisma.brand.count({ where }),
    ]);

    return buildPaginated(
      rows.map((row) => this.toListItem(row)),
      total,
      query.page,
      query.pageSize,
    );
  }

  /** 品牌详情：档案 + 最近合同 + 汇总统计 */
  async findOne(_user: AuthUser, id: string): Promise<BrandDetail> {
    const brand = await this.prisma.brand.findFirst({
      where: { id, deletedAt: null },
      include: {
        _count: {
          select: {
            contracts: { where: { deletedAt: null } },
            projects: { where: { deletedAt: null } },
          },
        },
        contracts: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            code: true,
            title: true,
            status: true,
            effectiveFrom: true,
            effectiveTo: true,
            creator: { select: { name: true } },
          },
        },
      },
    });
    if (!brand) throw new ResourceNotFoundException('品牌');

    const [activeContractCount, revenueAgg] = await this.prisma.$transaction([
      this.prisma.contract.count({ where: { brandId: id, deletedAt: null, status: 'ACTIVE' } }),
      // 品牌流水按「项目下的内容」归因：内容才是流水的最小归因单元。
      // 不用合同金额是因为合同金额是应收上限，不是实际发生的流水。
      this.prisma.content.aggregate({
        where: { deletedAt: null, project: { brandId: id, deletedAt: null } },
        _sum: { revenueCents: true },
      }),
    ]);

    return {
      ...this.toListItem(brand),
      remark: brand.remark,
      contracts: brand.contracts.map((contract) => ({
        id: contract.id,
        code: contract.code,
        title: contract.title,
        creatorName: contract.creator.name,
        status: contract.status,
        statusLabel: CONTRACT_STATUS_LABELS[contract.status],
        effectiveFrom: contract.effectiveFrom.toISOString().slice(0, 10),
        effectiveTo: contract.effectiveTo.toISOString().slice(0, 10),
      })),
      stats: {
        contractCount: brand._count.contracts,
        activeContractCount,
        projectCount: brand._count.projects,
        totalRevenueYuan: centsToYuanString(revenueAgg._sum.revenueCents),
      },
    };
  }

  /** 新建品牌。名称是客户的业务主键，重名会让报价与开票直接串户，必须拦住 */
  async create(user: AuthUser, dto: CreateBrandDto): Promise<BrandDetail> {
    await this.assertNameAvailable(dto.name);

    const created = await this.prisma.brand.create({
      data: {
        name: dto.name.trim(),
        industry: dto.industry ?? null,
        contactName: dto.contactName ?? null,
        contactPhone: dto.contactPhone ?? null,
        level: dto.level ?? 'B',
        paymentTermDays: dto.paymentTermDays ?? 30,
        invoiceTitle: dto.invoiceTitle ?? null,
        taxNo: dto.taxNo ?? null,
        remark: dto.remark ?? null,
      },
      select: { id: true },
    });

    this.logger.log(`新建品牌 id=${created.id} name=${dto.name} by=${user.email}`);
    return this.findOne(user, created.id);
  }

  /** 更新品牌档案（不含合同/项目关联，关联关系在相应模块维护） */
  async update(user: AuthUser, id: string, dto: UpdateBrandDto): Promise<BrandDetail> {
    const existing = await this.prisma.brand.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new ResourceNotFoundException('品牌');

    if (dto.name && dto.name.trim() !== existing.name) {
      await this.assertNameAvailable(dto.name, id);
    }

    await this.prisma.brand.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        industry: dto.industry,
        contactName: dto.contactName,
        contactPhone: dto.contactPhone,
        level: dto.level,
        paymentTermDays: dto.paymentTermDays,
        invoiceTitle: dto.invoiceTitle,
        taxNo: dto.taxNo,
        remark: dto.remark,
      },
    });

    return this.findOne(user, id);
  }

  /**
   * 软删除品牌。
   *
   * 被合同或项目引用时直接拒绝并给出引用数量：
   * 品牌一旦被引用，其 level（报价策略）与 paymentTermDays（账期）就是历史合同的
   * 计费依据之一；静默软删会让合同详情页出现「品牌已消失」，财务无法追溯账期约定。
   * 正确做法是保留品牌，通过合同终止/项目结项来结束合作。
   */
  async remove(user: AuthUser, id: string): Promise<{ id: string; deleted: true }> {
    const existing = await this.prisma.brand.findFirst({
      where: { id, deletedAt: null },
      include: {
        _count: {
          select: {
            contracts: { where: { deletedAt: null } },
            projects: { where: { deletedAt: null } },
          },
        },
      },
    });
    if (!existing) throw new ResourceNotFoundException('品牌');

    const blockers: string[] = [];
    if (existing._count.contracts > 0) blockers.push(`${existing._count.contracts} 份合同`);
    if (existing._count.projects > 0) blockers.push(`${existing._count.projects} 个项目`);
    if (blockers.length > 0) {
      throw new DuplicateOperationException(
        `品牌「${existing.name}」已被 ${blockers.join('、')}引用，删除会导致合同/项目的客户信息断链。如需停止合作请先结项并终止相关合同`,
        { contractCount: existing._count.contracts, projectCount: existing._count.projects },
      );
    }

    await this.prisma.brand.update({ where: { id }, data: { deletedAt: new Date() } });
    this.logger.log(`软删除品牌 id=${id} name=${existing.name} by=${user.email}`);
    return { id, deleted: true };
  }

  /** 名称唯一性校验（含软删除记录：Brand.name 是全局唯一索引，放开会直接撞库约束） */
  private async assertNameAvailable(name: string, excludeId?: string): Promise<void> {
    const duplicated = await this.prisma.brand.findFirst({
      where: { name: name.trim(), id: excludeId ? { not: excludeId } : undefined },
      select: { id: true, deletedAt: true },
    });
    if (duplicated) {
      throw new DuplicateOperationException(
        duplicated.deletedAt
          ? `品牌「${name}」已被一个已删除的历史记录占用，请改用其他名称或联系管理员清理`
          : `品牌「${name}」已存在，请勿重复创建`,
        { brandId: duplicated.id, softDeleted: Boolean(duplicated.deletedAt) },
      );
    }
  }

  private toListItem(row: BrandRow): BrandListItem {
    return {
      id: row.id,
      name: row.name,
      industry: row.industry,
      contactName: row.contactName,
      contactPhone: row.contactPhone,
      level: row.level,
      levelLabel: BRAND_LEVEL_LABELS[row.level as BrandLevel] ?? row.level,
      paymentTermDays: row.paymentTermDays,
      invoiceTitle: row.invoiceTitle,
      taxNo: row.taxNo,
      remark: null,
      contractCount: row._count.contracts,
      projectCount: row._count.projects,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

export interface BrandListItem {
  id: string;
  name: string;
  industry: string | null;
  contactName: string | null;
  contactPhone: string | null;
  level: string;
  levelLabel: string;
  paymentTermDays: number;
  invoiceTitle: string | null;
  taxNo: string | null;
  /** 列表页不返回长文本备注，避免表格接口体积失控；详情页给全量 */
  remark: string | null;
  contractCount: number;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BrandDetail extends BrandListItem {
  remark: string | null;
  contracts: Array<{
    id: string;
    code: string;
    title: string;
    creatorName: string;
    status: ContractStatus;
    statusLabel: string;
    effectiveFrom: string;
    effectiveTo: string;
  }>;
  stats: {
    contractCount: number;
    activeContractCount: number;
    projectCount: number;
    /** 内容流水合计（元，字符串避免浮点误差）；由项目下内容归因汇总 */
    totalRevenueYuan: string;
  };
}

/** 列表行形状：手动声明而非用 Prisma 泛型，避免 include 变化时类型爆炸式传递 */
interface BrandRow {
  id: string;
  name: string;
  industry: string | null;
  contactName: string | null;
  contactPhone: string | null;
  level: string;
  paymentTermDays: number;
  invoiceTitle: string | null;
  taxNo: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count: { contracts: number; projects: number };
}

/**
 * BigInt 分 → 元字符串。
 * 直接在 JSON 里返回 BigInt 会让序列化抛 TypeError，除以 100 又会引入浮点噪声，
 * 因此统一走「整数分 → 定点字符串」这条路径。
 */
export function centsToYuanString(cents: bigint | number | null | undefined): string {
  const value = typeof cents === 'bigint' ? cents : BigInt(Math.trunc(cents ?? 0));
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const yuan = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${yuan}.${fraction}`;
}
