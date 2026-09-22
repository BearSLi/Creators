import { DocumentBuilder } from '@nestjs/swagger';
import { env } from './index';

/**
 * OpenAPI 文档定义。
 *
 * 单独抽出来的原因：**同一个定义要服务两个消费方**——
 *   1) `main.ts` 在非生产环境挂载 Swagger UI（人工查阅）；
 *   2) `scripts/generate-openapi.mjs` 导出 openapi.json 供前端生成类型与契约校验。
 *
 * 如果两处各写一份 DocumentBuilder，就会出现「文档上有的字段、导出的 spec 里没有」
 * 这类漂移，而契约校验的意义正是消除漂移。因此这里是唯一定义点。
 *
 * 另外这些 `.addTag()` 的 description 不只是装饰：前端生成类型时会以
 * tags 做分组，也是接口文档可读性的一部分。
 */
export function buildSwaggerConfig() {
  return new DocumentBuilder()
    .setTitle('CreatorOps · 达人合作管理平台 API')
    .setDescription(
      [
        '聚猩智媒内部达人合作全流程管理平台后端接口。',
        '',
        '**鉴权**：除 /api/auth/login、/api/auth/refresh、/api/health 外，所有接口都需要 Bearer Token。',
        '',
        '**统一响应结构**：成功 `{ success: true, data, requestId, timestamp }`；',
        '失败 `{ success: false, code, message, details?, path, requestId, timestamp }`。',
        '',
        '**金额与比率约定**：金额返回为字符串（元，2 位小数）以避免浮点误差；',
        '分润比率以基点(bp)整数传输，1000 = 10%。',
        '',
        '**权限模型**：RBAC + 数据范围（ALL/TEAM/OWN）+ 资源归属校验，见 docs/permissions.md。',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: '登录后获取的 accessToken' },
      'bearer',
    )
    .addServer(env.PUBLIC_BASE_URL, '当前环境')
    .addTag('认证', '登录、刷新令牌、个人资料')
    .addTag('达人管理', '达人主数据、状态机、评估、标签')
    .addTag('品牌', '品牌/客户主数据')
    .addTag('合同管理', '合同拟定、审批、分润规则、结算预估')
    .addTag('项目', '内容项目与排期')
    .addTag('内容', '内容生产、审核、发布、数据采集')
    .addTag('结算管理', '结算生成、审批、打款、导出')
    .addTag('AI 能力', 'AI 任务、Prompt 模板、成本用量')
    .addTag('经营看板', 'KPI、漏斗、趋势、排行')
    .addTag('员工与权限', '账号、角色、团队')
    .addTag('审计日志', '操作审计查询')
    .addTag('健康检查', '存活与就绪探针')
    .build();
}
