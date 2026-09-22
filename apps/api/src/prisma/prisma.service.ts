import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { env, isProduction } from '../config/index';

/**
 * Prisma 客户端封装。
 *
 * 关键点：
 * 1) 连接池大小由 DATABASE_POOL_SIZE 显式控制。默认 Prisma 池为 num_cpus*2+1，
 *    在多实例 + PgBouncer 部署下会打爆数据库连接数，必须可调。
 * 2) 开发环境打印慢查询（>300ms）与警告，便于上线前定位 N+1。
 * 3) 提供 withTransaction 助手：统一超时与重试策略，避免各处手写 $transaction。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const url = new URL(env.DATABASE_URL);
    // 通过连接串参数控制池大小，Prisma 会读取 connection_limit
    url.searchParams.set('connection_limit', String(env.DATABASE_POOL_SIZE));
    url.searchParams.set('pool_timeout', '20');

    super({
      datasources: { db: { url: url.toString() } },
      log: isProduction
        ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
        : [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ],
      errorFormat: isProduction ? 'minimal' : 'pretty',
    });
  }

  async onModuleInit(): Promise<void> {
    this.$on('error' as never, (event: Prisma.LogEvent) => {
      this.logger.error(`Prisma error: ${event.message}`);
    });
    this.$on('warn' as never, (event: Prisma.LogEvent) => {
      this.logger.warn(`Prisma warn: ${event.message}`);
    });
    if (!isProduction) {
      this.$on('query' as never, (event: Prisma.QueryEvent) => {
        if (event.duration >= 300) {
          this.logger.warn(`慢查询 ${event.duration}ms: ${event.query}`);
        }
      });
    }
    await this.$connect();
    this.logger.log(`数据库已连接（连接池上限 ${env.DATABASE_POOL_SIZE}）`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * 事务包装：统一超时，并在死锁/序列化冲突时有限重试。
   * 结算与合同审批都走这里，保证「要么全成、要么全不成」。
   */
  async withTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { timeoutMs?: number; maxWaitMs?: number; retries?: number } = {},
  ): Promise<T> {
    const { timeoutMs = 15_000, maxWaitMs = 5_000, retries = 2 } = options;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.$transaction(fn, { timeout: timeoutMs, maxWait: maxWaitMs });
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          ['P2034', 'P2028'].includes(error.code);
        if (!retryable || attempt === retries) throw error;
        // 指数退避 + 抖动，避免并发事务同步重试再次撞车
        const backoff = 50 * 2 ** attempt + Math.floor(Math.random() * 40);
        this.logger.warn(`事务冲突(${(error as Prisma.PrismaClientKnownRequestError).code})，${backoff}ms 后第 ${attempt + 2} 次尝试`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    throw lastError;
  }

  /** 健康检查用：探测数据库连通性 */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
