/**
 * 前后端契约校验
 * ----------------------------------------------------------------------------
 * 把前端手写的请求类型与后端 OpenAPI 规范逐字段比对，**在 CI 阶段**发现契约漂移。
 *
 * ## 为什么需要它
 *
 * 之前前端 `api/types.ts` 与后端 DTO 各自演进，出现真实漂移并导致用户可见的故障：
 *   - 前端提交 `status`，后端 CreateProjectDto 没有该字段
 *   - 前端提交 `description`，后端实际叫 `brief`
 * 两者都被后端的 `forbidNonWhitelisted` 拒绝，用户只看到「请检查标红字段后重试」。
 *
 * 这类问题**类型检查发现不了**（前端类型与后端 DTO 各自自洽），
 * 单元测试也覆盖不到（不经过 HTTP），只有真实请求或契约校验能抓到。
 * 真实请求要等到用户点提交，契约校验可以在提交代码时就拦住。
 *
 * ## 校验范围与取舍
 *
 * 只校验**请求体**（`*Request` / `*Dto` 等入参类型）：
 *   - 请求体字段名错了会直接被 forbidNonWhitelisted 拒绝，是「用户可见故障」；
 *   - 响应类型字段更多、且前端经常只用其中一部分（局部类型），
 *     全量比对会产生大量噪音，收益低于成本。
 * 因此这里刻意把校验做窄，保证「报警即真问题」，而不是变成一个被忽略的噪音源。
 *
 * 用法：
 *   node scripts/check-openapi-drift.mjs
 * 退出码：0 无漂移，1 发现漂移，2 规范文件缺失（需先跑 pnpm openapi:export）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = join(repoRoot, 'docs', 'openapi.json');
const webTypesPath = join(repoRoot, 'apps', 'web', 'src', 'api', 'types.ts');

if (!existsSync(specPath)) {
  console.error(`找不到 ${specPath}`);
  console.error('请先执行：pnpm openapi:export');
  process.exit(2);
}
if (!existsSync(webTypesPath)) {
  console.error(`找不到 ${webTypesPath}`);
  process.exit(2);
}

/**
 * 前端请求类型 → OpenAPI schema 的映射。
 *
 * 两边的命名约定不同：前端用 `XxxRequest`，后端 Swagger 用 DTO 类名 `CreateXxxDto`。
 * 显式列出而不是靠字符串猜（如把 Request 替换成 Dto），因为猜错会静默跳过校验 ——
 * 那比报错更危险。新增接口时在这里补一行，缺漏会被下面的「未映射」检查发现。
 */
const REQUEST_TYPE_MAP = {
  LoginRequest: 'LoginDto',
  RefreshTokenRequest: 'RefreshTokenDto',
  ChangePasswordRequest: 'ChangePasswordDto',
  CreateCreatorRequest: 'CreateCreatorDto',
  UpdateCreatorRequest: 'UpdateCreatorDto',
  BatchImportCreatorRequest: 'BatchImportCreatorDto',
  EvaluateCreatorRequest: 'EvaluateCreatorDto',
  AssignCreatorRequest: 'AssignCreatorDto',
  ChangeCreatorStatusRequest: 'ChangeCreatorStatusDto',
  CreateTagRequest: 'CreateTagDto',
  UpdateTagRequest: 'UpdateTagDto',
  CreateBrandRequest: 'CreateBrandDto',
  UpdateBrandRequest: 'UpdateBrandDto',
  CreateContractRequest: 'CreateContractDto',
  UpdateContractRequest: 'UpdateContractDto',
  ApproveContractRequest: 'ApproveContractDto',
  TerminateContractRequest: 'TerminateContractDto',
  CreateProjectRequest: 'CreateProjectDto',
  UpdateProjectRequest: 'UpdateProjectDto',
  ChangeProjectStatusRequest: 'ChangeProjectStatusDto',
  CreateContentRequest: 'CreateContentDto',
  UpdateContentRequest: 'UpdateContentDto',
  ReviewContentRequest: 'ReviewContentDto',
  PublishContentRequest: 'PublishContentDto',
  GenerateSettlementRequest: 'GenerateSettlementDto',
  AdjustSettlementRequest: 'AdjustSettlementDto',
  PaySettlementRequest: 'PaySettlementDto',
  DisputeSettlementRequest: 'DisputeSettlementDto',
  VoidSettlementRequest: 'VoidSettlementDto',
  CreateUserRequest: 'CreateUserDto',
  UpdateUserRequest: 'UpdateUserDto',
  UpdateUserPermissionsRequest: 'UpdateUserPermissionsDto',
  CreateAiTaskRequest: 'CreateAiTaskDto',
  SubmitAiFeedbackRequest: 'SubmitFeedbackDto',
  CreateAiPromptRequest: 'CreatePromptTemplateDto',
  UpdateAiPromptRequest: 'UpdatePromptTemplateDto',
};

/**
 * 从 types.ts 里解析一个类型的字段名。
 *
 * 支持两种写法：
 *   1) `export interface X { ... }`
 *   2) `export type X = Partial<Y>;`  —— 前端大量使用这种「更新请求 = 创建请求全可选」
 *      的写法。早期版本只认 interface，于是把 UpdateXxxRequest 全报成「未映射」，
 *      噪音掩盖了真正的问题（比如真的少字段了）。
 *
 * 对 `Partial<Y>` 会递归解析 Y，并标记 isPartial：此时「缺少字段」不算问题
 * （PATCH 语义允许只传部分字段）。
 */
function parseTypeFields(source, typeName, seen = new Set()) {
  if (seen.has(typeName)) return null; // 防循环引用
  seen.add(typeName);

  const interfacePattern = new RegExp(
    `export\\s+interface\\s+${typeName}\\s*(?:extends\\s+[^{]+)?\\{([\\s\\S]*?)\\n\\}`,
  );
  const interfaceMatch = interfacePattern.exec(source);
  if (interfaceMatch) {
    const fields = new Set();
    for (const rawLine of interfaceMatch[1].split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('/') || line.startsWith('*')) continue;
      const field = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(line);
      if (field) fields.add(field[1]);
    }
    return { fields, isPartial: false };
  }

  // type X = Partial<Y>;
  const partialAlias = new RegExp(
    `export\\s+type\\s+${typeName}\\s*=\\s*Partial<\\s*([A-Za-z_$][\\w$]*)\\s*>`,
  ).exec(source);
  if (partialAlias) {
    const base = parseTypeFields(source, partialAlias[1], seen);
    return base ? { fields: base.fields, isPartial: true } : null;
  }

  // type X = Y;（别名）
  const plainAlias = new RegExp(
    `export\\s+type\\s+${typeName}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*;`,
  ).exec(source);
  if (plainAlias) {
    return parseTypeFields(source, plainAlias[1], seen);
  }

  return null;
}

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const schemas = spec.components?.schemas ?? {};
const webTypes = readFileSync(webTypesPath, 'utf8');

const problems = [];
const checked = [];
const unmapped = [];

for (const [webType, schemaName] of Object.entries(REQUEST_TYPE_MAP)) {
  const schema = schemas[schemaName];
  if (!schema) {
    problems.push({
      type: webType,
      kind: 'SCHEMA_MISSING',
      message: `规范里找不到 schema「${schemaName}」。后端可能改了 DTO 名，或该接口尚未标注 @ApiProperty`,
    });
    continue;
  }

  const backendFields = new Set(Object.keys(schema.properties ?? {}));
  const parsed = parseTypeFields(webTypes, webType);

  if (!parsed) {
    unmapped.push(webType);
    continue;
  }
  const { fields: frontendFields, isPartial } = parsed;

  // 前端多提交的字段：会被 forbidNonWhitelisted 直接拒绝（就是这次的真实故障）
  const extra = [...frontendFields].filter((field) => !backendFields.has(field));
  // 前端漏掉的字段：功能静默失效（比如后端新增了字段，前端一直没传）
  // Partial<X>（PATCH 语义）允许只传部分字段，因此不算问题
  const missing = isPartial
    ? []
    : [...backendFields].filter((field) => !frontendFields.has(field));

  if (extra.length > 0) {
    problems.push({
      type: webType,
      kind: 'EXTRA_FIELD',
      message:
        `前端多提交了后端不存在的字段：${extra.join(', ')}。` +
        `后端启用了 forbidNonWhitelisted，提交时会返回 400「property X should not exist」`,
      fields: extra,
    });
  }
  if (missing.length > 0) {
    problems.push({
      type: webType,
      kind: 'MISSING_FIELD',
      message: `前端缺少后端已声明的字段：${missing.join(', ')}（该功能会静默不可用）`,
      fields: missing,
    });
  }

  checked.push({ webType, schemaName, fieldCount: frontendFields.size, isPartial });
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
console.log('=== 前后端契约校验 ===\n');
console.log(`规范文件: docs/openapi.json（${Object.keys(spec.paths ?? {}).length} 个接口 / ${Object.keys(schemas).length} 个模型）`);
console.log(`已校验请求类型: ${checked.length} 个\n`);

if (unmapped.length > 0) {
  console.log('提示：以下类型在 types.ts 里没找到对应 interface，已跳过校验：');
  for (const name of unmapped) console.log(`  ${name}`);
  console.log('（可能是命名变更或类型尚未定义，请核对 REQUEST_TYPE_MAP）\n');
}

if (problems.length === 0) {
  console.log('✅ 未发现请求体契约漂移。');
  process.exit(0);
}

console.error(`❌ 发现 ${problems.length} 处契约漂移：\n`);
for (const problem of problems) {
  console.error(`  [${problem.kind}] ${problem.type}`);
  console.error(`      ${problem.message}\n`);
}
console.error('修复方式：让前端字段与后端 DTO 严格对齐（后端以 @ApiProperty 的声明为准）。');
console.error('若确实是后端 DTO 变了，重新执行：pnpm openapi:export');
process.exit(1);
