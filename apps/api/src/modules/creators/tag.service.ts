import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DuplicateOperationException, ResourceNotFoundException } from '../../common/exceptions/business.exception';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 标签服务。
 *
 * 标签是达人库的核心检索维度（「擅长剧情向」「可接受母婴品类」），
 * 由运营自由维护，因此：
 *   - 名称全局唯一，避免「短剧」和「短剧 」并存导致筛选漏数据（写入前 trim）；
 *   - 删除标签前检查引用量，被使用时给出明确提示而不是级联删掉达人关联。
 */
@Injectable()
export class TagService {
  constructor(private readonly prisma: PrismaService) {}

  async list(category?: string) {
    const tags = await this.prisma.tag.findMany({
      where: category ? { category } : undefined,
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { creators: true } } },
    });
    return tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      category: tag.category,
      color: tag.color,
      creatorCount: tag._count.creators,
      createdAt: tag.createdAt.toISOString(),
    }));
  }

  async create(input: { name: string; category: string; color?: string }) {
    const name = input.name.trim();
    if (!name) throw new DuplicateOperationException('标签名称不能为空');
    try {
      const tag = await this.prisma.tag.create({
        data: { name, category: input.category.trim(), color: input.color ?? null },
      });
      return { id: tag.id, name: tag.name, category: tag.category, color: tag.color };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new DuplicateOperationException(`标签「${name}」已存在`);
      }
      throw error;
    }
  }

  async update(id: string, input: { name?: string; category?: string; color?: string }) {
    const tag = await this.prisma.tag.findUnique({ where: { id } });
    if (!tag) throw new ResourceNotFoundException('标签');
    const updated = await this.prisma.tag.update({
      where: { id },
      data: {
        name: input.name?.trim() ?? undefined,
        category: input.category?.trim() ?? undefined,
        color: input.color ?? undefined,
      },
    });
    return { id: updated.id, name: updated.name, category: updated.category, color: updated.color };
  }

  async remove(id: string) {
    const tag = await this.prisma.tag.findUnique({
      where: { id },
      include: { _count: { select: { creators: true } } },
    });
    if (!tag) throw new ResourceNotFoundException('标签');
    if (tag._count.creators > 0) {
      throw new DuplicateOperationException(
        `标签「${tag.name}」已被 ${tag._count.creators} 位达人使用，请先解除关联再删除`,
      );
    }
    await this.prisma.tag.delete({ where: { id } });
    return { id, deleted: true };
  }
}
