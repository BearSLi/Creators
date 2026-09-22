/**
 * 数据库状态诊断
 * ----------------------------------------------------------------------------
 * 用途：在「应用启动报表不存在」这类问题上，一次性看清三件事：
 *   1) 迁移文件在磁盘上都有哪些（Prisma 只会应用 migrations 目录里的迁移）；
 *   2) 数据库里 Prisma 认为哪些迁移「已应用」（_prisma_migrations 表）；
 *   3) 数据库里到底有哪些表、缺哪些表（对照 schema.prisma 的 @@map 名称）。
 *
 * 用法：
 *   pnpm db:doctor
 *   node scripts/db-doctor.mjs
 *
 * 说明：本脚本用 Prisma 的查询引擎（已在 prisma generate 时下载完成），
 * 因此不需要再派生 psql 进程。
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = join(repoRoot, 'apps', 'api');
const migrationsDir = join(apiRoot, 'prisma', 'migrations');
const schemaPath = join(apiRoot, 'prisma', 'schema.prisma');

/**
 * 自行加载仓库根目录的 .env。
 *
 * 为什么不让命令走 scripts/with-env.mjs：那样需要派生子进程，而部分受限环境
 * 会直接拒绝（EPERM），连诊断工具都跑不起来——最需要诊断的时候恰恰是这种环境。
 * 本脚本因此做成「零子进程、自带 env 加载」，任何地方都能直接 `node` 执行。
 * 已存在的环境变量优先，便于临时指向别的库。
 */
function loadRootEnv() {
  const envPath = join(repoRoot, '.env');
  if (!existsSync(envPath)) return null;
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return envPath;
}

const loadedFrom = loadRootEnv();
if (!process.env.DATABASE_URL) {
  console.error('未找到 DATABASE_URL。请确认仓库根目录存在 .env（可从 .env.example 复制）。');
  process.exit(1);
}

/**
 * 从 apps/api 解析 @prisma/client。
 *
 * 本脚本放在仓库根目录的 scripts/ 下，而 pnpm 不会把 app 的依赖提升到根
 * node_modules，因此直接 `import '@prisma/client'` 会报 ERR_MODULE_NOT_FOUND。
 * 用 createRequire 以 apps/api 的 package.json 为基准解析，才能拿到同一个客户端实例。
 */
const requireFromApi = createRequire(join(apiRoot, 'package.json'));
const { PrismaClient } = requireFromApi('@prisma/client');

// --- 从 schema.prisma 抽出所有 @@map 的表名（即数据库里应有的表） ---
function expectedTablesFromSchema() {
  if (!existsSync(schemaPath)) return [];
  const schema = readFileSync(schemaPath, 'utf8');
  return [...schema.matchAll(/@@map\("([^"]+)"\)/g)].map((match) => match[1]).sort();
}

// --- 磁盘上的迁移 ---
function migrationsOnDisk() {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir)
    .filter((name) => {
      const full = join(migrationsDir, name);
      try {
        return existsSync(join(full, 'migration.sql'));
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * 不由 schema.prisma 管理、但代码运行必须存在的基础设施表。
 *
 * 为什么单独列出：db-doctor 原先只对照 schema.prisma 的 @@map 表名，
 * 于是当 code_sequences 缺失时仍然报「业务表齐全」，给出错误的安全感
 * （实际后果是 seed 跑到最后一步才失败：`关系 "code_sequences" 不存在`）。
 * 这类「schema 之外、但代码依赖」的表必须显式登记，否则诊断工具本身会骗人。
 */
const INFRA_TABLES = [
  {
    name: 'code_sequences',
    reason: 'CodeGeneratorService 用它分配业务编号（CR-2026-000001 等）',
    migration: '20260102000000_add_code_sequences',
  },
];

const expected = expectedTablesFromSchema();
const onDisk = migrationsOnDisk();

console.log('=== CreatorOps 数据库状态诊断 ===\n');

// 1) 迁移文件
console.log(`[1] 磁盘上的迁移（${migrationsDir.replace(repoRoot + '\\', '')}）`);
if (onDisk.length === 0) {
  console.log('    (空) !! 没有迁移文件，prisma migrate deploy 不会创建任何表');
} else {
  for (const name of onDisk) {
    const file = join(migrationsDir, name, 'migration.sql');
    const content = readFileSync(file, 'utf8');
    const tables = [...content.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?(\w+)"?/g)].map((m) => m[1]);
    const bytes = Buffer.byteLength(content, 'utf8');
    console.log(`    ${name}  (${bytes} 字节, 创建 ${tables.length} 张表)`);
    if (tables.length > 0) console.log(`        建表: ${tables.join(', ')}`);
  }
}

// 2) 数据库连接
const prisma = new PrismaClient();
let appliedMigrations = [];
let migrationRecords = [];
let actualTables = [];

try {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT migration_name, finished_at, rolled_back_at, applied_steps_count, logs FROM _prisma_migrations ORDER BY started_at',
  );
  migrationRecords = rows;
  // 只有 finished_at 非空才算「成功应用」；这正是失败迁移容易被误判的地方
  appliedMigrations = rows.filter((row) => row.finished_at).map((row) => row.migration_name);
} catch (error) {
  console.log('\n[2] _prisma_migrations 表读取失败（可能还没执行过任何迁移）');
  console.log(`    ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
}

try {
  const rows = await prisma.$queryRawUnsafe(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  actualTables = rows.map((row) => row.tablename);
} catch (error) {
  console.error('\n无法连接数据库或查询表列表：');
  console.error(error instanceof Error ? error.message : String(error));
  await prisma.$disconnect();
  process.exit(1);
}

console.log(`\n[2] 数据库中的迁移记录（_prisma_migrations）`);
if (migrationRecords.length === 0) {
  console.log('    (空) !! 没有任何迁移被执行过');
} else {
  for (const row of migrationRecords) {
    const state = row.finished_at
      ? '✅ 已成功应用'
      : row.rolled_back_at
        ? '↩️  已回滚'
        : '❌ 失败（未完成）';
    const steps = Number(row.applied_steps_count ?? 0);
    console.log(`    ${row.migration_name.padEnd(24)} ${state}${steps === 0 ? '  [0 步已执行]' : ''}`);
    if (!row.finished_at && row.logs) {
      // 失败原因常常就在 logs 里，直接打出来省去翻 Prisma 文档
      const firstLine = String(row.logs).split('\n').find((line) => line.trim());
      if (firstLine) console.log(`        失败原因: ${firstLine.trim().slice(0, 200)}`);
    }
  }
  const failed = migrationRecords.filter((row) => !row.finished_at && !row.rolled_back_at);
  if (failed.length > 0) {
    console.log(`\n    ⚠️  存在 ${failed.length} 条失败记录。Prisma 会阻止后续迁移，`);
    console.log('       需先把它们标记为已回滚，再重新 deploy。');
  }
}

console.log(`\n[3] 数据库中的表（public schema，共 ${actualTables.length} 张）`);
console.log(`    ${actualTables.join(', ') || '(无)'}`);

const missing = expected.filter((table) => !actualTables.includes(table));
const extra = actualTables.filter((table) => !expected.includes(table) && table !== '_prisma_migrations');
const missingInfra = INFRA_TABLES.filter((table) => !actualTables.includes(table.name));

console.log(`\n[4] 与 schema.prisma 对比（应为 ${expected.length} 张业务表）`);
if (missing.length === 0) {
  console.log('    ✅ 业务表齐全，无缺失');
} else {
  console.log(`    ❌ 缺少 ${missing.length} 张表：${missing.join(', ')}`);
}

console.log(`\n[5] 基础设施表（不在 schema.prisma 中，但代码依赖）`);
if (missingInfra.length === 0) {
  console.log(`    ✅ ${INFRA_TABLES.map((t) => t.name).join(', ')} 均已存在`);
} else {
  for (const table of missingInfra) {
    console.log(`    ❌ 缺少 ${table.name} —— ${table.reason}`);
    console.log(`       由迁移 ${table.migration} 创建，执行 pnpm db:deploy 即可补上`);
  }
}

if (extra.length > 0) {
  console.log(`\n    提示：数据库中存在 schema 未定义的表：${extra.join(', ')}`);
}

// --- 结论与建议 ---
console.log('\n=== 结论 ===');
const hasBaselineOnDisk = onDisk.some((name) => {
  const content = readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');
  return content.includes('CREATE TABLE') && content.includes('creators');
});
const failedRecords = migrationRecords.filter((row) => !row.finished_at && !row.rolled_back_at);

if (missing.length === 0 && missingInfra.length === 0) {
  console.log('数据库结构完整，可以直接 pnpm dev。');
} else if (missingInfra.length > 0 && missing.length === 0) {
  // 业务表齐全但缺基础设施表：这是最容易被忽略的一种半成品状态
  console.log(`业务表齐全，但缺少基础设施表：${missingInfra.map((t) => t.name).join(', ')}。`);
  console.log('代码在需要分配业务编号时会失败（seed 也会在最后一步报错）。\n');
  console.log('请执行：');
  console.log('  pnpm db:deploy');
} else if (failedRecords.length > 0) {
  // 这是最容易误判的一种状态：迁移「有记录」但没跑完，
  // 早期版本把它说成「未被执行」，导致给出无效建议。
  console.log(`有 ${failedRecords.length} 条迁移记录处于「失败」状态（${failedRecords.map((r) => r.migration_name).join(', ')}）。`);
  console.log('Prisma 会拒绝继续应用迁移，需要先标记为已回滚，再重新执行。\n');
  console.log('请执行：');
  for (const record of failedRecords) {
    console.log(`  pnpm exec prisma migrate resolve --rolled-back ${record.migration_name}   （在 apps/api 目录下）`);
  }
  console.log('  pnpm db:deploy');
  console.log('\n若失败原因是 SQL 语法错误（如 BOM 导致的「语法错误 在 "" 或附近的」），');
  console.log('先重新生成干净的基线：pnpm db:baseline --force');
} else if (!hasBaselineOnDisk) {
  console.log('缺少基线迁移（创建业务表的那个迁移）。当前 migrations 目录里');
  console.log('没有任何迁移包含 CREATE TABLE "creators"，因此表建不出来。\n');
  console.log('请执行：');
  console.log('  pnpm db:baseline');
  console.log('  pnpm db:deploy');
} else {
  console.log('磁盘上有基线迁移，但它没有成功应用到数据库。\n');
  console.log('请执行：');
  console.log('  pnpm db:deploy');
  console.log('\n若 deploy 报告「没有待应用的迁移」，说明被误标为已应用，检查：');
  console.log('  pnpm --filter @creatorops/api exec prisma migrate status');
}

await prisma.$disconnect();
