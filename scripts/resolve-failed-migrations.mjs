/**
 * 清除失败的迁移记录
 * ----------------------------------------------------------------------------
 * 为什么需要这个脚本（而不是让你手敲 prisma 命令）：
 *   `prisma migrate resolve --rolled-back <name>` 需要能定位到 schema.prisma。
 *   本项目的环境变量与 schema 都不在仓库根目录：
 *     - .env 在仓库根；
 *     - schema 在 apps/api/prisma/schema.prisma，且 apps/api/package.json 里
 *       没有 `prisma.schema` 键（走的是默认位置约定）。
 *   于是从根目录直接调用 prisma 会报
 *   `Could not find Prisma Schema that is required for this command`。
 *   本脚本统一处理 cwd、--schema 与环境变量，杜绝这类「差一个参数」的失败。
 *
 * 用法：
 *   pnpm db:resolve                       # 自动找出所有失败记录并清除
 *   node scripts/resolve-failed-migrations.mjs 0_init   # 指定迁移名
 *
 * 注意：本命令**只改 _prisma_migrations 的记账**，不执行任何 SQL。
 *       清除后需再执行 pnpm db:deploy 才会真正建表。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = join(repoRoot, 'apps', 'api');
const schemaPath = join(apiRoot, 'prisma', 'schema.prisma');
const requireFromApi = createRequire(join(apiRoot, 'package.json'));

console.log('=== 清除失败的迁移记录 ===\n');

if (!existsSync(schemaPath)) {
  console.error(`找不到 schema：${schemaPath}`);
  process.exit(1);
}

// --- 加载根目录 .env 并注入 process.env ---
//
// 顺序很重要：**必须在解析 @prisma/client 之前完成**。
// ESM 的 import 语句先于模块体代码执行，因此顶层 `const { PrismaClient } = require(...)`
// 会在 process.env 还是空的时候就去初始化客户端，导致
// `Environment variable not found: DATABASE_URL` —— 明明 .env 就在旁边。
// 这里改为「先设环境变量，再用动态 import 解析客户端」，顺序变成显式可控。
const envPath = join(repoRoot, '.env');
if (!existsSync(envPath)) {
  console.error('找不到 .env，请先执行：copy .env.example .env');
  process.exit(1);
}
const fileEnv = {};
for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq <= 0) continue;
  let value = line.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  const key = line.slice(0, eq).trim();
  // 已存在的环境变量优先，便于临时指向别的库
  if (process.env[key] === undefined) process.env[key] = value;
  fileEnv[key] = value;
}
const childEnv = { ...fileEnv, ...process.env };

if (!process.env.DATABASE_URL) {
  console.error('.env 里没有 DATABASE_URL，无法连接数据库。');
  process.exit(1);
}

// --- 定位 prisma CLI：优先 apps/api 的本地安装 ---
const prismaCli = [
  join(apiRoot, 'node_modules', 'prisma', 'build', 'index.js'),
  join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js'),
].find((candidate) => existsSync(candidate));

if (!prismaCli) {
  console.error('找不到 prisma CLI，请先在仓库根执行 pnpm install');
  process.exit(1);
}

/** 失败状态的迁移：已开始（有记录）但未完成，且未标记回滚 */
async function findFailedMigrations() {
  // 动态解析：此时 process.env 已包含 .env 的内容
  const { PrismaClient } = requireFromApi('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at',
    );
    return rows
      .filter((row) => !row.finished_at && !row.rolled_back_at)
      .map((row) => row.migration_name);
  } finally {
    await prisma.$disconnect();
  }
}

const explicitNames = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
let targets = explicitNames;

if (targets.length === 0) {
  console.log('未指定迁移名，自动查询失败记录…');
  try {
    targets = await findFailedMigrations();
  } catch (error) {
    // 这里必须打印真实的错误对象。
    // 早期版本写成 `error instanceof Error ? ... : String(error)` 时曾把 err 误写成 error，
    // 导致异常被吞成 undefined，排查时完全看不到原因。
    console.error('\n查询失败记录时出错：');
    console.error(`  ${error?.constructor?.name ?? 'Unknown'}: ${error?.message ?? String(error)}`);
    if (error?.code) console.error(`  code: ${error.code}`);
    console.error('\n若提示 _prisma_migrations 不存在，说明还没执行过任何迁移，无需清理。');
    process.exit(1);
  }
}

if (targets.length === 0) {
  console.log('✅ 没有处于失败状态的迁移记录，无需清理。');
  console.log('\n直接执行：pnpm db:deploy');
  process.exit(0);
}

console.log(`待清除：${targets.join(', ')}\n`);

let failed = 0;
for (const name of targets) {
  process.stdout.write(`  resolve --rolled-back ${name} … `);
  // 关键：显式传 --schema（绝对路径）并指定 cwd，避免 Prisma 找不到 schema
  const result = spawnSync(
    process.execPath,
    [prismaCli, 'migrate', 'resolve', '--rolled-back', name, '--schema', schemaPath],
    { cwd: apiRoot, env: childEnv, encoding: 'utf8' },
  );

  if (result.error) {
    failed += 1;
    console.log('无法启动子进程');
    console.log(`    原因: ${result.error.message}`);
    if (result.error.code === 'EPERM') {
      console.log('    该环境不允许派生子进程。请直接手动执行下面这条命令：');
      console.log(
        `    node node_modules/prisma/build/index.js migrate resolve --rolled-back ${name} --schema prisma/schema.prisma`,
      );
      console.log('    （在 apps/api 目录下执行，并确保 DATABASE_URL 已设置）');
    }
  } else if (result.status === 0) {
    console.log('已清除');
  } else {
    failed += 1;
    console.log(`失败（退出码 ${result.status}）`);
    const output = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    if (output) {
      console.log(`    ${output.split('\n').slice(0, 6).join('\n    ')}`);
    } else {
      console.log('    （Prisma 未输出任何信息，请手动执行上面的命令查看详情）');
    }
  }
}

console.log('');
if (failed > 0) {
  console.error(`${failed} 条未能清除，请检查上面的输出。`);
  process.exit(1);
}

console.log('=== 完成 ===');
console.log('失败记录已清除（注意：这只改了记账，没有执行 SQL）。');
console.log('\n下一步：');
console.log('  pnpm db:deploy     # 真正应用迁移建表');
console.log('  pnpm db:doctor     # 核对结构');
console.log('  pnpm db:seed       # 写入演示数据');
