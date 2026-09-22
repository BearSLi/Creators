import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 业务编号生成器。
 *
 * 需求：合同编号 CR-2026-000123 这类编号要「人可读、可排序、无重复」。
 * 方案：数据库行级锁 + 按前缀自增计数，放在业务事务内，保证并发安全。
 *   - 用 INSERT ... ON CONFLICT DO UPDATE 原子自增，避免读-改-写竞态；
 *   - 显式传入 tx，使编号分配与业务写入同一事务：业务失败时编号回滚，不留空洞。
 * 备选方案（雪花 ID / 数据库序列）在本项目被否的原因：
 *   编号需要按「资源类型 + 年份」重置且便于业务人员口头沟通，雪花 ID 不满足可读性。
 */

export const CODE_PREFIX = {
  CREATOR: 'CR',
  CONTRACT: 'CT',
  PROJECT: 'PJ',
  CONTENT: 'CN',
  SETTLEMENT: 'ST',
} as const;

export type CodePrefix = (typeof CODE_PREFIX)[keyof typeof CODE_PREFIX];

export interface SequenceClient {
  $queryRaw: PrismaService['$queryRaw'];
}

@Injectable()
export class CodeGeneratorService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 生成业务编号，形如 CR-2026-000123。
   * @param prefix 资源前缀
   * @param client 事务客户端；强烈建议传入，保证与业务写入同事务
   */
  async next(
    prefix: CodePrefix,
    client: SequenceClient = this.prisma,
    now = new Date(),
  ): Promise<string> {
    const year = now.getFullYear();
    const scope = `${prefix}-${year}`;

    const rows = await client.$queryRaw<Array<{ value: number }>>`
      INSERT INTO code_sequences (scope, value, updated_at)
      VALUES (${scope}, 1, NOW())
      ON CONFLICT (scope)
      DO UPDATE SET value = code_sequences.value + 1, updated_at = NOW()
      RETURNING value
    `;

    const value = rows[0]?.value ?? 1;
    return `${scope}-${String(value).padStart(6, '0')}`;
  }

  /** 批量生成（批量导入达人时使用，避免 N 次往返） */
  async nextBatch(
    prefix: CodePrefix,
    count: number,
    client: SequenceClient = this.prisma,
    now = new Date(),
  ): Promise<string[]> {
    if (count <= 0) return [];
    const year = now.getFullYear();
    const scope = `${prefix}-${year}`;

    const rows = await client.$queryRaw<Array<{ value: number }>>`
      INSERT INTO code_sequences (scope, value, updated_at)
      VALUES (${scope}, ${count}, NOW())
      ON CONFLICT (scope)
      DO UPDATE SET value = code_sequences.value + ${count}, updated_at = NOW()
      RETURNING value
    `;
    const end = rows[0]?.value ?? count;
    const start = end - count + 1;
    return Array.from({ length: count }, (_, index) =>
      `${scope}-${String(start + index).padStart(6, '0')}`,
    );
  }
}
