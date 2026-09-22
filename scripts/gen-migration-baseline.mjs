/**
 * 生成 Prisma 迁移基线（0_init）
 * ----------------------------------------------------------------------------
 * 为什么需要脚本而不是一条命令行：
 *   1) `pnpm --filter @creatorops/api exec prisma migrate diff --to-schema-datamodel apps/api/prisma/schema.prisma`
 *      会因为 pnpm 把工作目录切到 apps/api 而找不到那个相对路径；
 *   2) 用 PowerShell 的 `>` 重定向会按 UTF-16 写文件，生成的 migration.sql
 *      可能带 BOM / NUL 字节，Prisma 执行时会报语法错误；
 *   3) Prisma CLI 不读仓库根目录的 .env，需要注入 DATABASE_URL（虽然 diff
 *      本身不需要连库，但 CLI 会把 schema 里的 env() 解析失败当成致命错误）。
 *
 * 本脚本从仓库根目录统一处理这三件事，产出可直接被 prisma migrate 使用的基线。
 *
 * 用法：
 *   node scripts/gen-migration-baseline.mjs
 *
 * 幂等：已经生成过会提示并退出（除非加 --force 覆盖）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = join(repoRoot, 'apps', 'api');
const schemaPath = join(apiRoot, 'prisma', 'schema.prisma');
const migrationDir = join(apiRoot, 'prisma', 'migrations', '0_init');
const migrationFile = join(migrationDir, 'migration.sql');
const force = process.argv.includes('--force');

console.log('=== 生成 Prisma 迁移基线 (0_init) ===\n');

// --- 前置检查 ---
if (!existsSync(schemaPath)) {
  console.error(`找不到 schema：${schemaPath}`);
  process.exit(1);
}

// 读取根目录 .env 并注入子进程环境（Prisma CLI 不读仓库根目录的 .env）
const envPath = join(repoRoot, '.env');
if (!existsSync(envPath)) {
  console.error(`找不到 ${envPath}，请先执行：copy .env.example .env`);
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
  fileEnv[line.slice(0, eq).trim()] = value;
}

if (existsSync(migrationFile) && !force) {
  // readFileSync 返回 Buffer，长度在 .length 而不是 .size（早期版本用错了属性，
  // 打印出 undefined 字节，反而掩盖了「文件其实存在但可能是空的」这件事）
  const content = readFileSync(migrationFile, 'utf8');
  const bytes = Buffer.byteLength(content, 'utf8');

  const seemsEmpty = content.trim().length === 0;
  console.log(`基线已存在：apps/api/prisma/migrations/0_init/migration.sql（${bytes} 字节）`);
  if (seemsEmpty) {
    console.log('\n注意：该文件是空的，多半是之前用 PowerShell 重定向（>）失败留下的。');
    console.log('正在自动重新生成…\n');
  } else {
    console.log('如需重新生成，请加 --force（注意：会覆盖，已应用的迁移不要随意重建）。');
    process.exit(0);
  }
}

mkdirSync(migrationDir, { recursive: true });

// --- 定位 prisma CLI ---
// 为什么不用 `pnpm exec prisma`：那需要经过 shell 解析，
// 在受限环境（无子进程 shell 权限）会直接 EPERM；
// 而且 `pnpm exec` 在不同 pnpm 版本下对「本地 bin 是否存在」的判定不一致
// （实测会报 Command "prisma" not found）。
// 直接定位 node_modules 里的 CLI 入口并以 node 执行，行为最确定。
const prismaCli = [
  join(apiRoot, 'node_modules', 'prisma', 'build', 'index.js'),
  join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js'),
].find((candidate) => existsSync(candidate));

if (!prismaCli) {
  console.error('找不到 prisma CLI。请先在仓库根目录执行：pnpm install');
  process.exit(1);
}
console.log(`prisma CLI：${prismaCli.replace(repoRoot + '\\', '')}`);

// --- 调用 prisma migrate diff，用绝对路径指定 schema，避免 cwd 歧义 ---
console.log('正在对比 schema 与空数据库，生成 DDL…');
const result = spawnSync(
  process.execPath,
  [
    prismaCli,
    'migrate',
    'diff',
    '--from-empty',
    '--to-schema-datamodel',
    schemaPath,
    '--script',
  ],
  {
    cwd: apiRoot,
    env: { ...fileEnv, ...process.env },
    encoding: 'utf8',
    // 不使用 shell：避免在受限环境被拒绝，也避免引号/空格路径的转义问题
    shell: false,
  },
);

if (result.error) {
  console.error(`执行 prisma 失败：${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error('prisma migrate diff 执行失败，输出：');
  console.error(result.stdout ?? '');
  console.error(result.stderr ?? '');
  process.exit(1);
}

let ddl = result.stdout ?? '';

// --- 关键：剥掉 UTF-8 BOM ---
// prisma migrate diff 在某些平台/终端下会把 BOM（U+FEFF）写进 stdout，
// 原样落盘会让 PostgreSQL 报 `语法错误 在 "" 或附近的`（错误位置 1），
// 迁移直接失败（P3018）。这里连同零宽字符一起清掉，并断言首字符是 SQL 内容。
ddl = ddl.replace(/^\uFEFF/, '');
if (ddl.charCodeAt(0) === 0xfeff) {
  ddl = ddl.slice(1);
}
// 兜底：把任何位置的零宽不换行空格也去掉（它不可见但会让 SQL 解析失败）
ddl = ddl.replace(/\uFEFF/g, '');

if (!ddl.trim()) {
  console.error('生成结果为空，请检查 schema 是否有效。');
  process.exit(1);
}

if (ddl.charCodeAt(0) !== '-'.charCodeAt(0) && ddl.charCodeAt(0) !== 'C'.charCodeAt(0)) {
  console.error(
    `生成内容首个字符不是 SQL 注释或语句（code=${ddl.charCodeAt(0).toString(16)}），` +
      '可能存在不可见字符，已中止以免生成坏迁移。',
  );
  process.exit(1);
}

// 防御：stdout 里若混入非 SQL 内容（如告警文本），提前暴露而不是生成坏迁移
if (!ddl.includes('CREATE TABLE')) {
  console.error('生成结果里没有 CREATE TABLE，内容可能不是 DDL：');
  console.error(ddl.slice(0, 500));
  process.exit(1);
}

// --- 自检：基线必须真的包含业务表，否则说明 schema 或命令有问题 ---
const expectedTables = ['teams', 'users', 'creators', 'platform_accounts', 'contracts', 'contents', 'settlements'];
const missing = expectedTables.filter((table) => !ddl.includes(`"${table}"`));
if (missing.length > 0) {
  console.error(`生成的 DDL 缺少预期表：${missing.join(', ')}`);
  console.error('这说明 schema 或 prisma 版本与预期不符，请人工检查后再用。');
  process.exit(1);
}

// UTF-8 写入，不加 BOM：Prisma 对 BOM 敏感，会报语法错误
writeFileSync(migrationFile, ddl, { encoding: 'utf8' });

// 落盘后复检：确认真实字节里没有 BOM（写文件时编码选择出错也会引入）
const written = readFileSync(migrationFile);
const hasBom = written[0] === 0xef && written[1] === 0xbb && written[2] === 0xbf;
if (hasBom) {
  console.error('写入的迁移文件仍带 BOM，已修正。');
  writeFileSync(migrationFile, written.subarray(3));
}
const finalBytes = readFileSync(migrationFile);
console.log(`\n首字节校验：${[...finalBytes.slice(0, 3)].map((b) => b.toString(16)).join(' ')}（应为 2d 2d 20，即 "-- "）`);

const lines = ddl.split('\n').length;
console.log(`已生成：apps/api/prisma/migrations/0_init/migration.sql`);
console.log(`  行数 ${lines}，大小 ${Buffer.byteLength(ddl, 'utf8')} 字节`);
console.log(`  含 ${expectedTables.length} 张预期业务表（已自检）`);
console.log('\n下一步：');
console.log('  pnpm db:deploy     # 真正执行迁移建表');
console.log('  pnpm db:seed       # 写入演示数据');
console.log('  pnpm db:doctor     # 核对表结构');
console.log('\n注意：若之前 db:deploy 已失败过，需先清除失败记录，见 docs/deployment.md §3.3。');
