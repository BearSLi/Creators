import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/index';
import { PrismaService } from '../../prisma/prisma.service';
import { env } from '../../config/index';

interface HealthComponent {
  status: 'up' | 'down';
  latencyMs?: number;
  message?: string;
}

/**
 * 健康检查。
 *
 * 分两个端点，用途不同：
 *   /api/health       存活探针（k8s liveness）：只证明进程能响应，不查外部依赖，
 *                     否则数据库抖动会导致容器被反复重启，反而放大故障。
 *   /api/health/ready 就绪探针（readiness）：检查数据库连通性，未就绪则不接流量。
 * 刻意不返回版本号以外的内部信息，避免给探测者提供指纹。
 */
@ApiTags('健康检查')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: '存活探针（不检查外部依赖）' })
  liveness() {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      env: env.NODE_ENV,
    };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: '就绪探针（检查数据库连通性）' })
  async readiness() {
    const database = await this.checkDatabase();
    const ready = database.status === 'up';
    // 用 503 表示未就绪，让负载均衡器把实例摘掉
    return {
      status: ready ? 'ok' : 'degraded',
      ready,
      components: { database },
      aiProvider: env.AI_PROVIDER,
      collectorMode: env.COLLECTOR_MODE,
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDatabase(): Promise<HealthComponent> {
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message.slice(0, 200) : '未知错误',
      };
    }
  }
}
