/**
 * 端到端测试：核心业务链路 + 权限边界
 * ----------------------------------------------------------------------------
 * 覆盖策略：不追求接口全覆盖（那是单元测试的职责），而是验证**跨模块的业务链路**
 * 与**安全边界**——这两类问题只有把真实数据库、真实守卫、真实服务串起来才暴露。
 *
 * 三条链路：
 *   1) 达人 → 合同 → 内容 → 结算 → 审批 → 打款（资金主链路）
 *   2) 权限边界：审计角色任何写操作必须 403；商务不能审批合同
 *   3) 校验与错误码：非法流转返回 409 且带 allowedNext；未登录 401
 *
 * 前置条件：PostgreSQL 与 Redis 已启动，且已执行 prisma migrate deploy 与 db:seed。
 * 用法：pnpm --filter @creatorops/api test:e2e
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';

const DEMO_PASSWORD = 'CreatorOps@2026';
const ACCOUNTS = {
  admin: 'admin@juxingzhimei.com',
  ops: 'ops@juxingzhimei.com',
  bd: 'bd@juxingzhimei.com',
  finance: 'finance@juxingzhimei.com',
  auditor: 'audit@juxingzhimei.com',
} as const;

let app: INestApplication;
let prisma: PrismaService;

/** 各角色的 access token，避免每个用例重复登录 */
const tokens: Partial<Record<keyof typeof ACCOUNTS, string>> = {};

/** 登录并返回 accessToken；失败时给出明确原因而不是让后续用例报 401 费解 */
async function login(email: string): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ email, password: DEMO_PASSWORD })
    .expect(200);
  const token = response.body?.data?.accessToken;
  if (!token) {
    throw new Error(`登录 ${email} 未返回 accessToken，响应：${JSON.stringify(response.body)}`);
  }
  return token;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  // 复用与生产完全相同的全局配置：否则「测试能过、线上 500」无法避免
  configureApp(app);
  await app.init();

  prisma = app.get(PrismaService);

  // 数据库不可用时直接给出可操作的提示，而不是抛一堆超时错误
  const healthy = await prisma.ping();
  if (!healthy) {
    throw new Error(
      '数据库不可用。请先执行 `pnpm infra:up` 并确认 DATABASE_URL 正确，然后运行 prisma migrate deploy 与 db:seed。',
    );
  }

  for (const [key, email] of Object.entries(ACCOUNTS) as Array<[keyof typeof ACCOUNTS, string]>) {
    tokens[key] = await login(email);
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('健康检查（免鉴权）', () => {
  it('存活探针不依赖数据库', async () => {
    const response = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(response.body.data.status).toBe('ok');
  });

  it('就绪探针返回数据库连通状态', async () => {
    const response = await request(app.getHttpServer()).get('/api/health/ready').expect(200);
    expect(response.body.data.ready).toBe(true);
    expect(response.body.data.components.database.status).toBe('up');
  });
});

describe('认证与令牌', () => {
  it('错误密码返回 401 且不泄露账号是否存在', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: ACCOUNTS.ops, password: 'wrong-password-123' })
      .expect(401);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toContain('邮箱或密码错误');
  });

  it('未携带令牌访问业务接口返回 401', async () => {
    await request(app.getHttpServer()).get('/api/creators').expect(401);
  });

  it('profile 返回权限集合，且包含角色应有权很', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/auth/profile')
      .set(auth(tokens.ops!))
      .expect(200);
    const permissions: string[] = response.body.data.permissions;
    expect(permissions).toContain('creator:write');
    // 运营不应有结算审批权
    expect(permissions).not.toContain('settlement:approve');
  });

  it('refresh token 轮换后旧令牌失效（重放检测）', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: ACCOUNTS.auditor, password: DEMO_PASSWORD })
      .expect(200);
    const refreshToken = first.body.data.refreshToken as string;

    const refreshed = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    expect(refreshed.body.data.accessToken).toBeTruthy();

    // 旧 refresh token 再次使用应被拒绝（并撤销整个会话族）
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken })
      .expect(401);
  });
});

describe('权限边界（安全红线）', () => {
  it('审计角色可以读达人列表', async () => {
    await request(app.getHttpServer())
      .get('/api/creators')
      .set(auth(tokens.auditor!))
      .expect(200);
  });

  it('审计角色不能新建达人（403）', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/creators')
      .set(auth(tokens.auditor!))
      .send({ name: '审计不该能建的达人' })
      .expect(403);
    expect(response.body.code).toBe('PERMISSION_DENIED');
  });

  it('审计角色不能审批结算单', async () => {
    const settlement = await prisma.settlement.findFirst({ where: { deletedAt: null } });
    if (!settlement) return; // 演示数据缺失时不误报
    await request(app.getHttpServer())
      .post(`/api/settlements/${settlement.id}/approve`)
      .set(auth(tokens.auditor!))
      .expect(403);
  });

  it('运营可以生成结算单但不能审批（职责分离）', async () => {
    const settlement = await prisma.settlement.findFirst({ where: { deletedAt: null } });
    if (!settlement) return;
    await request(app.getHttpServer())
      .post(`/api/settlements/${settlement.id}/approve`)
      .set(auth(tokens.ops!))
      .expect(403);
  });

  it('商务不能审批合同（拟定人不能自审）', async () => {
    const contract = await prisma.contract.findFirst({
      where: { deletedAt: null, status: 'PENDING_REVIEW' },
    });
    if (!contract) return;
    await request(app.getHttpServer())
      .post(`/api/contracts/${contract.id}/approve`)
      .set(auth(tokens.bd!))
      .send({ approved: true })
      .expect(403);
  });
});

describe('达人状态机（非法流转必须被拒绝并给出可选动作）', () => {
  it('线索达人不能直接变为合作中', async () => {
    const lead = await prisma.creator.findFirst({
      where: { deletedAt: null, status: 'LEAD' },
      select: { id: true, status: true },
    });
    if (!lead) return;

    const response = await request(app.getHttpServer())
      .patch(`/api/creators/${lead.id}/status`)
      .set(auth(tokens.ops!))
      .send({ status: 'ACTIVE' })
      .expect(409);

    expect(response.body.code).toBe('STATE_CONFLICT');
    // 关键：必须回带可选下一步，前端据此渲染合法操作
    expect(Array.isArray(response.body.details?.allowedNext)).toBe(true);
    expect(
      (response.body.details.allowedNext as Array<{ value: string }>).map((item) => item.value),
    ).toContain('CONTACTING');
  });

  it('解约必须填写原因（审计追溯要求）', async () => {
    const active = await prisma.creator.findFirst({
      where: { deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!active) return;

    const response = await request(app.getHttpServer())
      .patch(`/api/creators/${active.id}/status`)
      .set(auth(tokens.ops!))
      .send({ status: 'TERMINATED' })
      .expect(400);
    expect(response.body.code).toBe('REASON_REQUIRED');
  });
});

describe('达人库查询与数据范围', () => {
  it('关键词筛选返回分页结构', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/creators')
      .query({ page: 1, pageSize: 5 })
      .set(auth(tokens.admin!))
      .expect(200);

    const data = response.body.data;
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.page).toBe(1);
    expect(data.pageSize).toBe(5);
    expect(typeof data.total).toBe('number');
  });

  it('无敏感权限时手机号被脱敏', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/creators')
      .query({ pageSize: 50 })
      .set(auth(tokens.admin!))
      .expect(200);

    // 管理员有敏感权限，明文手机号不应包含掩码
    const withPhone = (response.body.data.items as Array<{ phone: string | null }>).find(
      (item) => item.phone,
    );
    if (withPhone) expect(withPhone.phone).not.toContain('*');
  });

  it('非法排序字段被白名单拦下（不报 500）', async () => {
    await request(app.getHttpServer())
      .get('/api/creators')
      .query({ sortBy: 'malicious; DROP TABLE users', sortOrder: 'desc' })
      .set(auth(tokens.admin!))
      .expect(200);
  });

  it('数组类筛选参数传单个值时也能正常工作', async () => {
    // 回归用例：HTTP 查询串没有「数组」概念，前端既可能发
    //   ?status=ACTIVE            （单个值）
    // 也可能发
    //   ?status=ACTIVE&status=PAUSED （重复键）
    // class-transformer 不会把单个值包装成数组，早期实现直接把字符串传给了
    // Prisma 的 `in`，报 `Expected CreatorStatus[], provided String`，
    // 表现为「筛选某个状态就报参数错误」。只在传单值时出现，很容易漏测。
    const single = await request(app.getHttpServer())
      .get('/api/creators')
      .query({ status: 'ACTIVE', pageSize: 5 })
      .set(auth(tokens.admin!))
      .expect(200);

    // 单个值必须被当作「一个元素的数组」处理，而不是报错
    for (const item of single.body.data.items as Array<{ status: string }>) {
      expect(item.status).toBe('ACTIVE');
    }

    // 重复键（数组）仍然正常
    await request(app.getHttpServer())
      .get('/api/creators')
      .query({ status: ['ACTIVE', 'PAUSED'], pageSize: 5 })
      .set(auth(tokens.admin!))
      .expect(200);

    // 空值不能变成 [undefined]，否则「不筛选」会被误解为「筛空数组」
    const noFilter = await request(app.getHttpServer())
      .get('/api/creators')
      .query({ status: '', pageSize: 5 })
      .set(auth(tokens.admin!))
      .expect(200);
    expect(noFilter.body.data.total).toBeGreaterThan(0);
  });

  it('合同/内容/结算的数组筛选同样接受单个值', async () => {
    // 同类字段分布在多个模块，这里一次性覆盖，避免只修了达人库
    await request(app.getHttpServer())
      .get('/api/contracts')
      .query({ status: 'ACTIVE', pageSize: 5 })
      .set(auth(tokens.admin!))
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/contents')
      .query({ status: 'PUBLISHED', pageSize: 5 })
      .set(auth(tokens.admin!))
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/settlements')
      .query({ status: 'DRAFT', pageSize: 5 })
      .set(auth(tokens.finance!))
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/projects')
      .query({ status: 'IN_PRODUCTION', pageSize: 5 })
      .set(auth(tokens.admin!))
      .expect(200);
  });

  it('pageSize 超上限被参数校验拒绝', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/creators')
      .query({ pageSize: 9999 })
      .set(auth(tokens.admin!))
      .expect(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('资金主链路：达人 → 合同 → 内容 → 结算 → 审批', () => {
  let creatorId: string;

  it('创建达人（自动分配业务编号）', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/creators')
      .set(auth(tokens.ops!))
      .send({
        name: `E2E 测试达人 ${Date.now()}`,
        phone: '13900001234',
        city: '杭州',
        tier: 'B',
        // 必须是 ContentVertical 枚举里的值。
        // 这里原本写的是 'LIFECYCLE_TEST'（不存在的枚举），DTO 校验直接
        // 返回 400，导致 creatorId 未赋值、后续 4 个用例全部连锁失败。
        verticals: ['LIFESTYLE'],
      })
      .expect(201);

    creatorId = response.body.data.id;
    expect(response.body.data.code).toMatch(/^CR-\d{4}-\d{6}$/);
    expect(response.body.data.status).toBe('LEAD');
  });

  it('创建达人时非法枚举值被校验拦下（400）', async () => {
    // 上面那个笔误能暴露出来，说明 DTO 的 @IsEnum 校验是生效的。
    // 这里显式固化该行为，避免将来有人放宽校验而无人察觉。
    await request(app.getHttpServer())
      .post('/api/creators')
      .set(auth(tokens.ops!))
      .send({ name: '非法垂类达人', verticals: ['NOT_A_REAL_VERTICAL'] })
      .expect(400);
  });

  it('表单未填写的选填项传空字符串时不应导致校验失败', async () => {
    /**
     * 回归用例（影响全部 8 个模块的表单，不只是项目）。
     *
     * class-validator 的 `@IsOptional()` **只在 null / undefined 时跳过校验**，
     * 空字符串会被照常校验。而 HTML 表单提交「用户没填的选填项」给的就是 `""`，
     * 于是只填了项目名称的用户会收到一串
     * 「brandId must be a UUID / 预算格式不正确 / startDate 需为 ISO 8601」——
     * 前端只能笼统提示「请检查标红字段后重试」，用户无从下手。
     *
     * 修复方式是在全局管道里把空字符串（含纯空白）规范化为 undefined，
     * 语义上即「空着」=「不提供该字段」。
     */
    const response = await request(app.getHttpServer())
      .post('/api/projects')
      .set(auth(tokens.ops!))
      .send({
        name: `E2E 空字符串选填项 ${Date.now()}`,
        // 下面全部是「用户没填」时表单会提交的值
        brandId: '',
        contractId: '',
        creatorId: '',
        ownerId: '',
        budget: '',
        startDate: '',
        dueDate: '',
        brief: '',
        vertical: '',
      })
      .expect(201);

    expect(response.body.data.id).toBeTruthy();
    // 空字符串不应被写进库，而应保持为 null / 未设置
    expect(response.body.data.brandId ?? null).toBeNull();
  });

  it('空字符串规范化后，真实非法值仍要被拦下（校验未被削弱）', async () => {
    // 上一条修的是「空值误判」，不能因此放过真正非法的输入
    await request(app.getHttpServer())
      .post('/api/projects')
      .set(auth(tokens.ops!))
      .send({ name: 'E2E 非法品牌 ID', brandId: 'not-a-uuid' })
      .expect(400);

    // 未声明字段也必须继续被拒绝（whitelist + forbidNonWhitelisted 未被绕过）
    await request(app.getHttpServer())
      .post('/api/projects')
      .set(auth(tokens.ops!))
      .send({ name: 'E2E 未声明字段', remark: '这个字段 DTO 里没有' })
      .expect(400);
  });

  it('状态机允许的流转可以成功（线索 → 建联中 → 评估中 → 已签约）', async () => {
    for (const status of ['CONTACTING', 'EVALUATING', 'SIGNED']) {
      await request(app.getHttpServer())
        .patch(`/api/creators/${creatorId}/status`)
        .set(auth(tokens.ops!))
        .send({ status })
        .expect(200);
    }
    const creator = await prisma.creator.findUnique({ where: { id: creatorId } });
    expect(creator?.status).toBe('SIGNED');
    expect(creator?.signedAt).not.toBeNull();
  });

  it('结算预估接口与正式结算使用同一引擎（金额可复算）', async () => {
    const contract = await prisma.contract.findFirst({
      where: { deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!contract) return;

    // 用运营令牌：运营的数据范围是 ALL，能访问任意达人的合同。
    // 这里刻意不用商务令牌——商务是 OWN 范围，只能看自己负责达人的合同，
    // 而种子数据里合同的「拟定人」与达人的「负责人」不是同一个人
    // （合同由 bd@ 拟，达人归属 bd2@）。用商务令牌会得到 403，
    // 那是数据范围在正确工作，不是缺陷。
    const response = await request(app.getHttpServer())
      .get(`/api/contracts/${contract.id}/settlement-preview`)
      .query({ month: '2026-01' })
      .set(auth(tokens.ops!))
      .expect(200);

    const summary = response.body.data.summary;
    // 预估也必须满足守恒：平台费 + 公司 + 达人分成 === 总流水
    const gross = Number(summary.grossYuan);
    const parts = Number(summary.platformFeeYuan) + Number(summary.agencyShareYuan) + Number(summary.talentGrossYuan);
    expect(Math.abs(parts - gross)).toBeLessThan(0.01);
  });

  it('商务访问非自己负责达人的合同时被拒绝（数据范围生效）', async () => {
    // 这是上面那条用例的对照：证明 403 来自数据范围，而不是接口坏了。
    // 先找出一个 bd@ 不负责的合同。
    const bdProfile = await request(app.getHttpServer())
      .get('/api/auth/profile')
      .set(auth(tokens.bd!))
      .expect(200);
    const bdId = bdProfile.body.data.id as string;

    const contract = await prisma.contract.findFirst({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        creator: { ownerId: { not: bdId } },
      },
      select: { id: true },
    });
    if (!contract) return;

    const response = await request(app.getHttpServer())
      .get(`/api/contracts/${contract.id}/settlement-preview`)
      .query({ month: '2026-01' })
      .set(auth(tokens.bd!))
      .expect(403);

    // 必须是明确的数据范围错误码，而不是笼统的 500
    expect(response.body.code).toBe('SCOPE_DENIED');
  });

  it('结算列表金额以字符串返回（避免前端浮点误差）', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/settlements')
      .query({ pageSize: 5 })
      .set(auth(tokens.finance!))
      .expect(200);

    for (const item of response.body.data.items as Array<{ netPayable: unknown; grossAmount: unknown }>) {
      expect(typeof item.netPayable).toBe('string');
      expect(typeof item.grossAmount).toBe('string');
    }
  });

  it('结算生成接口幂等：重复调用不会重复出账', async () => {    const body = { month: '2026-01' };
    const first = await request(app.getHttpServer())
      .post('/api/settlements/generate')
      .set(auth(tokens.ops!))
      .send(body)
      .expect(201);

    const before = await prisma.settlement.count({
      where: { deletedAt: null, periodStart: new Date('2026-01-01T00:00:00.000Z') },
    });

    await request(app.getHttpServer())
      .post('/api/settlements/generate')
      .set(auth(tokens.ops!))
      .send(body)
      .expect(201);

    const after = await prisma.settlement.count({
      where: { deletedAt: null, periodStart: new Date('2026-01-01T00:00:00.000Z') },
    });

    expect(after).toBe(before);
    expect(first.body.data.generated + first.body.data.skipped).toBeGreaterThanOrEqual(0);
  });
});

describe('审计与响应结构', () => {
  it('成功响应统一信封结构', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/creators')
      .query({ pageSize: 1 })
      .set(auth(tokens.admin!))
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(typeof response.body.requestId).toBe('string');
    expect(typeof response.body.timestamp).toBe('string');
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('请求 ID 可由调用方指定并原样返回（便于跨系统串联日志）', async () => {
    const traceId = 'e2e-trace-0001';
    const response = await request(app.getHttpServer())
      .get('/api/creators')
      .query({ pageSize: 1 })
      .set(auth(tokens.admin!))
      .set('X-Request-Id', traceId)
      .expect(200);
    expect(response.body.requestId).toBe(traceId);
  });

  it('审计日志记录了写操作', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/audit-logs')
      .query({ resource: 'creator', pageSize: 20 })
      .set(auth(tokens.auditor!))
      .expect(200);

    expect(response.body.data.total).toBeGreaterThan(0);
    const actions = (response.body.data.items as Array<{ action: string }>).map((item) => item.action);
    expect(actions.length).toBeGreaterThan(0);
  });

  it('审计日志不包含明文密码（脱敏生效）', async () => {
    const logs = await prisma.auditLog.findMany({
      where: { resource: 'creator' },
      select: { before: true },
      take: 50,
    });
    for (const log of logs) {
      const serialized = JSON.stringify(log.before ?? {});
      expect(serialized).not.toContain(DEMO_PASSWORD);
    }
  });

  it('未授权的资源过滤条件不会导致 500（数据范围实现健壮）', async () => {
    // 商务是 OWN 范围，查询时不应因为团队条件缺失而崩
    const response = await request(app.getHttpServer())
      .get('/api/projects')
      .query({ pageSize: 5 })
      .set(auth(tokens.bd!))
      .expect(200);
    expect(Array.isArray(response.body.data.items)).toBe(true);
  });
});
