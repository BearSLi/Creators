/**
 * CreatorOps 本地数据库初始化（无需 Docker，跨平台）
 * ----------------------------------------------------------------------------
 * 用途：在你已安装的 PostgreSQL 上创建项目所需的角色与数据库。
 * 幂等：角色/数据库已存在时自动跳过，可反复执行。
 *
 * 用法：
 *   node scripts/setup-database.mjs
 *
 * 认证方式（任选其一，优先顺序如下）：
 *   1) 环境变量 PGPASSWORD 已设置 —— 直接使用（适合 CI 或已配置好的机器）
 *   2) 命令行参数 --password=xxx
 *   3) 交互式输入（隐藏回显）
 *
 * 可选参数：
 *   --superuser=postgres        超级用户名（默认 postgres）
 *   --pgbin="C:\Program Files\PostgreSQL\17\bin"   PostgreSQL 的 bin 目录
 *   --host=127.0.0.1 --port=5432
 *   --app-user=creatorops --app-password=creatorops --database=creatorops
 *
 * 实现说明：本脚本**不依赖任何 npm 依赖**，直接调用 psql.exe，
 * 这样即使 node_modules 尚未安装也能先把手头的数据库准备好。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { platform } from 'node:os';

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
const args = new Map();
for (const raw of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (match) args.set(match[1], match[2] ?? 'true');
}

const config = {
  superUser: args.get('superuser') ?? 'postgres',
  host: args.get('host') ?? '127.0.0.1',
  port: args.get('port') ?? '5432',
  appUser: args.get('app-user') ?? 'creatorops',
  appPassword: args.get('app-password') ?? 'creatorops',
  database: args.get('database') ?? 'creatorops',
  pgBin: args.get('pgbin') ?? guessPgBin(),
};

/** 猜测 PostgreSQL 的 bin 目录：常见安装路径 + 环境变量 + PATH */
function guessPgBin() {
  const candidates = [];

  // Windows 常见安装路径：PostgreSQL\17\bin 优先（版本号越大越优先）
  if (platform() === 'win32') {
    for (const version of ['18', '17', '16', '15', '14']) {
      candidates.push(`C:\\Program Files\\PostgreSQL\\${version}\\bin`);
    }
  }
  // macOS / Linux 常见路径
  candidates.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin');

  for (const candidate of candidates) {
    if (existsSync(join(candidate, psqlName()))) return candidate;
  }
  // 兜底：交给 PATH 解析
  return '';
}

function psqlName() {
  return platform() === 'win32' ? 'psql.exe' : 'psql';
}

const psqlPath = config.pgBin ? join(config.pgBin, psqlName()) : psqlName();

// ---------------------------------------------------------------------------
// 执行 psql
// ---------------------------------------------------------------------------
function runPsql({ user, database, sql, password }) {
  const result = spawnSync(
    psqlPath,
    [
      '-h', config.host,
      '-p', String(config.port),
      '-U', user,
      '-d', database,
      '-v', 'ON_ERROR_STOP=1',
      '-tAc', sql,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: password },
      // 不用 shell，避免注入与引号转义问题
      shell: false,
    },
  );

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(
        `找不到 psql：${psqlPath}\n` +
          '请用 --pgbin 指定 PostgreSQL 的 bin 目录，例如：\n' +
          '  node scripts/setup-database.mjs --pgbin="C:\\Program Files\\PostgreSQL\\17\\bin"',
      );
    }
    throw result.error;
  }

  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

// ---------------------------------------------------------------------------
// 交互式读取密码（隐藏回显）
// ---------------------------------------------------------------------------
async function promptPassword(prompt) {
  // 非 TTY（如重定向）时 readline 无法隐藏回显，直接提示用环境变量
  if (!process.stdin.isTTY) {
    throw new Error(
      '当前不是交互式终端，无法安全地读取密码。\n' +
        '请改用环境变量：\n' +
        '  $env:PGPASSWORD="你的密码"; node scripts/setup-database.mjs    (PowerShell)\n' +
        '  export PGPASSWORD=你的密码 && node scripts/setup-database.mjs  (bash)',
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write(prompt);

  // 关闭回显：terminal 模式下 readline 会把输入回显到 output
  const originalWrite = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = function (text) {
    // 只回显我们主动写出的提示，不回显用户键入的字符
    if (text.includes(prompt)) originalWrite?.(text);
  };

  const answer = await new Promise((resolve) => rl.question('', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== CreatorOps 数据库初始化 ===\n');
  console.log(`psql  : ${psqlPath || '(从 PATH 解析)'}`);
  console.log(`目标  : ${config.host}:${config.port}  数据库 ${config.database}  角色 ${config.appUser}\n`);

  // 1) 取得超级用户密码
  let superPassword = process.env.PGPASSWORD ?? args.get('password');
  if (!superPassword) {
    console.log(`请输入 PostgreSQL 超级用户 [${config.superUser}] 的密码（安装时设置的）`);
    superPassword = await promptPassword('密码: ');
  }
  if (!superPassword) {
    console.error('密码为空，已取消。');
    process.exit(1);
  }

  // 2) 验证连接
  const probe = runPsql({ user: config.superUser, database: 'postgres', sql: 'SELECT version();', password: superPassword });
  if (!probe.ok) {
    console.error('\n连接失败。psql 输出：');
    console.error(probe.stderr || '(无输出)');
    console.error('\n常见原因：');
    console.error('  - 密码不正确');
    console.error(`  - 超级用户名不是 ${config.superUser}（可在 pgAdmin 或安装日志中确认）`);
    console.error(`  - PostgreSQL 未监听 ${config.host}:${config.port}`);
    console.error('\n也可以跳过本脚本，手动执行等价 SQL：');
    console.error(`  CREATE ROLE ${config.appUser} WITH LOGIN PASSWORD '${config.appPassword}' CREATEDB;`);
    console.error(`  CREATE DATABASE ${config.database} WITH ENCODING 'UTF8' OWNER ${config.appUser} TEMPLATE template0;`);
    process.exit(1);
  }
  console.log('\n连接成功。');

  // 3) 创建角色（幂等）
  const roleExists = runPsql({
    user: config.superUser,
    database: 'postgres',
    sql: `SELECT 1 FROM pg_roles WHERE rolname = '${config.appUser}';`,
    password: superPassword,
  });
  if (roleExists.stdout === '1') {
    console.log(`角色 ${config.appUser} 已存在，跳过创建。`);
  } else {
    const created = runPsql({
      user: config.superUser,
      database: 'postgres',
      sql: `CREATE ROLE ${config.appUser} WITH LOGIN PASSWORD '${config.appPassword}' CREATEDB;`,
      password: superPassword,
    });
    if (!created.ok) {
      console.error(`创建角色失败：${created.stderr}`);
      process.exit(1);
    }
    console.log(`已创建角色 ${config.appUser}（密码 ${config.appPassword}，仅供本地开发）。`);
  }

  // 4) 创建数据库（幂等）
  const dbExists = runPsql({
    user: config.superUser,
    database: 'postgres',
    sql: `SELECT 1 FROM pg_database WHERE datname = '${config.database}';`,
    password: superPassword,
  });
  if (dbExists.stdout === '1') {
    console.log(`数据库 ${config.database} 已存在，跳过创建。`);
  } else {
    // 显式 UTF8 + template0：避免不同机器默认 locale 不同，导致排序与大小写行为不一致
    const created = runPsql({
      user: config.superUser,
      database: 'postgres',
      sql: `CREATE DATABASE ${config.database} WITH ENCODING 'UTF8' OWNER ${config.appUser} TEMPLATE template0;`,
      password: superPassword,
    });
    if (!created.ok) {
      console.error(`创建数据库失败：${created.stderr}`);
      process.exit(1);
    }
    console.log(`已创建数据库 ${config.database}（owner=${config.appUser}，UTF8）。`);
  }

  // 5) 用应用账号验证一次，确认密码可用
  const verify = runPsql({
    user: config.appUser,
    database: config.database,
    sql: 'SELECT current_database() || $$ / $$ || current_user;',
    password: config.appPassword,
  });
  if (!verify.ok) {
    console.error('用应用账号连接失败：');
    console.error(verify.stderr || '(无输出)');
    process.exit(1);
  }
  console.log(`应用账号连接验证通过：${verify.stdout}`);

  // 6) 下一步提示
  console.log('\n=== 完成 ===');
  console.log('.env 应包含（.env.example 的默认值即可直接用）：');
  console.log(`  DATABASE_URL=postgresql://${config.appUser}:${config.appPassword}@${config.host}:${config.port}/${config.database}?schema=public`);
  console.log('');
  console.log('提示：.env 里的 REDIS_URL 当前没有任何代码读取（限流用进程内计数、');
  console.log('      定时任务用进程内调度），不启 Redis 也能完整跑通。');
  console.log('');
  console.log('下一步：');
  console.log('  1) 生成迁移基线：见 docs/deployment.md §3.3');
  console.log('  2) pnpm --filter @creatorops/api prisma:deploy');
  console.log('  3) pnpm db:seed');
  console.log('  4) pnpm dev');
}

main().catch((error) => {
  console.error('\n执行失败：', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
