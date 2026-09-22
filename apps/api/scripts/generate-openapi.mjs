/**
 * 导出 OpenAPI 规范
 * ----------------------------------------------------------------------------
 * 把后端的 OpenAPI 文档（与 /api/docs 上看到的是同一份）落盘为
 * `docs/openapi.json`，作为**前后端契约的唯一事实来源**。
 *
 * ## 为什么需要它
 *
 * 之前前端 `apps/web/src/api/types.ts` 是**手写**的，与后端 DTO 各自演进，
 * 出现了真实漂移并导致线上问题：
 *   - 前端提交 `status`，后端 CreateProjectDto 里根本没这个字段
 *   - 前端提交 `description`，后端实际叫 `brief`
 * 两者都被后端的 `forbidNonWhitelisted` 拒绝，用户只看到
 * 「提交的内容未通过校验，请检查标红字段后重试」，完全不知道错在哪。
 *
 * 契约一旦落盘，就可以：
 *   1) 用它生成前端类型（`pnpm openapi:types`）；
 *   2) 在 CI 里校验「前端类型是否与后端一致」（`pnpm openapi:check`），
 *      把「运行时才发现」变成「编译/CI 阶段就发现」。
 *
 * ## 实现要点
 *
 * 不启动 HTTP 服务，只在进程内建应用并生成文档——这样在 CI 里不需要占端口、
 * 不需要外部依赖，失败也不会残留进程。也因此**不需要数据库连接**：
 * Swagger 只读取控制器与 DTO 的装饰器元数据。
 *
 * 用法：
 *   node scripts/generate-openapi.mjs            # 写入 docs/openapi.json
 *   node scripts/generate-openapi.mjs --stdout   # 打印到标准输出（供管道使用）
 */

import { mkdirSync, readdirSync, statSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..');
const repoRoot = resolve(apiRoot, '..', '..');
const srcRoot = join(apiRoot, 'src');
const buildRoot = join(apiRoot, '.tmp-openapi');
const buildSrc = join(buildRoot, 'src');
const outputPath = join(repoRoot, 'docs', 'openapi.json');
const toStdout = process.argv.includes('--stdout');

// ---------------------------------------------------------------------------
// 0) 加载根目录 .env（src/config/env.ts 启动时会做校验，缺变量会直接抛错）
// ---------------------------------------------------------------------------
const envPath = join(repoRoot, '.env');
if (!existsSync(envPath)) {
  console.error('找不到 .env，请先执行：copy .env.example .env');
  process.exit(1);
}
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

// ---------------------------------------------------------------------------
// 1) 进程内把 src 转成 CommonJS（不依赖 tsc/nest build，也不需要联网）
// ---------------------------------------------------------------------------
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

rmSync(buildRoot, { recursive: true, force: true });
// 必须先建根目录：后面往 buildRoot 直接写 package.json，
// 而 mkdirSync 只对每个产物文件的父目录递归创建（那时根目录才被顺带建出来）
mkdirSync(buildRoot, { recursive: true });
const sourceFiles = walk(srcRoot);
const mapping = new Map();
for (const file of sourceFiles) {
  const rel = file.slice(srcRoot.length + 1).replace(/\\/g, '/');
  mapping.set(resolve(file), join(buildSrc, rel.replace(/\.ts$/, '.js')));
}

/** 相对导入重写为指向产物的绝对路径：产物多了一层目录，靠数 ../ 极易出错 */
function rewriteSpecifiers(code, sourceFile) {
  return code.replace(
    /(require\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/g,
    (match, prefix, specifier, suffix) => {
      const base = resolve(dirname(sourceFile), specifier);
      for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        join(base, 'index.ts'),
      ]) {
        const target = mapping.get(candidate);
        if (target) return `${prefix}${target.replace(/\\/g, '/')}${suffix}`;
      }
      return match;
    },
  );
}

for (const file of sourceFiles) {
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
    reportDiagnostics: false,
  });
  const out = mapping.get(resolve(file));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rewriteSpecifiers(outputText, file), 'utf8');
}

// 产物目录下声明 commonjs，并把 node_modules 链过去（pnpm 不提升到 app 之外）
writeFileSync(
  join(buildRoot, 'package.json'),
  JSON.stringify({ name: 'creatorops-openapi-build', private: true, type: 'commonjs' }, null, 2),
);
try {
  symlinkSync(join(apiRoot, 'node_modules'), join(buildRoot, 'node_modules'), 'junction');
} catch {
  // 已存在或平台不支持则忽略：后面的 require 仍可能从 apiRoot 解析
}

// ---------------------------------------------------------------------------
// 2) 进程内建应用 → 生成文档
// ---------------------------------------------------------------------------
const requireFromApi = createRequire(join(apiRoot, 'package.json'));
const { NestFactory } = requireFromApi('@nestjs/core');
const { SwaggerModule } = requireFromApi('@nestjs/swagger');

/**
 * 产物用 `await import()` 加载，而不是 require：
 * 本文件是 ESM 且含顶层 await，Node 不允许同一模块里混用 require() 与顶层 await
 * （会报 ERR_AMBIGUOUS_MODULE_SYNTAX）。而 createRequire 返回的函数仍被视为
 * CommonJS 语法，所以只有动态 import 这一条路。
 * 产物是 CommonJS，import() 加载它会走 CJS interop，取 default 或命名导出均可。
 */
async function loadBuiltModule(relativePath) {
  const url = pathToFileURL(join(buildSrc, relativePath)).href;
  const mod = await import(url);
  return mod.default ?? mod;
}

async function main() {
  let app;
  try {
    const { AppModule } = await loadBuiltModule('app.module.js');
    const { buildSwaggerConfig } = await loadBuiltModule('config/swagger.config.js');

    // logger 关掉：这里不需要启动日志，保持输出干净便于管道消费
    app = await NestFactory.create(AppModule, { logger: false });
    // 只 init 不 listen：拿到完整的控制器元数据即可，不占端口
    await app.init();

    const document = SwaggerModule.createDocument(app, buildSwaggerConfig());
    const json = JSON.stringify(document, null, 2);

    if (toStdout) {
      process.stdout.write(json);
      return;
    }

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${json}\n`, 'utf8');

    const paths = Object.keys(document.paths ?? {}).length;
    const schemas = Object.keys(document.components?.schemas ?? {}).length;
    const bytes = Buffer.byteLength(json, 'utf8');

    console.log('=== 已导出 OpenAPI 规范 ===\n');
    console.log(`文件    : docs/openapi.json`);
    console.log(`接口路径: ${paths} 个`);
    console.log(`数据模型: ${schemas} 个`);
    console.log(`大小    : ${(bytes / 1024).toFixed(1)} KB`);
    console.log('\n下一步：');
    console.log('  pnpm openapi:types    # 由规范生成前端类型');
    console.log('  pnpm openapi:check    # 校验前端类型是否与后端一致');
  } catch (error) {
    console.error('生成 OpenAPI 规范失败：');
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  } finally {
    // 不论成功失败都要关掉应用并清理产物，避免残留连接或临时目录
    if (app) await app.close().catch(() => undefined);
    rmSync(buildRoot, { recursive: true, force: true });
  }
}

await main();
