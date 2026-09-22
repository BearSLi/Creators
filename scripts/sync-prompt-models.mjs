/**
 * 同步 Prompt 模板的模型名
 * ----------------------------------------------------------------------------
 * 用途：把数据库里 prompt_templates.model 更新为当前 .env 的 AI_DEFAULT_MODEL。
 *
 * 为什么需要它：
 *   seedDefaultTemplates 只在「该 key 还没有任何版本」时插入模板，不会覆盖已有行。
 *   所以当你把 AI_PROVIDER 从 openai 换成 deepseek（或其他厂商）时，
 *   数据库里的模板仍带着旧厂商的模型名（如 gpt-4o-mini），
 *   上游会以 BAD_REQUEST 拒绝，系统降级到 mock ——
 *   表现为「provider 明明切了，模型还是旧的」，而改 .env 完全无效
 *   （因为模板里的模型名优先级高于 AI_DEFAULT_MODEL）。
 *
 * 用法：
 *   node scripts/sync-prompt-models.mjs            # 预览将要改动的内容
 *   node scripts/sync-prompt-models.mjs --apply    # 实际执行更新
 *   node scripts/sync-prompt-models.mjs --model=deepseek-chat   # 指定模型名
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = join(repoRoot, 'apps', 'api');
const requireFromApi = createRequire(join(apiRoot, 'package.json'));

// --- 参数 ---
const flags = process.argv.slice(2);
const apply = flags.includes('--apply');
const explicitModel = flags.find((flag) => flag.startsWith('--model='))?.split('=')[1];

// --- 加载根目录 .env（必须在解析 @prisma/client 之前）---
const envPath = join(repoRoot, '.env');
if (!existsSync(envPath)) {
  console.error('找不到 .env');
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

if (!process.env.DATABASE_URL) {
  console.error('.env 里没有 DATABASE_URL');
  process.exit(1);
}

const targetModel = explicitModel ?? process.env.AI_DEFAULT_MODEL ?? '';
if (!targetModel) {
  console.error('未指定模型名，且 .env 里没有 AI_DEFAULT_MODEL。请用 --model=xxx 指定。');
  process.exit(1);
}

const provider = process.env.AI_PROVIDER ?? '(未设置)';

console.log('=== 同步 Prompt 模板模型名 ===\n');
console.log(`AI_PROVIDER      : ${provider}`);
console.log(`目标模型名       : ${targetModel}`);
console.log(`执行模式         : ${apply ? '实际更新' : '预览（加 --apply 才会写入）'}\n`);

// 与 ai-task.service.ts 的 PROVIDER_MODEL_HINTS 保持一致：提前给出明显不匹配的警告
const HINTS = {
  openai: ['gpt-', 'o1', 'o3', 'o4'],
  deepseek: ['deepseek-'],
  anthropic: ['claude-'],
  gemini: ['gemini-'],
};
const hints = HINTS[provider];
if (hints && !hints.some((hint) => targetModel.toLowerCase().startsWith(hint))) {
  console.log(`⚠️  警告：AI_PROVIDER=${provider} 通常使用 ${hints.join(' / ')} 开头的模型名，`);
  console.log(`    而你要写入的是「${targetModel}」。上游很可能以 BAD_REQUEST 拒绝。\n`);
}

const { PrismaClient } = requireFromApi('@prisma/client');
const prisma = new PrismaClient();

try {
  const templates = await prisma.promptTemplate.findMany({
    select: { id: true, key: true, version: true, model: true, isActive: true },
    orderBy: [{ key: 'asc' }, { version: 'desc' }],
  });

  if (templates.length === 0) {
    console.log('数据库里还没有任何 Prompt 模板。启动一次后端即可自动写入内置模板。');
    process.exit(0);
  }

  const needChange = templates.filter((template) => template.model !== targetModel);
  console.log(`共 ${templates.length} 个模板，其中 ${needChange.length} 个需要更新：\n`);

  for (const template of templates) {
    const mark = template.model === targetModel ? '  ' : '→ ';
    const suffix = template.isActive ? '' : '（已停用）';
    console.log(`  ${mark}${template.key} v${template.version}: ${template.model} → ${targetModel}${suffix}`);
  }

  if (needChange.length === 0) {
    console.log('\n✅ 所有模板的模型名都已正确，无需改动。');
    process.exit(0);
  }

  if (!apply) {
    console.log('\n预览结束。确认无误后执行：');
    console.log('  pnpm db:sync-models');
    console.log('\n注意：后端有「模板被使用过就不可就地修改内容」的保护，');
    console.log('      但那只限制 systemPrompt / userPromptTemplate，改模型名是允许的。');
    process.exit(0);
  }

  const result = await prisma.promptTemplate.updateMany({
    where: { model: { not: targetModel } },
    data: { model: targetModel },
  });
  console.log(`\n✅ 已更新 ${result.count} 个模板的模型名 → ${targetModel}`);
  console.log('\n现在可以在 AI 工作台重新生成一次，应该不再降级到 mock。');
  console.log('提示：AI 任务详情里会显示实际使用的 provider 与 model，可据此确认。');
} catch (error) {
  console.error('\n执行失败：');
  console.error(`  ${error?.constructor?.name ?? 'Unknown'}: ${error?.message ?? String(error)}`);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
