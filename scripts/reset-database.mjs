/**
 * 彻底重置 CreatorOps 数据库
 * ----------------------------------------------------------------------------
 * 解决什么问题：
 *   `prisma migrate reset` 只用应用账号（creatorops）操作，无法处理
 *   「_prisma_migrations 表属主是 postgres 超级用户」的情况，报 P3016：
 *   `必须是表 _prisma_migrations 的属主`。
 *   这种「表被别的角色创建过」的状态，常见于初始化时用超级用户执行过
 *   `prisma migrate resolve` / `db push`。
 *
 * 做法：用超级用户 DROP + CREATE 整个数据库。
 *   CREATE DATABASE 时 OWNER 指定为应用账号，因此新库里的所有对象
 *   （含后续由 migrate 创建的 _prisma_migrations）都归应用账号所有，
 *   之后 pnpm db:deploy / db:seed 都不会再遇到属主问题。
 *
 * 这是**破坏性操作**：库内所有数据都会丢失。
 *   - 默认会要求输入 "yes" 确认；
 *   - 加 --yes 可跳过确认（适合脚本化）；
 *   - 目标库名必须与 .env 的 DATABASE_URL 一致，否则脚本拒绝执行（防止误删别的库）。
 *
 * 用法：
 *   pnpm db:nuke            # 交互确认
 *   pnpm db:nuke -- --yes   # 跳过确认
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { platform } from 'node:os';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (const raw of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (match) args.set(match[1], match[2] ?? 'true');
}
const skipConfirm = args.has('yes');

// ---------------------------------------------------------------------------
// 1) 读根目录 .env，拿到目标库名（绝不硬编码，避免误删）
// ---------------------------------------------------------------------------
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
  fileEnv[line.slice(0, eq).trim()] = value;
}

const databaseUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL;
if (!databaseUrl) {
  console.error('.env 里没有 DATABASE_URL');
  process.exit(1);
}

const parsed = new URL(databaseUrl);
const database = parsed.pathname.replace(/^\//, '');
const appUser = parsed.username;
const host = parsed.hostname;
const port = parsed.port || '5432';
const appPassword = parsed.password;

if (!database) {
  console.error(`无法从 DATABASE_URL 解析库名：${databaseUrl}`);
  process.exit(1);
}

// 安全护栏：只允许重置看起来像本项目开发库的名字，避免手滑删掉业务库
const SAFE_PATTERN = /^(creatorops|creatorops_(dev|test|local))$/;
if (!SAFE_PATTERN.test(database)) {
  console.error(`拒绝执行：库名「${database}」不在允许重置的白名单内。`);
  console.error('本脚本只用于本地开发库（creatorops / creatorops_dev / creatorops_test / creatorops_local）。');
  console.error('如需重置其他库，请手动使用 psql。');
  process.exit(1);
}

console.log('=== CreatorOps 数据库重置（破坏性）===\n');
console.log(`目标库   : ${database}@${host}:${port}`);
console.log(`应用账号 : ${appUser}`);
console.log('');

// ---------------------------------------------------------------------------
// 2) 定位 psql
// ---------------------------------------------------------------------------
function psqlPath() {
  const candidates = [];
  if (platform() === 'win32') {
    for (const version of ['18', '17', '16', '15', '14']) {
      candidates.push(`C:\\Program Files\\PostgreSQL\\${version}\\bin\\psql.exe`);
    }
  }
  candidates.push('/usr/local/bin/psql', '/usr/bin/psql', '/opt/homebrew/bin/psql');
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ?? 'psql';
}

const psql = psqlPath();

function runSql(sql, password) {
  const result = spawnSync(
    psql,
    ['-h', host, '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: password }, shell: false },
  );
  return {
    ok: result.status === 0,
    stderr: (result.stderr ?? '').trim(),
    stdout: (result.stdout ?? '').trim(),
    error: result.error,
  };
}

// ---------------------------------------------------------------------------
// 3) 确认
// ---------------------------------------------------------------------------
async function confirm() {
  if (skipConfirm) {
    console.log('已指定 --yes，跳过确认。\n');
    return true;
  }
  if (!process.stdin.isTTY) {
    console.error('非交互终端，无法确认。如确认要重置，请加 --yes。');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolveAnswer) =>
    rl.question(`将删除数据库「${database}」及其全部数据。输入 yes 继续：`, resolveAnswer),
  );
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

// ---------------------------------------------------------------------------
// 4) 主流程
// ---------------------------------------------------------------------------
async function main() {
  const proceed = await confirm();
  if (!proceed) {
    console.log('已取消。');
    process.exit(0);
  }

  // 取超级用户密码
  let superPassword = process.env.PGPASSWORD;
  if (!superPassword) {
    if (!process.stdin.isTTY) {
      console.error('需要超级用户密码。请设置 $env:PGPASSWORD 后重试，或在交互终端下运行。');
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write('请输入 postgres 超级用户密码: ');
    const original = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = function (text) {
      if (text.includes('请输入')) original?.(text);
    };
    superPassword = await new Promise((resolveAnswer) => rl.question('', resolveAnswer));
    rl.close();
    process.stdout.write('\n');
  }

  // 验证超级用户可用
  const probe = runSql('SELECT 1;', superPassword);
  if (!probe.ok) {
    console.error('超级用户连接失败：');
    console.error(probe.stderr || probe.error?.message || '(无输出)');
    process.exit(1);
  }

  // DROP：先切断可能存在的连接，否则 DROP DATABASE 会因「其他会话正在使用」失败
  console.log(`正在删除数据库 ${database}…`);
  const terminate = runSql(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid();`,
    superPassword,
  );
  if (!terminate.ok) {
    // 切连接失败不算致命，继续尝试 DROP，让 DROP 自己报明确错误
    console.log(`  （清理现有连接时提示：${terminate.stderr.split('\n')[0]}）`);
  }

  const drop = runSql(`DROP DATABASE IF EXISTS "${database}";`, superPassword);
  if (!drop.ok) {
    console.error(`删除失败：${drop.stderr}`);
    process.exit(1);
  }
  console.log('  已删除。');

  // CREATE：OWNER 指定为应用账号 —— 这是解决 P3016 的关键
  console.log(`正在创建数据库 ${database}（owner=${appUser}）…`);
  const create = runSql(
    `CREATE DATABASE "${database}" WITH ENCODING 'UTF8' OWNER "${appUser}" TEMPLATE template0;`,
    superPassword,
  );
  if (!create.ok) {
    console.error(`创建失败：${create.stderr}`);
    process.exit(1);
  }
  console.log('  已创建。');

  // 顺带确保应用账号密码与 .env 一致（有时手动改过库密码）
  if (appPassword) {
    runSql(`ALTER ROLE "${appUser}" WITH LOGIN PASSWORD '${appPassword}';`, superPassword);
  }

  console.log('\n=== 数据库已重置 ===');
  console.log('接下来执行（含数据初始化）：');
  console.log('  pnpm db:deploy     # 按顺序应用 0_init 等迁移，真正建表');
  console.log('  pnpm db:seed       # 写入演示数据');
  console.log('  pnpm db:doctor     # 核对表结构（可选但推荐）');
  console.log('  pnpm dev');
}

main().catch((error) => {
  console.error('\n执行失败：', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
