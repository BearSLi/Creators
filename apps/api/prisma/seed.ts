/**
 * 演示数据种子脚本。
 *
 * 目标：`pnpm db:seed` 之后，任何同事打开系统就能看到一套**业务上自洽**的数据：
 *   达人 → 平台账号 → 数据快照 → 品牌 → 合同 → 项目 → 内容 → 结算单 → AI 任务
 * 自洽的含义（这是演示数据最容易做错的地方）：
 *   1) 达人状态与是否有合同一致（有生效合同的达人不会是「线索」）；
 *   2) 内容有收入才会产生结算明细，且结算明细金额与内容收入能对上；
 *   3) 结算单头部金额 = 明细汇总（可用结算校验逻辑复算通过）。
 *
 * 幂等：以邮箱/编号为自然键，存在则跳过，可反复执行。
 * 用法：
 *   pnpm db:seed                                   （推荐，会注入根目录 .env）
 *   pnpm --filter @creatorops/api prisma:seed      （需自行保证 DATABASE_URL 可见）
 */
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 在**实例化 PrismaClient 之前**加载环境变量。
 *
 * 为什么必须显式做这件事：PrismaClient 在构造时就会解析 schema 里的
 * `env("DATABASE_URL")`，取不到就直接抛 PrismaClientInitializationError。
 * 而环境变量在仓库根目录的 .env 里，Prisma CLI 与 tsx 都不会自动到仓库根去找，
 * 于是 `prisma:seed` 会以「Environment variable not found: DATABASE_URL」失败。
 * 这里显式按优先级尝试若干位置（不覆盖已存在的变量，便于临时指向别的库）。
 */
for (const candidate of [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
  resolve(__dirname, '../../.env'),
  resolve(__dirname, '../../../.env'),
]) {
  if (existsSync(candidate)) loadDotenv({ path: candidate });
}

if (!process.env.DATABASE_URL) {
  console.error(
    '未找到 DATABASE_URL。请确认仓库根目录存在 .env（可从 .env.example 复制），\n' +
      '或使用 pnpm db:seed（它会自动注入根目录 .env）。',
  );
  process.exit(1);
}

import { PrismaClient, Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { calculateSettlement, SettlementRule } from '../src/modules/settlements/settlement.calculator';
import { centsToDecimalString } from '../src/common/utils/money';

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'CreatorOps@2026';

/**
 * 采集数据来源标记。
 * 与运行时一致：未接入真实平台（COLLECTOR_MODE=mock）时，数据应标为 MOCK 而不是
 * 「官方接口」——否则看板与结算会把演示数据当成真实采集结果，这是数据诚信问题。
 */
const SEED_DATA_SOURCE = process.env.COLLECTOR_MODE === 'live' ? 'API_OFFICIAL' : 'MOCK';

interface SeedUser {
  email: string;
  name: string;
  role: 'SUPER_ADMIN' | 'OPERATIONS' | 'BD' | 'CONTENT' | 'FINANCE' | 'AUDITOR';
  teamCode: string;
}

const USERS: SeedUser[] = [
  { email: 'admin@juxingzhimei.com', name: '王思远', role: 'SUPER_ADMIN', teamCode: 'HQ' },
  { email: 'ops@juxingzhimei.com', name: '李欣桐', role: 'OPERATIONS', teamCode: 'OPS' },
  { email: 'ops2@juxingzhimei.com', name: '陈可', role: 'OPERATIONS', teamCode: 'OPS' },
  { email: 'bd@juxingzhimei.com', name: '张宇轩', role: 'BD', teamCode: 'BD' },
  { email: 'bd2@juxingzhimei.com', name: '周雨桐', role: 'BD', teamCode: 'BD' },
  { email: 'content@juxingzhimei.com', name: '赵一鸣', role: 'CONTENT', teamCode: 'CONTENT' },
  { email: 'finance@juxingzhimei.com', name: '孙倩', role: 'FINANCE', teamCode: 'FINANCE' },
  { email: 'audit@juxingzhimei.com', name: '吴迪', role: 'AUDITOR', teamCode: 'HQ' },
];

const TEAMS = [
  { code: 'HQ', name: '聚猩智媒总部' },
  { code: 'OPS', name: '达人运营中心' },
  { code: 'BD', name: '商务拓展部' },
  { code: 'CONTENT', name: '内容制作中心' },
  { code: 'FINANCE', name: '财务部' },
];

const TAGS = [
  { name: '剧情向', category: 'capability', color: '#6366F1' },
  { name: '口播能力强', category: 'capability', color: '#8B5CF6' },
  { name: '短剧经验', category: 'capability', color: '#EC4899' },
  { name: '美妆', category: 'category', color: '#F472B6' },
  { name: '母婴', category: 'category', color: '#FBBF24' },
  { name: '数码', category: 'category', color: '#38BDF8' },
  { name: '食品饮料', category: 'category', color: '#34D399' },
  { name: '档期紧张', category: 'risk', color: '#F97316' },
  { name: '历史延期', category: 'risk', color: '#EF4444' },
  { name: '海外内容', category: 'capability', color: '#0EA5E9' },
];

/** 达人种子：覆盖各状态、各垂类、各分级，便于演示筛选与状态机 */
const CREATORS = [
  {
    code: 'CR-2026-000001',
    name: '林小满',
    realName: '林曼',
    phone: '13800001111',
    wechat: 'linxiaoman2026',
    city: '杭州',
    status: 'ACTIVE' as const,
    tier: 'S' as const,
    verticals: ['SHORT_DRAMA', 'LIFESTYLE'] as const,
    styleTags: ['剧情向', '情绪张力强'],
    agencyType: 'FULL_MCN',
    agencyName: '聚猩智媒',
    sourceChannel: 'DOUYIN_DM',
    score: 92,
    tagNames: ['剧情向', '短剧经验', '口播能力强'],
    accounts: [
      { platform: 'DOUYIN' as const, nickname: '林小满的日常', platformUid: 'douyin_linxm_001', followerCount: 1_860_000, avgPlayCount: 420_000, engagementRateBp: 680 },
      { platform: 'XIAOHONGSHU' as const, nickname: '小满同学', platformUid: 'xhs_linxm_001', followerCount: 320_000, avgPlayCount: 86_000, engagementRateBp: 940 },
    ],
  },
  {
    code: 'CR-2026-000002',
    name: '阿泽不加班',
    realName: '陈泽',
    phone: '13800002222',
    city: '成都',
    status: 'ACTIVE' as const,
    tier: 'A' as const,
    verticals: ['TECH', 'KNOWLEDGE'] as const,
    styleTags: ['理性测评', '数据流'],
    agencyType: 'COMMERCIAL',
    sourceChannel: 'REFERRAL',
    score: 85,
    tagNames: ['数码', '口播能力强'],
    accounts: [
      { platform: 'BILIBILI' as const, nickname: '阿泽不加班', platformUid: 'bili_aze_001', followerCount: 680_000, avgPlayCount: 150_000, engagementRateBp: 720 },
      { platform: 'DOUYIN' as const, nickname: '阿泽测评', platformUid: 'douyin_aze_001', followerCount: 410_000, avgPlayCount: 120_000, engagementRateBp: 560 },
    ],
  },
  {
    code: 'CR-2026-000003',
    name: '甜栗子',
    realName: '栗子涵',
    phone: '13800003333',
    city: '上海',
    status: 'SIGNED' as const,
    tier: 'A' as const,
    verticals: ['BEAUTY', 'FASHION'] as const,
    styleTags: ['种草', '干货'],
    agencyType: 'INDEPENDENT',
    sourceChannel: 'OFFLINE',
    score: 78,
    tagNames: ['美妆', '档期紧张'],
    accounts: [
      { platform: 'XIAOHONGSHU' as const, nickname: '甜栗子', platformUid: 'xhs_tanglz_001', followerCount: 520_000, avgPlayCount: 130_000, engagementRateBp: 1180 },
    ],
  },
  {
    code: 'CR-2026-000004',
    name: '大力妈妈',
    realName: '周丽',
    phone: '13800004444',
    city: '武汉',
    status: 'EVALUATING' as const,
    tier: 'B' as const,
    verticals: ['LIFESTYLE'] as const,
    styleTags: ['母婴', '亲子'],
    agencyType: 'INDEPENDENT',
    sourceChannel: 'DOUYIN_DM',
    score: 66,
    tagNames: ['母婴'],
    accounts: [
      { platform: 'DOUYIN' as const, nickname: '大力妈妈育儿记', platformUid: 'douyin_dali_001', followerCount: 96_000, avgPlayCount: 24_000, engagementRateBp: 860 },
    ],
  },
  {
    code: 'CR-2026-000005',
    name: '老饭骨小厨房',
    realName: '刘建国',
    phone: '13800005555',
    city: '西安',
    status: 'CONTACTING' as const,
    tier: 'C' as const,
    verticals: ['FOOD'] as const,
    styleTags: ['家常菜', '烟火气'],
    agencyType: 'INDEPENDENT',
    sourceChannel: 'SCHOOL',
    score: 58,
    tagNames: ['食品饮料'],
    accounts: [
      { platform: 'DOUYIN' as const, nickname: '老饭骨小厨房', platformUid: 'douyin_fangu_001', followerCount: 38_000, avgPlayCount: 9_000, engagementRateBp: 1040 },
    ],
  },
  {
    code: 'CR-2026-000006',
    name: 'Mia在东京',
    realName: '王美雅',
    phone: '13800006666',
    city: '东京',
    status: 'LEAD' as const,
    tier: 'B' as const,
    verticals: ['LIFESTYLE', 'FASHION'] as const,
    styleTags: ['海外', '双语'],
    agencyType: 'INDEPENDENT',
    sourceChannel: 'TIKTOK_DISCOVERY',
    score: 72,
    tagNames: ['海外内容'],
    accounts: [
      { platform: 'TIKTOK' as const, nickname: 'Mia in Tokyo', platformUid: 'tiktok_mia_001', followerCount: 240_000, avgPlayCount: 68_000, engagementRateBp: 590 },
      { platform: 'YOUTUBE' as const, nickname: 'Mia Tokyo Life', platformUid: 'yt_mia_001', followerCount: 74_000, avgPlayCount: 18_000, engagementRateBp: 410 },
    ],
  },
  {
    code: 'CR-2026-000007',
    name: '铁馆老张',
    realName: '张铁',
    phone: '13800007777',
    city: '北京',
    status: 'PAUSED' as const,
    tier: 'C' as const,
    verticals: ['FITNESS'] as const,
    styleTags: ['硬核健身'],
    agencyType: 'COMMERCIAL',
    sourceChannel: 'REFERRAL',
    score: 61,
    riskLevel: 'MEDIUM',
    tagNames: ['历史延期'],
    accounts: [
      { platform: 'DOUYIN' as const, nickname: '铁馆老张', platformUid: 'douyin_laozhang_001', followerCount: 156_000, avgPlayCount: 41_000, engagementRateBp: 470 },
    ],
  },
  {
    code: 'CR-2026-000008',
    name: '甜甜圈剧场',
    realName: '何甜',
    phone: '13800008888',
    city: '广州',
    status: 'ACTIVE' as const,
    tier: 'S' as const,
    verticals: ['SHORT_DRAMA'] as const,
    styleTags: ['都市情感', '高完播'],
    agencyType: 'FULL_MCN',
    agencyName: '聚猩智媒',
    sourceChannel: 'DOUYIN_DM',
    score: 95,
    tagNames: ['剧情向', '短剧经验'],
    accounts: [
      { platform: 'DOUYIN' as const, nickname: '甜甜圈剧场', platformUid: 'douyin_tiantian_001', followerCount: 3_420_000, avgPlayCount: 880_000, engagementRateBp: 750 },
      { platform: 'WECHAT_CHANNEL' as const, nickname: '甜甜圈短剧', platformUid: 'wx_tiantian_001', followerCount: 640_000, avgPlayCount: 190_000, engagementRateBp: 620 },
    ],
  },
  {
    code: 'CR-2026-000009',
    name: '废话少说老王',
    realName: '王强',
    phone: '13800009999',
    city: '深圳',
    status: 'BLACKLIST' as const,
    tier: 'D' as const,
    verticals: ['OTHER'] as const,
    styleTags: ['口播'],
    agencyType: 'INDEPENDENT',
    sourceChannel: 'OFFLINE',
    score: 32,
    riskLevel: 'HIGH',
    tagNames: [],
    accounts: [],
  },
  {
    code: 'CR-2026-000010',
    name: '椰子研究所',
    realName: '黄子豪',
    phone: '13800001010',
    city: '厦门',
    status: 'TERMINATED' as const,
    tier: 'B' as const,
    verticals: ['BEAUTY'] as const,
    styleTags: ['成分党'],
    agencyType: 'COMMERCIAL',
    sourceChannel: 'REFERRAL',
    score: 70,
    riskLevel: 'MEDIUM',
    tagNames: ['美妆'],
    accounts: [
      { platform: 'XIAOHONGSHU' as const, nickname: '椰子研究所', platformUid: 'xhs_yezi_001', followerCount: 210_000, avgPlayCount: 52_000, engagementRateBp: 890 },
    ],
  },
];

const BRANDS = [
  { name: '花漾实验室', industry: '美妆个护', contactName: '林经理', contactPhone: '13900001111', level: 'A', paymentTermDays: 30 },
  { name: '鲜沐食品', industry: '食品饮料', contactName: '赵总', contactPhone: '13900002222', level: 'B', paymentTermDays: 45 },
  { name: '北极星数码', industry: '3C 数码', contactName: '孙主管', contactPhone: '13900003333', level: 'A', paymentTermDays: 30 },
  { name: '小鹿妈妈', industry: '母婴', contactName: '周经理', contactPhone: '13900004444', level: 'B', paymentTermDays: 60 },
  { name: '云海文旅', industry: '文旅', contactName: '吴总监', contactPhone: '13900005555', level: 'C', paymentTermDays: 45 },
];

async function main(): Promise<void> {
  console.log('开始写入演示数据…');

  // ---------------- 团队 ----------------
  const teamMap = new Map<string, string>();
  for (const team of TEAMS) {
    const record = await prisma.team.upsert({
      where: { code: team.code },
      update: { name: team.name },
      create: team,
      select: { id: true },
    });
    teamMap.set(team.code, record.id);
  }
  console.log(`  团队 ${TEAMS.length} 个`);

  // ---------------- 员工 ----------------
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const userMap = new Map<string, string>();
  for (const user of USERS) {
    const record = await prisma.user.upsert({
      where: { email: user.email },
      update: { name: user.name, role: user.role, teamId: teamMap.get(user.teamCode) ?? null },
      create: {
        email: user.email,
        name: user.name,
        role: user.role,
        passwordHash,
        teamId: teamMap.get(user.teamCode) ?? null,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    userMap.set(user.email, record.id);
  }
  console.log(`  员工 ${USERS.length} 人（统一演示密码：${DEMO_PASSWORD}）`);

  // ---------------- 标签 ----------------
  const tagMap = new Map<string, string>();
  for (const tag of TAGS) {
    const record = await prisma.tag.upsert({
      where: { name: tag.name },
      update: { category: tag.category, color: tag.color },
      create: tag,
      select: { id: true },
    });
    tagMap.set(tag.name, record.id);
  }
  console.log(`  标签 ${TAGS.length} 个`);

  // ---------------- 品牌 ----------------
  const brandMap = new Map<string, string>();
  for (const brand of BRANDS) {
    const existing = await prisma.brand.findFirst({ where: { name: brand.name, deletedAt: null } });
    const record =
      existing ??
      (await prisma.brand.create({
        data: { ...brand, invoiceTitle: brand.name, taxNo: `91330100MA2${Math.floor(Math.random() * 1e6)}` },
      }));
    brandMap.set(brand.name, record.id);
  }
  console.log(`  品牌 ${BRANDS.length} 个`);

  // ---------------- 达人 + 平台账号 + 数据快照 ----------------
  const ownerRotation = [
    userMap.get('ops@juxingzhimei.com')!,
    userMap.get('ops2@juxingzhimei.com')!,
    userMap.get('bd@juxingzhimei.com')!,
    userMap.get('bd2@juxingzhimei.com')!,
  ];
  const creatorMap = new Map<string, { id: string; name: string }>();

  for (const [index, seed] of CREATORS.entries()) {
    const ownerId = ownerRotation[index % ownerRotation.length]!;
    const teamId = index % 3 === 0 ? teamMap.get('BD')! : teamMap.get('OPS')!;

    const creator = await prisma.creator.upsert({
      where: { code: seed.code },
      update: { status: seed.status, tier: seed.tier, score: seed.score, ownerId, teamId },
      create: {
        code: seed.code,
        name: seed.name,
        realName: seed.realName,
        phone: seed.phone,
        wechat: 'wechat_' + seed.code.slice(-3),
        email: `${seed.code.toLowerCase()}@creator.demo`,
        city: seed.city,
        status: seed.status,
        tier: seed.tier,
        verticals: [...seed.verticals],
        styleTags: seed.styleTags,
        agencyType: seed.agencyType,
        agencyName: 'agencyName' in seed ? (seed.agencyName as string) : null,
        sourceChannel: seed.sourceChannel,
        score: seed.score,
        riskLevel: 'riskLevel' in seed ? (seed.riskLevel as string) : 'LOW',
        ownerId,
        teamId,
        createdById: userMap.get('admin@juxingzhimei.com')!,
        signedAt: ['SIGNED', 'ACTIVE', 'PAUSED', 'TERMINATED'].includes(seed.status)
          ? new Date(Date.UTC(2026, 0, 15))
          : null,
        remark: '演示数据：由 seed 脚本生成',
      },
      select: { id: true, name: true },
    });
    creatorMap.set(seed.code, creator);

    // 标签关联
    for (const tagName of seed.tagNames) {
      const tagId = tagMap.get(tagName);
      if (!tagId) continue;
      await prisma.creatorTag
        .create({ data: { creatorId: creator.id, tagId } })
        .catch(() => undefined);
    }

    // 平台账号 + 近 14 天数据快照
    for (const [accountIndex, account] of seed.accounts.entries()) {
      const platformAccount = await prisma.platformAccount.upsert({
        where: { platform_platformUid: { platform: account.platform, platformUid: account.platformUid } },
        update: { followerCount: account.followerCount, nickname: account.nickname },
        create: {
          creatorId: creator.id,
          platform: account.platform,
          nickname: account.nickname,
          platformUid: account.platformUid,
          profileUrl: `https://example.com/${account.platformUid}`,
          followerCount: account.followerCount,
          totalLikes: BigInt(account.followerCount * 12),
          totalWorks: 120 + accountIndex * 30,
          avgPlayCount: account.avgPlayCount,
          engagementRateBp: account.engagementRateBp,
          dataSource: SEED_DATA_SOURCE,
          lastSyncedAt: new Date(),
          isPrimary: accountIndex === 0,
        },
        select: { id: true },
      });

      // 快照：以 followerCount 为基准做小幅波动，保证趋势图有形态且可复算
      for (let dayOffset = 13; dayOffset >= 0; dayOffset -= 1) {
        const statDate = new Date();
        statDate.setUTCHours(0, 0, 0, 0);
        statDate.setUTCDate(statDate.getUTCDate() - dayOffset);
        const wave = Math.sin((dayOffset + index) / 3) * 0.02;
        const followerCount = Math.round(account.followerCount * (1 + wave));
        const dailyRevenueCents = BigInt(
          Math.max(0, Math.round((account.avgPlayCount * account.engagementRateBp * (1 + wave)) / 900)),
        );

        await prisma.metricsSnapshot.upsert({
          where: { accountId_statDate: { accountId: platformAccount.id, statDate } },
          update: { followerCount, revenueCents: dailyRevenueCents },
          create: {
            accountId: platformAccount.id,
            statDate,
            capturedAt: statDate,
            followerCount,
            followerDelta: Math.round(followerCount * 0.004),
            playCount: BigInt(Math.round(account.avgPlayCount * (1 + wave))),
            likeCount: BigInt(Math.round(account.avgPlayCount * 0.06)),
            commentCount: BigInt(Math.round(account.avgPlayCount * 0.004)),
            shareCount: BigInt(Math.round(account.avgPlayCount * 0.002)),
            collectCount: BigInt(Math.round(account.avgPlayCount * 0.003)),
            engagementRateBp: account.engagementRateBp,
            revenueCents: dailyRevenueCents,
            dataSource: SEED_DATA_SOURCE,
          },
        });
      }
    }
  }
  console.log(`  达人 ${CREATORS.length} 位（含平台账号与近 14 天数据快照）`);

  // ---------------- 合同 ----------------
  // 只给「已签约/合作中/暂停/已解约」的达人建合同，保证与达人状态一致
  const contractSeeds: Array<{
    creatorCode: string;
    title: string;
    brandName: string | null;
    settlementMode: 'REVENUE_SHARE' | 'FIXED_FEE' | 'HYBRID' | 'CPA';
    fixedFee: string;
    platformFeeBp: number;
    agencyShareBp: number;
    talentShareBp: number;
    taxWithholdBp: number;
    status: 'ACTIVE' | 'PENDING_REVIEW' | 'DRAFT' | 'TERMINATED';
    effectiveFrom: Date;
    effectiveTo: Date;
    exclusivity: boolean;
    tieredShares?: Array<{ from: number; to: number | null; talentShareBp: number }>;
  }> = [
    {
      creatorCode: 'CR-2026-000001',
      title: '林小满 × 花漾实验室 年度内容分成合作',
      brandName: '花漾实验室',
      settlementMode: 'REVENUE_SHARE',
      fixedFee: '0.00',
      platformFeeBp: 1000,
      agencyShareBp: 3000,
      talentShareBp: 7000,
      taxWithholdBp: 600,
      status: 'ACTIVE',
      effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
      effectiveTo: new Date(Date.UTC(2026, 11, 31)),
      exclusivity: true,
      // 阶梯：月流水超过 5 万元的部分达人分成提高到 75%
      tieredShares: [{ from: 5_000_000, to: null, talentShareBp: 7500 }],
    },
    {
      creatorCode: 'CR-2026-000002',
      title: '阿泽不加班 × 北极星数码 新品测评合作',
      brandName: '北极星数码',
      settlementMode: 'HYBRID',
      fixedFee: '30000.00',
      platformFeeBp: 800,
      agencyShareBp: 2500,
      talentShareBp: 7500,
      taxWithholdBp: 600,
      status: 'ACTIVE',
      effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
      effectiveTo: new Date(Date.UTC(2026, 5, 30)),
      exclusivity: false,
    },
    {
      creatorCode: 'CR-2026-000003',
      title: '甜栗子 × 花漾实验室 种草内容一口价',
      brandName: '花漾实验室',
      settlementMode: 'FIXED_FEE',
      fixedFee: '18000.00',
      platformFeeBp: 0,
      agencyShareBp: 3000,
      talentShareBp: 7000,
      taxWithholdBp: 600,
      status: 'ACTIVE',
      effectiveFrom: new Date(Date.UTC(2026, 1, 1)),
      effectiveTo: new Date(Date.UTC(2026, 7, 31)),
      exclusivity: false,
    },
    {
      creatorCode: 'CR-2026-000008',
      title: '甜甜圈剧场 × 云海文旅 短剧定制合作',
      brandName: '云海文旅',
      settlementMode: 'REVENUE_SHARE',
      fixedFee: '0.00',
      platformFeeBp: 1200,
      agencyShareBp: 3500,
      talentShareBp: 6500,
      taxWithholdBp: 600,
      status: 'ACTIVE',
      effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
      effectiveTo: new Date(Date.UTC(2026, 11, 31)),
      exclusivity: true,
    },
    {
      creatorCode: 'CR-2026-000007',
      title: '铁馆老张 × 鲜沐食品 效果付费合作',
      brandName: '鲜沐食品',
      settlementMode: 'CPA',
      fixedFee: '0.00',
      platformFeeBp: 1000,
      agencyShareBp: 4000,
      talentShareBp: 6000,
      taxWithholdBp: 600,
      status: 'ACTIVE',
      effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
      effectiveTo: new Date(Date.UTC(2026, 4, 31)),
      exclusivity: false,
    },
    {
      creatorCode: 'CR-2026-000010',
      title: '椰子研究所 × 小鹿妈妈 内容合作（已终止）',
      brandName: '小鹿妈妈',
      settlementMode: 'REVENUE_SHARE',
      fixedFee: '0.00',
      platformFeeBp: 1000,
      agencyShareBp: 3000,
      talentShareBp: 7000,
      taxWithholdBp: 600,
      status: 'TERMINATED',
      effectiveFrom: new Date(Date.UTC(2025, 6, 1)),
      effectiveTo: new Date(Date.UTC(2025, 11, 31)),
      exclusivity: false,
    },
  ];

  const contractMap = new Map<string, { id: string; code: string; seed: (typeof contractSeeds)[number] }>();
  let contractSeq = 0;
  for (const seed of contractSeeds) {
    const creator = creatorMap.get(seed.creatorCode);
    if (!creator) continue;
    contractSeq += 1;
    const code = `CT-2026-${String(contractSeq).padStart(6, '0')}`;

    const existing = await prisma.contract.findFirst({ where: { code } });
    const contract =
      existing ??
      (await prisma.contract.create({
        data: {
          code,
          title: seed.title,
          creatorId: creator.id,
          brandId: seed.brandName ? (brandMap.get(seed.brandName) ?? null) : null,
          status: seed.status,
          settlementMode: seed.settlementMode,
          currency: 'CNY',
          fixedFee: seed.fixedFee,
          platformFeeBp: seed.platformFeeBp,
          agencyShareBp: seed.agencyShareBp,
          talentShareBp: seed.talentShareBp,
          taxWithholdBp: seed.taxWithholdBp,
          cpaUnitPrice: seed.settlementMode === 'CPA' ? '2.50' : '0.00',
          tieredShares: (seed.tieredShares ?? undefined) as Prisma.InputJsonValue | undefined,
          effectiveFrom: seed.effectiveFrom,
          effectiveTo: seed.effectiveTo,
          exclusivity: seed.exclusivity,
          exclusivityScope: seed.exclusivity ? '同品类竞品' : null,
          signedAt: seed.status === 'ACTIVE' ? seed.effectiveFrom : null,
          deliverableSpec: { videosPerMonth: 4, platforms: ['DOUYIN', 'XIAOHONGSHU'] } as Prisma.InputJsonValue,
          breachClause: '任一方违约需提前 30 天书面通知，违约方承担守约方直接损失。',
          reviewNote: seed.status === 'ACTIVE' ? '审核通过（演示数据）' : null,
          reviewedById: seed.status === 'ACTIVE' ? userMap.get('admin@juxingzhimei.com')! : null,
          reviewedAt: seed.status === 'ACTIVE' ? seed.effectiveFrom : null,
          createdById: userMap.get('bd@juxingzhimei.com')!,
        },
        select: { id: true, code: true },
      }));
    contractMap.set(seed.creatorCode, { id: contract.id, code: contract.code, seed });
  }
  console.log(`  合同 ${contractMap.size} 份`);

  // ---------------- 项目 + 内容 ----------------
  const contentTitles = [
    '三分钟看懂：为什么你的视频完播率上不去',
    '被低估的国货粉底液，实测持妆 12 小时',
    '新人必看：内容选题的 5 个低成本方法',
    '这个细节决定了你的种草视频能不能爆',
    '连续 30 天更新后，我总结出 3 条铁律',
    '测评：这款新品的真实表现到底如何',
    '从头到尾复盘一条 500 万播放的视频',
    '短剧开场 3 秒，我是这样设计钩子的',
  ];

  let projectSeq = 0;
  let contentSeq = 0;
  const projectMap = new Map<string, string>();

  for (const [creatorCode, contract] of contractMap) {
    if (contract.seed.status !== 'ACTIVE') continue;
    const creator = creatorMap.get(creatorCode)!;
    projectSeq += 1;
    const projectCode = `PJ-2026-${String(projectSeq).padStart(6, '0')}`;
    const existingProject = await prisma.project.findFirst({ where: { code: projectCode } });
    const project =
      existingProject ??
      (await prisma.project.create({
        data: {
          code: projectCode,
          name: `${creator.name} ${new Date().getUTCFullYear()} 年 Q1 内容交付`,
          brandId: contract.seed.brandName ? (brandMap.get(contract.seed.brandName) ?? null) : null,
          contractId: contract.id,
          creatorId: creator.id,
          status: 'IN_PRODUCTION',
          vertical: creatorCode === 'CR-2026-000008' ? 'SHORT_DRAMA' : 'LIFESTYLE',
          budget: '80000.00',
          actualCost: '26000.00',
          ownerId: userMap.get('ops@juxingzhimei.com')!,
          teamId: teamMap.get('OPS')!,
          startDate: new Date(Date.UTC(2026, 0, 5)),
          dueDate: new Date(Date.UTC(2026, 2, 31)),
          brief: '围绕品牌核心卖点产出 4 条内容，重点提升完播率与互动率；每条内容需在发布后 24 小时内同步数据。',
        },
        select: { id: true },
      }));
    projectMap.set(projectCode, project.id);

    // 每个项目 3 条内容：已发布 2 条 + 制作中 1 条
    const statuses: Array<'PUBLISHED' | 'PUBLISHED' | 'EDITING'> = ['PUBLISHED', 'PUBLISHED', 'EDITING'];
    for (const [index, status] of statuses.entries()) {
      contentSeq += 1;
      const title = contentTitles[(contentSeq - 1) % contentTitles.length]!;
      const publishedAt =
        status === 'PUBLISHED'
          ? new Date(Date.UTC(2026, 0, 6 + index * 7, 10, 30))
          : null;

      const viewCount = status === 'PUBLISHED' ? 120_000 + contentSeq * 37_000 : 0;
      // 内容收入：按播放量粗略换算，保证结算时有真实金额可算
      const revenueCents = status === 'PUBLISHED' ? BigInt(viewCount * 12) : 0n;

      // 幂等：同一项目 + 同一达人 + 同一标题视为同一条内容。
      // 早期实现直接 create，导致 seed 重跑会凭空多出一批内容，
      // 而文档却声称脚本幂等 —— 这种不一致会让「重跑一次修复问题」变成制造新问题。
      const existingContent = await prisma.content.findFirst({
        where: { projectId: project.id, creatorId: creator.id, title },
        select: { id: true, title: true, revenueCents: true, conversions: true, publishedAt: true },
      });

      const content =
        existingContent ??
        (await prisma.content.create({
          data: {
            projectId: project.id,
            creatorId: creator.id,
            title,
            script: '【演示脚本】开场钩子 → 冲突 → 转折 → 引导互动，详见 AI 工作台生成的完整分镜。',
            platform: index % 2 === 0 ? 'DOUYIN' : 'XIAOHONGSHU',
            status,
            durationSec: 45 + index * 15,
            publishedAt,
            scheduledAt: publishedAt ?? new Date(Date.UTC(2026, 1, 20)),
            viewCount: BigInt(viewCount),
            likeCount: BigInt(Math.round(viewCount * 0.06)),
            commentCount: BigInt(Math.round(viewCount * 0.004)),
            shareCount: BigInt(Math.round(viewCount * 0.002)),
            collectCount: BigInt(Math.round(viewCount * 0.003)),
            completionRateBp: 3200 + index * 400,
            revenueCents,
            conversions: status === 'PUBLISHED' ? 40 + contentSeq * 6 : 0,
            publishedUrl: publishedAt ? `https://example.com/video/${contentSeq}` : null,
            complianceScore: status === 'PUBLISHED' ? 82 : null,
            complianceFlags:
              status === 'PUBLISHED'
                ? ([
                    {
                      level: 'INFO',
                      category: '素材授权',
                      snippet: '背景音乐',
                      reason: '需确认 BGM 商用授权',
                      suggestion: '使用平台商用曲库',
                    },
                  ] as Prisma.InputJsonValue)
                : undefined,
            metricsSyncedAt: publishedAt ? new Date() : null,
          },
          select: { id: true, title: true, revenueCents: true, conversions: true, publishedAt: true },
        }));

      // ---------------- 结算明细（用与生产完全相同的引擎） ----------------
      if (status === 'PUBLISHED' && revenueCents > 0n) {
        const rule: SettlementRule = {
          settlementMode: contract.seed.settlementMode,
          fixedFeeCents: Math.round(Number.parseFloat(contract.seed.fixedFee) * 100),
          platformFeeBp: contract.seed.platformFeeBp,
          agencyShareBp: contract.seed.agencyShareBp,
          talentShareBp: contract.seed.talentShareBp,
          taxWithholdBp: contract.seed.taxWithholdBp,
          tieredShares: contract.seed.tieredShares ?? null,
          cpaUnitPriceCents: 250,
        };
        const breakdown = calculateSettlement({
          rule,
          grossCents: Number(content.revenueCents),
          conversions: content.conversions,
          description: content.title,
        });

        const periodStart = new Date(Date.UTC(2026, 0, 1));
        const periodEnd = new Date(Date.UTC(2026, 0, 31, 23, 59, 59, 999));

        // 结算单：同一达人同账期唯一，先查后建
        let settlement = await prisma.settlement.findFirst({
          where: { creatorId: creator.id, periodStart, periodEnd },
          select: { id: true },
        });
        if (!settlement) {
          const settlementCode = `ST-2026-${String(
            (await prisma.settlement.count()) + 1,
          ).padStart(6, '0')}`;
          settlement = await prisma.settlement.create({
            data: {
              code: settlementCode,
              creatorId: creator.id,
              periodStart,
              periodEnd,
              status: 'DRAFT',
              currency: 'CNY',
              dueDate: new Date(Date.UTC(2026, 1, 28)),
              calculationTrace: {
                seeded: true,
                note: '演示数据：由 seed 脚本使用生产同款结算引擎计算',
              } as Prisma.InputJsonValue,
              createdById: userMap.get('finance@juxingzhimei.com')!,
            },
            select: { id: true },
          });
        }

        await prisma.settlementItem
          .create({
            data: {
              settlementId: settlement.id,
              creatorId: creator.id,
              contractId: contract.id,
              contentId: content.id,
              itemType: 'REVENUE',
              description: `${content.title} 分成`,
              grossAmount: centsToDecimalString(breakdown.grossCents),
              platformFeeBp: breakdown.effective.platformFeeBp,
              platformFee: centsToDecimalString(breakdown.platformFeeCents),
              agencyShareBp: breakdown.effective.agencyShareBp,
              agencyShare: centsToDecimalString(breakdown.agencyShareCents),
              talentShareBp: breakdown.effective.talentShareBp,
              talentGross: centsToDecimalString(breakdown.talentGrossCents),
              taxWithholdBp: breakdown.effective.taxWithholdBp,
              taxWithheld: centsToDecimalString(breakdown.taxWithheldCents),
              netPayable: centsToDecimalString(breakdown.netPayableCents),
              idempotencyKey: `SEED:${creator.id}:${contract.id}:${content.id}`,
            },
          })
          .catch(() => undefined);
      }
    }
  }

  // 汇总结算单头部金额（必须等于明细汇总，否则财务对不上账）
  const settlements = await prisma.settlement.findMany({
    where: { deletedAt: null, periodStart: new Date(Date.UTC(2026, 0, 1)) },
    include: { items: true },
  });
  for (const settlement of settlements) {
    const totals = settlement.items.reduce(
      (
        acc: {
          gross: number;
          platformFee: number;
          agencyShare: number;
          talentGross: number;
          taxWithheld: number;
          netPayable: number;
        },
        item: (typeof settlement.items)[number],
      ) => ({
        gross: acc.gross + Number(item.grossAmount),
        platformFee: acc.platformFee + Number(item.platformFee),
        agencyShare: acc.agencyShare + Number(item.agencyShare),
        talentGross: acc.talentGross + Number(item.talentGross),
        taxWithheld: acc.taxWithheld + Number(item.taxWithheld),
        netPayable: acc.netPayable + Number(item.netPayable),
      }),
      { gross: 0, platformFee: 0, agencyShare: 0, talentGross: 0, taxWithheld: 0, netPayable: 0 },
    );
    await prisma.settlement.update({
      where: { id: settlement.id },
      data: {
        grossAmount: totals.gross.toFixed(2),
        platformFee: totals.platformFee.toFixed(2),
        agencyShare: totals.agencyShare.toFixed(2),
        talentGross: totals.talentGross.toFixed(2),
        taxWithheld: totals.taxWithheld.toFixed(2),
        netPayable: totals.netPayable.toFixed(2),
      },
    });
  }
  console.log(`  项目 ${projectMap.size} 个、内容 ${contentSeq} 条、结算单 ${settlements.length} 张`);

  // ---------------- 通知 ----------------
  const opsUser = userMap.get('ops@juxingzhimei.com')!;
  await prisma.notification
    .create({
      data: {
        userId: opsUser,
        type: 'SYSTEM',
        title: '欢迎使用 CreatorOps',
        content: '演示数据已就绪。建议先看「经营看板」，再从「达人库」体验状态流转与结算预估。',
        link: '/dashboard',
        dedupeKey: 'seed:welcome',
      },
    })
    .catch(() => undefined);

  // ---------------- 编号序列对齐 ----------------
  // 让 CodeGeneratorService 后续生成的编号不与种子数据冲突（否则会撞唯一索引）
  for (const [prefix, maxCode] of [
    ['CR', 'CR-2026-000010'],
    ['CT', `CT-2026-${String(contractSeq).padStart(6, '0')}`],
    ['PJ', `PJ-2026-${String(projectSeq).padStart(6, '0')}`],
    ['ST', `ST-2026-${String(settlements.length).padStart(6, '0')}`],
  ] as const) {
    const value = Number.parseInt(maxCode.slice(-6), 10);
    const scope = `${prefix}-2026`;
    await prisma.$executeRaw`
      INSERT INTO code_sequences (scope, value, updated_at)
      VALUES (${scope}, ${value}, NOW())
      ON CONFLICT (scope) DO UPDATE SET value = GREATEST(code_sequences.value, ${value}), updated_at = NOW()
    `;
  }

  console.log('\n演示数据写入完成。');
  console.log('可用账号（密码统一为 ' + DEMO_PASSWORD + '）：');
  for (const user of USERS) {
    console.log(`  ${user.role.padEnd(12)} ${user.email.padEnd(32)} ${user.name}`);
  }
  console.log('\n提示：运营账号 ops@juxingzhimei.com 拥有大部分业务权限；');
  console.log('      审计账号 audit@juxingzhimei.com 为只读，可用于演示权限拦截。');
}

main()
  .catch((error: unknown) => {
    console.error('演示数据写入失败：', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
