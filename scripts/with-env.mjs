/**
 * 带根目录 .env 运行命令，并解析 workspace 内的本地 CLI
 * ----------------------------------------------------------------------------
 * 解决两个实际问题：
 *
 * 1) **Prisma CLI 不读仓库根目录的 .env** —— 它只在 schema.prisma 同目录、
 *    或命令执行目录下查找 .env。项目把配置集中在仓库根 .env，
 *    于是 `prisma migrate deploy` / `prisma db seed` 会报
 *    `Environment variable not found: DATABASE_URL`。
 *
 * 2) **pnpm 不会把 app 的依赖提升到仓库根** —— 因此根目录没有
 *    `node_modules/.bin/prisma`。想在根目录跑 prisma，只能
 *    `pnpm --filter @creatorops/api exec prisma ...`（要经 shell），
 *    或者手动写死 apps/api/node_modules/.bin 的绝对路径。
 *    这里把「解析本地 CLI」这件事内置，脚本可以写得更直白。
 *
 * 用法：
 *   node scripts/with-env.mjs prisma migrate status
 *   node scripts/with-env.mjs pnpm --filter @creatorops/api run prisma:seed
 *   node scripts/with-env.mjs node scripts/db-doctor.mjs
 *
 * 已存在的环境变量优先，不会被 .env 覆盖 —— 便于临时指向别的库做验证。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 1) 解析根目录 .env
// ---------------------------------------------------------------------------
function parseEnvFile(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

const envPath = join(repoRoot, '.env');
if (!existsSync(envPath)) {
  console.error(`找不到 ${envPath}\n请先执行：copy .env.example .env`);
  process.exit(1);
}
const fileEnv = parseEnvFile(readFileSync(envPath, 'utf8'));
const mergedEnv = { ...fileEnv, ...process.env };

// ---------------------------------------------------------------------------
// 2) 解析本地 CLI（apps/api/node_modules/.bin 优先）
// ---------------------------------------------------------------------------
const localBinDirs = [
  join(repoRoot, 'apps', 'api', 'node_modules', '.bin'),
  join(repoRoot, 'apps', 'web', 'node_modules', '.bin'),
  join(repoRoot, 'node_modules', '.bin'),
];

/** 把命令名解析为本地 bin 的绝对路径；找不到则返回原名（交给 PATH） */
function resolveCommand(command) {
  // 已经是路径（含分隔符）或绝对路径，不再解析
  if (command.includes('/') || command.includes('\\')) return command;

  const suffixes = platform() === 'win32' ? ['.cmd', '.exe', ''] : ['', '.cmd'];
  for (const dir of localBinDirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, `${command}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

const [rawCommand, ...commandArgs] = process.argv.slice(2);
if (!rawCommand) {
  console.error('用法：node scripts/with-env.mjs <命令> [参数...]');
  process.exit(1);
}

const command = resolveCommand(rawCommand);

// ---------------------------------------------------------------------------
// 3) 执行
// ---------------------------------------------------------------------------
// 始终使用 shell: true。原因是 Windows 上 pnpm / npx 这类命令实际是 .cmd 包装脚本，
// Node 的 spawn 不经 shell 无法执行它们（会报 `spawnSync pnpm ENOENT`，很容易被
// 误判成「pnpm 没装」）。曾尝试只在 .cmd 结尾时启用 shell，但那样需要先把命令名
// 解析成绝对路径，而 pnpm 位于用户级安装目录、不在项目 node_modules/.bin 里，
// 解析不到就退化成无 shell 调用 —— 反而制造了这次 ENOENT 回归。
// 结论：解析本地 CLI 仍然有价值（能让命令更直观），但是否经 shell 不应依赖它。
const result = spawnSync(command, commandArgs, {
  stdio: 'inherit',
  env: mergedEnv,
  shell: true,
  cwd: process.cwd(),
});

if (result.error) {
  console.error(`无法执行 ${rawCommand}：${result.error.message}`);
  if (result.error.code === 'EPERM') {
    console.error(
      '\n当前环境不允许派生子进程（EPERM）。可改用不依赖子进程的等价命令，\n' +
        '例如直接执行 node scripts/db-doctor.mjs。',
    );
  }
  process.exit(1);
}
process.exit(result.status ?? 1);
