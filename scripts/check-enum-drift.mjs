/**
 * 前后端枚举一致性校验（不需要数据库、不需要 tsc、不需要网络）
 * ============================================================================
 * 为什么需要这个脚本（真实事故复盘）
 * ----------------------------------------------------------------------------
 * 项目里出现过一整类 bug：前端 `apps/web/src/api/types.ts` 里的枚举**是手写的**，
 * 而且和后端 Prisma schema 里的 enum 对不上。具体漂移：
 *
 *   前端                    后端                        后果
 *   ----------------------  --------------------------  --------------------------------
 *   ContractStatus 多了     只有 DRAFT/PENDING_REVIEW/  合同列表筛选直接 400
 *     APPROVED/REJECTED     ACTIVE/EXPIRED/TERMINATED
 *   ProjectStatus 写成      实际是 DRAFT/SCHEDULED/     项目筛选 400；且 CANCELED
 *     PLANNING/IN_PROGRESS  IN_PRODUCTION/IN_REVIEW/    拼成 CANCELLED（双 L）
 *     /DELIVERING/PAUSED    PUBLISHED/COMPLETED/
 *     /CANCELLED            CANCELED
 *   ContentStatus 写成      IDEA/SCRIPTING/SHOOTING/    内容看板的"审核"按钮
 *     DRAFT/PENDING_REVIEW  EDITING/INTERNAL_REVIEW/    永不出现（判的是不存在的
 *     /APPROVED/SCHEDULED   PLATFORM_REVIEW/PUBLISHED/  PENDING_REVIEW）
 *                           REJECTED/OFFLINE
 *   SettlementStatus 用了   末态是 VOID                  逾期提示对已作废单子误报
 *     CANCELLED
 *   AiTaskStatus 写成       QUEUED/RUNNING/SUCCEEDED/   轮询条件里 PENDING 永不命中
 *     PENDING/FALLBACK      FAILED/FALLBACK_USED/
 *                           REJECTED
 *   SettlementMode 写成     FIXED_FEE/REVENUE_SHARE/    合同表单提交 400
 *     FIXED/MIXED           HYBRID/CPA
 *   UserStatus 多了 LOCKED  只有 ACTIVE/DISABLED        状态标签渲染 undefined
 *   DataSourceType 少了     .../MOCK                    仿真账号来源标签 undefined
 *   AgencyType 全错         FULL_MCN/COMMERCIAL/        达人表单提交 400
 *     NONE/MCN/AGENCY/        INDEPENDENT
 *     STUDIO
 *
 * 【最关键的教训】这些问题**TypeScript 一个都查不出来**。
 * 原因：前端枚举声明和使用它的页面都在前端这一侧，`data.status === 'PENDING'`
 * 两边都取自同一个手写的联合类型，永远自洽 —— 类型系统只能保证"前端和自己一致"，
 * 不能保证"前端和后端一致"。要查跨边界的一致性，只能拿**另一侧的事实**来对照，
 * 也就是这份 schema.prisma。
 *
 * 同源事故还有一次：`apps/web/package.json` 的 typecheck 是 `tsc --noEmit`，
 * 而根 tsconfig.json 是 `{ "files": [], "references": [...] }` 的 solution 配置，
 * 等于**一个文件都没检查**，却一直报"0 error"。本脚本不依赖 tsc，所以不受此影响；
 * 那个配置问题已在 package.json 里修正为显式指定 tsconfig.app.json。
 *
 * 检查项
 * ----------------------------------------------------------------------------
 *   [错误] 1. 前端联合类型与 Prisma enum 必须**完全相等**（不多、不少、不拼错）
 *   [错误] 2. 枚举成员的中文标签映射必须与枚举成员一一对应（不漏、不多）
 *   [错误] 3. 自由文本字段的取值约定（SettlementItem.itemType）必须与 schema 注释一致
 *   [错误] 4. 前端源码里出现的大写字面量必须是"某个已知取值"，否则很可能是编的状态值
 *
 * 用法：node scripts/check-enum-drift.mjs [--verbose]
 * 退出码：0 通过；1 发现漂移（可直接接进 CI / pre-commit）
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const schemaPath = resolve(root, 'apps/api/prisma/schema.prisma');
const typesPath = resolve(root, 'apps/web/src/api/types.ts');
const constantsPath = resolve(root, 'apps/web/src/utils/constants.ts');
const webSrcRoot = resolve(root, 'apps/web/src');

const verbose = process.argv.includes('--verbose');

const problems = [];
const notes = [];
function fail(check, message) {
  problems.push({ check, message });
}

for (const required of [schemaPath, typesPath, constantsPath]) {
  if (!existsSync(required)) {
    console.error(`[enum-drift] 缺少必需文件：${required}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 1. 从 Prisma schema 提取枚举事实
// ---------------------------------------------------------------------------

const schema = readFileSync(schemaPath, 'utf8');

/**
 * 要求 `enum 名称 {` 在同一行，避免匹配到文档注释里的示例代码。
 * （同样的坑在 check-prisma-usage.mjs 里踩过一次：注释里的示例被当成了真实声明。）
 */
const enumDeclarations = [...schema.matchAll(/^[ \t]*enum[ \t]+(\w+)[ \t]*\{/gm)];

/** Prisma enum 名 → Set(成员) */
const prismaEnums = new Map();
for (const declaration of enumDeclarations) {
  const name = declaration[1];
  const block = new RegExp(`^enum[ \\t]+${name}[ \\t]*\\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
  const members = (block?.[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0])
    .filter((member) => /^\w+$/.test(member));
  prismaEnums.set(name, new Set(members));
}

if (prismaEnums.size === 0) {
  console.error('[enum-drift] 没有从 schema.prisma 解析到任何 enum —— 解析逻辑或文件结构已变化，请先修脚本');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. 从 types.ts 提取前端联合类型
// ---------------------------------------------------------------------------

const typesSource = readFileSync(typesPath, 'utf8');

/**
 * 解析 `export type X = 'A' | 'B';`（允许多行、允许行内注释）。
 * 只收「全是字符串字面量成员」的联合类型 —— 混合类型（如 `1 | -1`）不是枚举，跳过。
 */
function parseUnionTypes(source) {
  const result = new Map();
  const pattern = /^export type (\w+) =([^;]+);/gm;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const body = match[2];
    const members = [...body.matchAll(/'([^']*)'/g)].map((literal) => literal[1]);
    if (members.length === 0) continue;
    // 去除注释后如果还残留非字面量、非分隔符的内容，说明不是纯字面量联合
    const stripped = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/'[^']*'/g, '')
      .replace(/[\s|]/g, '');
    if (stripped !== '') continue;
    result.set(name, new Set(members));
  }
  return result;
}

const tsUnions = parseUnionTypes(typesSource);

// Prisma enum → 前端类型名。刻意写成显式映射而不是"自动同名"：
// 有几个名字本来就不同（ContentVertical→Vertical、DataSourceType→DataSource），
// 显式列出来，新增枚举时也必须在这里显式表态，不会被"自动同名"悄悄放过。
const ENUM_TO_TS_TYPE = {
  UserRole: 'UserRole',
  UserStatus: 'UserStatus',
  CreatorStatus: 'CreatorStatus',
  CreatorTier: 'CreatorTier',
  Platform: 'Platform',
  ContentVertical: 'Vertical',
  DataSourceType: 'DataSource',
  ContractStatus: 'ContractStatus',
  SettlementMode: 'SettlementMode',
  ProjectStatus: 'ProjectStatus',
  ContentStatus: 'ContentStatus',
  SettlementStatus: 'SettlementStatus',
  AiTaskType: 'AiTaskType',
  AiTaskStatus: 'AiTaskStatus',
  NotificationType: 'NotificationType',
};

// ---------------------------------------------------------------------------
// 检查 1：前端联合类型必须与 Prisma enum 完全相等
// ---------------------------------------------------------------------------

function diffSets(expected, actual) {
  const missing = [...expected].filter((member) => !actual.has(member));
  const extra = [...actual].filter((member) => !expected.has(member));
  return { missing, extra };
}

/**
 * 比较「后端 enum」与「前端联合类型」，返回问题描述数组（空数组 = 一致）。
 * 抽成纯函数是为了让 --self-test 能用构造数据验证它真的会报错 ——
 * 一个永远返回"通过"的检查脚本比没有检查更危险。
 */
function compareEnumSets(tsTypeName, enumName, expected, actual) {
  const messages = [];
  const { missing, extra } = diffSets(expected, actual);
  if (missing.length > 0) {
    messages.push(
      `${tsTypeName} 缺少后端存在的取值：${missing.join(', ')}（后端 enum ${enumName}）`,
    );
  }
  if (extra.length > 0) {
    messages.push(
      `${tsTypeName} 多出后端不存在的取值：${extra.join(', ')}（后端 enum ${enumName} = ${[...expected].join('/')}）。` +
        `这类值会造成筛选/提交时 400，或让比较分支永远不命中。`,
    );
  }
  return messages;
}

// ---------------------------------------------------------------------------
// 检查 1：前端联合类型必须与 Prisma enum 完全相等
// ---------------------------------------------------------------------------

for (const [enumName, expected] of prismaEnums) {
  const tsTypeName = ENUM_TO_TS_TYPE[enumName];

  if (!tsTypeName) {
    fail(
      '未映射',
      `schema.prisma 新增了 enum ${enumName}，但 scripts/check-enum-drift.mjs 的 ENUM_TO_TS_TYPE 里没有它的前端对应类型。` +
        `请在 apps/web/src/api/types.ts 补上对应联合类型，并在此登记映射。`,
    );
    continue;
  }

  const actual = tsUnions.get(tsTypeName);
  if (!actual) {
    fail(
      '类型缺失',
      `${enumName} 对应的前端类型 ${tsTypeName} 在 apps/web/src/api/types.ts 中不存在或不是纯字符串字面量联合。`,
    );
    continue;
  }

  const messages = compareEnumSets(tsTypeName, enumName, expected, actual);
  for (const message of messages) fail('类型漂移', message);
  if (verbose && messages.length === 0) {
    notes.push(`OK  ${enumName} ↔ ${tsTypeName}（${expected.size} 个成员）`);
  }
}

// 反向检查：前端声明了却没有后端 enum 对应的类型，可能是"凭空造的枚举"
for (const tsTypeName of tsUnions.keys()) {
  const mapped = Object.values(ENUM_TO_TS_TYPE).includes(tsTypeName);
  if (!mapped) {
    notes.push(
      `提示 前端联合类型 ${tsTypeName} 没有对应的 Prisma enum（可能是纯前端概念，或 A/B 侧的独立枚举）`,
    );
  }
}

// ---------------------------------------------------------------------------
// 检查 2：中文标签映射必须与枚举成员一一对应
// ---------------------------------------------------------------------------

const constantsSource = readFileSync(constantsPath, 'utf8');

/**
 * 解析 `export const X_LABELS: Record<TypeName, string> = { A: '...', B: '...' };`
 * 只做「键名集合」的提取，不解析值（值里可能有逗号、引号、模板串）。
 */
function parseLabelMaps(source) {
  const maps = [];
  const pattern = /export const (\w+)\s*:\s*Record<\s*(\w+)\s*,\s*string\s*>\s*=\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[0].length;
    // 从 { 之后做一次括号配平扫描，取出对象字面量本体
    let depth = 1;
    let index = start;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      index += 1;
    }
    const body = source.slice(start, index - 1);
    const keys = new Set(
      [...body.matchAll(/(?:^|[\s,{])([A-Za-z_]\w*)\s*:/g)].map((keyMatch) => keyMatch[1]),
    );
    maps.push({ name: match[1], typeName: match[2], keys });
  }
  return maps;
}

const labelMaps = parseLabelMaps(constantsSource);

for (const map of labelMaps) {
  const union = tsUnions.get(map.typeName);
  if (!union) continue; // 索引类型是 string 的映射（如 SOURCE_CHANNEL_LABELS）由源码类型决定

  const { missing, extra } = diffSets(union, map.keys);
  if (missing.length > 0) {
    fail(
      '标签缺失',
      `${map.name} 缺少这些枚举成员的标签：${missing.join(', ')}（会渲染成 undefined）`,
    );
  }
  if (extra.length > 0) {
    fail(
      '标签多余',
      `${map.name} 含有不属于 ${map.typeName} 的键：${extra.join(', ')}（说明类型或标签已经漂移）`,
    );
  }
}

for (const enumName of prismaEnums.keys()) {
  const tsTypeName = ENUM_TO_TS_TYPE[enumName];
  if (!tsTypeName) continue;
  const hasLabels = labelMaps.some((map) => map.typeName === tsTypeName);
  const hasTones = constantsSource.includes(`Record<\n  ${tsTypeName},`) ||
    new RegExp(`Record<${tsTypeName},`).test(constantsSource);
  if (!hasLabels && !hasTones && verbose) {
    notes.push(`提示 ${tsTypeName} 在 constants.ts 里没有中文标签映射`);
  }
}

// ---------------------------------------------------------------------------
// 检查 3：自由文本字段的取值约定
// ---------------------------------------------------------------------------
// SettlementItem.itemType 是 VarChar 而不是 enum，所以上面那套机械比对覆盖不到它。
// schema 里用行尾注释写明了允许值（"REVENUE | FIXED_FEE | CPA | BONUS | DEDUCTION"），
// 这里把那段注释当作契约来源解析出来 —— 保证脚本跟 schema 同步，而不是另抄一份。

const itemTypeComment = /itemType\s+String[^\n]*?\/\/\s*([A-Z_]+(?:\s*\|\s*[A-Z_]+)+)/.exec(schema);
if (!itemTypeComment) {
  fail(
    '契约缺失',
    'SettlementItem.itemType 的行尾注释里没有找到 "A | B | C" 形式的允许值说明，无法校验 SettlementItemType。',
  );
} else {
  const expected = new Set(itemTypeComment[1].split('|').map((value) => value.trim()));
  const actual = tsUnions.get('SettlementItemType');
  if (!actual) {
    fail('类型缺失', 'SettlementItemType 在 apps/web/src/api/types.ts 中不存在或不是纯字面量联合。');
  } else {
    const { missing, extra } = diffSets(expected, actual);
    if (missing.length > 0) {
      fail('取值漂移', `SettlementItemType 缺少 schema 注释里声明的取值：${missing.join(', ')}`);
    }
    if (extra.length > 0) {
      fail('取值漂移', `SettlementItemType 多出 schema 未声明的取值：${extra.join(', ')}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 检查 4：前端源码里的大写字面量必须是"某个已知取值"
// ---------------------------------------------------------------------------
// 这是唯一能抓住「在页面里直接写 data.status === 'PENDING'」的检查 —— 因为
// 这类字面量不出现在 types.ts 里，前面的比对看不到它。
//
// 判定方式：收集所有已知合法取值（Prisma 全部 enum 成员的并集 + 下面这份显式白名单），
// 再扫 web 源码里的 'ALL_CAPS_LITERAL'，不在集合里的就报出来。

/**
 * 非枚举、但确实合法的全大写字面量。
 *
 * 这里只应该放「前端独有的约定值」和「后端不来自 Prisma/异常类」的常量；
 * 凡是能从后端源码解析出来的（权限点、业务错误码、过滤器错误码），
 * 一律**从源码里解析**，避免把这份清单变成需要手工维护的第二份事实来源。
 */
const ALLOWED_LITERALS = new Map([
  // HTTP / 传输层
  ['GET', 'HTTP 方法'],
  ['POST', 'HTTP 方法'],
  ['PUT', 'HTTP 方法'],
  ['PATCH', 'HTTP 方法'],
  ['DELETE', 'HTTP 方法'],
  // AI Provider 名（后端 config 的 provider key，刻意不落成 Prisma enum）
  ['OPENAI', 'AI Provider 标识'],
  ['ANTHROPIC', 'AI Provider 标识'],
  ['GEMINI', 'AI Provider 标识'],
  ['DEEPSEEK', 'AI Provider 标识'],
  ['MOCK', 'AI Provider 标识（同时也是 DataSourceType 成员）'],
  // 排序 / 通用
  ['ASC', '排序方向'],
  ['DESC', '排序方向'],
  ['JSON', '序列化格式'],
  ['CSV', '导出格式'],
  ['UTF8', '编码'],
  ['CNY', '币种'],
  // 401 兜底错误码：client.ts 在后端没返回 code 时自行补的语义码，不是后端错误码
  ['UNAUTHORIZED', '前端兜底的 401 错误码（client.ts）'],
  // 纯界面文案被误当成字面量：表格列标题 'UID'
  ['UID', '界面文案（达人账号表的列标题），不是枚举值'],
  // 达人机构类型：后端 DTO 用 @IsIn 校验，没有落成 Prisma enum
  ['FULL_MCN', 'AgencyType：后端 @IsIn([FULL_MCN, COMMERCIAL, INDEPENDENT])'],
  ['COMMERCIAL', 'AgencyType：后端 @IsIn([FULL_MCN, COMMERCIAL, INDEPENDENT])'],
  ['INDEPENDENT', 'AgencyType：后端 @IsIn([FULL_MCN, COMMERCIAL, INDEPENDENT])'],
  // 档期：存在 availability Json 列里，取值是前后端约定的字符串
  ['FULL_TIME', 'AvailabilityCommitment：availability JSON 的 commitment 取值'],
  ['PART_TIME', 'AvailabilityCommitment：availability JSON 的 commitment 取值'],
  ['ON_BREAK', 'AvailabilityCommitment：availability JSON 的 commitment 取值'],
]);

const knownLiterals = new Set(ALLOWED_LITERALS.keys());
for (const members of prismaEnums.values()) {
  for (const member of members) knownLiterals.add(member);
}
/**
 * 前端自己在 types.ts 里声明的联合类型，其成员也是合法取值。
 * 其中与 Prisma enum 对应的部分已经被检查 1 强制与后端对齐；
 * 剩下的（DataScope、RiskLevel、ComplianceLevel、SettlementItemType、AuditAction…）
 * 是前端/后端 DTO 层的约定，同样不该在页面里被写错。
 */
const tsUnionMemberCount = [...tsUnions.values()].reduce((sum, members) => sum + members.size, 0);
for (const members of tsUnions.values()) {
  for (const member of members) knownLiterals.add(member);
}

/**
 * 从后端源码解析「机器可读 code」，而不是在前端脚本里再抄一份：
 *   - common/exceptions/business.exception.ts 的 `super('CODE', ...)`
 *   - common/filters/all-exceptions.filter.ts 的 `code: 'CODE'`
 *   - modules/auth/permissions.ts 的权限点字符串（'creator:read'）
 * 这样后端新增错误码/权限点时，这个脚本自动跟上，不需要改。
 */
function harvestCodes(filePath, patterns, label) {
  if (!existsSync(filePath)) {
    notes.push(`提示 未找到 ${relative(root, filePath)}，跳过${label}提取`);
    return 0;
  }
  const source = readFileSync(filePath, 'utf8');
  let count = 0;
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      knownLiterals.add(match[1]);
      count += 1;
    }
  }
  return count;
}

const harvested = {
  businessCodes: harvestCodes(
    resolve(root, 'apps/api/src/common/exceptions/business.exception.ts'),
    [/super\(\s*'([A-Z_]+)'/g],
    '业务错误码',
  ),
  filterCodes: harvestCodes(
    resolve(root, 'apps/api/src/common/filters/all-exceptions.filter.ts'),
    [/code:\s*'([A-Z_]+)'/g],
    '过滤器错误码',
  ),
  // 校验管道的 exceptionFactory 也会产出错误码（VALIDATION_FAILED），
  // 它写在 bootstrap.ts 里。漏掉这个文件会让脚本误报自己的错误码 —— 这确实发生过一次。
  bootstrapCodes: harvestCodes(
    resolve(root, 'apps/api/src/bootstrap.ts'),
    [/code:\s*'([A-Z_]+)'/g],
    'bootstrap 错误码',
  ),
  permissions: harvestCodes(
    resolve(root, 'apps/api/src/modules/auth/permissions.ts'),
    [/'([a-z_]+:[a-z_]+)'/g],
    '权限点',
  ),
};

if (verbose) {
  notes.push(
    `从后端源码提取：业务错误码 ${harvested.businessCodes} 个、` +
      `过滤器错误码 ${harvested.filterCodes} 个、` +
      `bootstrap 错误码 ${harvested.bootstrapCodes} 个、` +
      `权限点 ${harvested.permissions} 个`,
  );
}

/** 有些常量表会把「后端可能返回、但前端只做兜底」的值也写进来，这里显式登记并说明理由。 */
const EXTRA_KNOWN = [
  // 前端用于 <select> 默认值的空串等非枚举占位
];

function* walkSourceFiles(directory) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      yield* walkSourceFiles(full);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

/**
 * 去掉注释，只保留代码 —— 本检查必须**忽略注释**。
 *
 * 原因：代码注释里经常**故意**写出错误的历史取值来做说明
 * （例如「早期这里写的是 'PENDING'，后端其实是 'QUEUED'」）。
 * 如果不跳过注释，这些说明本身会被报成漂移，逼着人把有价值的注释删掉，
 * 或者把错误值加进白名单 —— 两种结果都比不检查更糟。
 *
 * 实现上不能简单地正则替换 `//`：字符串里的 `https://...` 会被误伤，
 * 从而把同一行后面的真实字面量一起吞掉。所以这里做一次最小状态机扫描：
 * 跟踪「普通代码 / 单引号 / 双引号 / 模板串 / 行注释 / 块注释」，
 * 只把注释部分替换成空格（保留换行，行号才不会错位）。
 */
function stripComments(source) {
  const out = source.split('');
  let state = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line';
        out[index] = ' ';
        out[index + 1] = ' ';
        index += 1;
      } else if (char === '/' && next === '*') {
        state = 'block';
        out[index] = ' ';
        out[index + 1] = ' ';
        index += 1;
      } else if (char === "'") {
        state = 'single';
      } else if (char === '"') {
        state = 'double';
      } else if (char === '`') {
        state = 'template';
      }
      continue;
    }

    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
      } else {
        out[index] = ' ';
      }
      continue;
    }

    if (state === 'block') {
      if (char === '*' && next === '/') {
        out[index] = ' ';
        out[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (char !== '\n') {
        out[index] = ' ';
      }
      continue;
    }

    // 字符串状态：只关心转义与闭合
    if (char === '\\') {
      index += 1; // 跳过被转义的下一个字符
      continue;
    }
    if (
      (state === 'single' && char === "'") ||
      (state === 'double' && char === '"') ||
      (state === 'template' && char === '`')
    ) {
      state = 'code';
    }
  }
  return out.join('');
}

for (const extra of EXTRA_KNOWN) knownLiterals.add(extra);

/**
 * 只报「看起来像状态值」的字面量：全大写、可含下划线和数字，长度 ≥ 3。
 *
 * ⚠️ 下划线必须是**可选**的。第一版把正则写成 `[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+`，
 * 强制要求至少一个下划线，结果 AiTaskStatus 那次的 `'PENDING'` / `'FALLBACK'`
 * 两个单词型取值全被漏掉 —— 而它们正是最典型的事故值。
 * 这个漏洞是 --self-test 里的「剥注释后仍能扫到真实代码里的字面量」用例发现的。
 *
 * 长度下限 3 用来滤掉 'ID'、'OK'、'A' 这类噪声；单字母枚举（CreatorTier）本来也不是问题源。
 * 含冒号/小写的（权限点、CSS、i18n key）不匹配。
 */
const SUSPECT_LITERAL = /'([A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)*)'/g;

/** 这些字面量出现过但不属于任何枚举，逐个说明为什么合法；有新的就在这里补理由。 */
const UNKNOWN_ALLOWLIST = new Map([
  ['IDEMPOTENCY_KEY', 'HTTP 请求头名'],
  ['CONTENT_TYPE', 'HTTP 请求头名'],
  ['APPLICATION_JSON', 'HTTP Content-Type 值'],
  ['X_REQUEST_ID', 'HTTP 请求头名'],
]);

const unknownLiterals = new Map();
for (const file of walkSourceFiles(webSrcRoot)) {
  // 必须先剥掉注释：注释里会故意写出错误的历史取值做说明，不该被判为漂移
  const source = stripComments(readFileSync(file, 'utf8'));
  for (const match of source.matchAll(SUSPECT_LITERAL)) {
    const literal = match[1];
    if (knownLiterals.has(literal) || UNKNOWN_ALLOWLIST.has(literal)) continue;
    // 出现位置的行号，方便直接定位
    const line = source.slice(0, match.index).split('\n').length;
    const key = literal;
    if (!unknownLiterals.has(key)) unknownLiterals.set(key, []);
    unknownLiterals.get(key).push(`${relative(root, file)}:${line}`);
  }
}

for (const [literal, locations] of unknownLiterals) {
  fail(
    '未知字面量',
    `前端源码里出现 '${literal}'，它不是任何 Prisma enum 的成员、也不在允许清单里。` +
      `如果这是状态值，它永远不会和后端匹配（应改为后端真实取值）；如果合法，请在 scripts/check-enum-drift.mjs 的 UNKNOWN_ALLOWLIST 里登记理由。` +
      `出现位置：${locations.slice(0, 5).join(', ')}${locations.length > 5 ? ` 等 ${locations.length} 处` : ''}`,
  );
}

// ---------------------------------------------------------------------------
// 自检：node scripts/check-enum-drift.mjs --self-test
// ---------------------------------------------------------------------------
// 校验「校验脚本本身」还能抓得住问题。
// 一个因为正则写坏、文件路径变化或逻辑短路而永远输出"通过"的检查脚本，
// 比没有检查更危险 —— 它会让人以为有保障。所以这里用构造数据反向验证。

if (process.argv.includes('--self-test')) {
  const cases = [];
  const set = (...members) => new Set(members);
  const expectPass = (name, run) => cases.push({ name, run, shouldFail: false });
  const expectFail = (name, run) => cases.push({ name, run, shouldFail: true });

  // 1) 完全一致 → 不应报错
  expectPass('一致的枚举不报错', () =>
    compareEnumSets('ContractStatus', 'ContractStatus', set('DRAFT', 'ACTIVE'), set('DRAFT', 'ACTIVE')),
  );

  // 2) 前端多出后端没有的值（APPROVED/REJECTED 那次事故）
  expectFail('前端多出取值（ContractStatus 多了 APPROVED）', () =>
    compareEnumSets(
      'ContractStatus',
      'ContractStatus',
      set('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'EXPIRED', 'TERMINATED'),
      set('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ACTIVE', 'EXPIRED', 'TERMINATED'),
    ),
  );

  // 3) 前端缺少后端存在的值（DataSourceType 少了 MOCK）
  expectFail('前端缺少取值（DataSource 少了 MOCK）', () =>
    compareEnumSets(
      'DataSource',
      'DataSourceType',
      set('API_OFFICIAL', 'THIRD_PARTY', 'SCREENSHOT', 'MANUAL', 'MOCK'),
      set('API_OFFICIAL', 'THIRD_PARTY', 'SCREENSHOT', 'MANUAL'),
    ),
  );

  // 4) 拼写差异（CANCELED vs CANCELLED）必须被发现
  expectFail('拼写差异（CANCELED vs CANCELLED）', () =>
    compareEnumSets('ProjectStatus', 'ProjectStatus', set('CANCELED'), set('CANCELLED')),
  );

  // 5) 注释剥离：注释里的错误取值不能被当成漂移
  const commentedSource = [
    "// 早期这里写的是 'PENDING' 和 'FALLBACK'，后端其实是 'QUEUED' / 'FALLBACK_USED'",
    "/* 另一个错误示例：'CANCELLED'（后端是单 L 的 CANCELED） */",
    "const real = 'QUEUED';",
    "const url = 'https://example.com/PENDING'; // URL 里的值不该被误伤",
    "const afterUrl = 'STATE_CONFLICT';",
  ].join('\n');
  const stripped = stripComments(commentedSource);
  expectPass('注释里的错误取值被忽略', () => {
    const found = [...stripped.matchAll(SUSPECT_LITERAL)].map((match) => match[1]);
    const commentLeaks = found.filter((literal) =>
      ['PENDING', 'FALLBACK', 'CANCELLED'].includes(literal),
    );
    return commentLeaks.length === 0
      ? []
      : [`注释里的取值泄漏进了扫描结果：${commentLeaks.join(', ')}`];
  });
  expectPass('剥注释后仍能扫到真实代码里的字面量', () => {
    const found = [...stripped.matchAll(SUSPECT_LITERAL)].map((match) => match[1]);
    const missing = ['QUEUED', 'STATE_CONFLICT'].filter((literal) => !found.includes(literal));
    return missing.length === 0 ? [] : [`丢失了真实字面量：${missing.join(', ')}`];
  });

  // 6) 联合类型解析：只有纯字面量联合才算枚举，混合类型要跳过
  expectPass('纯字面量联合可被解析', () => {
    const parsed = parseUnionTypes("export type A = 'X' | 'Y';");
    return parsed.get('A')?.size === 2 ? [] : ['未能解析 export type A = X | Y'];
  });
  expectPass('混合字面量联合被跳过（HumanFeedback = 1 | -1）', () => {
    const parsed = parseUnionTypes("export type HumanFeedback = 1 | -1;");
    return parsed.has('HumanFeedback') ? ['混合联合被误判为枚举'] : [];
  });
  expectPass('含注释的多行联合可被解析', () => {
    const parsed = parseUnionTypes(
      "export type B =\n  // 说明\n  | 'P'\n  | 'Q';\n",
    );
    return parsed.get('B')?.size === 2 ? [] : ['未能解析带注释的多行联合'];
  });

  // 7) 标签映射解析
  expectPass('标签映射键可被解析', () => {
    const maps = parseLabelMaps("export const X_LABELS: Record<A, string> = {\n  P: '甲',\n  Q: '乙',\n};");
    const keys = maps[0]?.keys;
    return keys && keys.has('P') && keys.has('Q') ? [] : ['未能解析标签映射的键'];
  });

  // 8) schema 解析必须真的读到了枚举（防止路径/正则失效后静默通过）
  expectPass('schema 解析到全部 15 个枚举', () => {
    const expected = 15;
    return prismaEnums.size === expected
      ? []
      : [`从 schema.prisma 解析到 ${prismaEnums.size} 个 enum，期望 ${expected} 个（正则或文件已变化）`];
  });

  let failed = 0;
  for (const testCase of cases) {
    let messages;
    try {
      messages = testCase.run() ?? [];
    } catch (error) {
      messages = [`抛出异常：${error.message}`];
    }
    const detected = messages.length > 0;
    const ok = testCase.shouldFail ? detected : !detected;
    if (!ok) failed += 1;
    const mark = ok ? '通过' : '失败';
    console.log(`[self-test] ${mark}  ${testCase.name}`);
    if (!ok) {
      console.log(`            期望${testCase.shouldFail ? '报错' : '不报错'}，实际${detected ? '报错' : '未报错'}`);
      for (const message of messages) console.log(`            ${message}`);
    }
  }
  console.log(`\n[self-test] ${cases.length - failed}/${cases.length} 通过`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

if (verbose && notes.length > 0) {
  console.log('--- 说明 ---');
  for (const note of notes) console.log(`  ${note}`);
  console.log('');
}

if (problems.length === 0) {
  console.log(
    `[enum-drift] 通过：${prismaEnums.size} 个 Prisma enum 与前端类型/标签映射一致，未发现可疑字面量。`,
  );
  process.exit(0);
}

console.error(`[enum-drift] 发现 ${problems.length} 处前后端枚举漂移：\n`);
const grouped = new Map();
for (const problem of problems) {
  if (!grouped.has(problem.check)) grouped.set(problem.check, []);
  grouped.get(problem.check).push(problem.message);
}
for (const [check, messages] of grouped) {
  console.error(`【${check}】`);
  for (const message of messages) console.error(`  - ${message}`);
  console.error('');
}
console.error('修复方式：以 apps/api/prisma/schema.prisma 为准，同步 apps/web/src/api/types.ts 与 src/utils/constants.ts。');
process.exit(1);
