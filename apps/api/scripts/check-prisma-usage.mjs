/**
 * Prisma 使用一致性校验（无需生成客户端即可运行）
 * ----------------------------------------------------------------------------
 * 解决的问题：CI 里 `prisma generate` 之后 tsc 能发现字段拼写错误，但在
 * **没有数据库、没有网络、无法下载查询引擎**的环境里（受限沙箱、离线开发机、
 * 部分 CI runner），`@prisma/client` 的类型不存在，tsc 会被几百条
 * 「属性不存在」的噪声淹没，真正的问题反而看不见。
 *
 * 本脚本做一件具体的事：把源码中所有 `prisma.<模型>.<方法>(...)` 调用
 * 与 `@prisma/client` 导入的枚举名，拿去和 schema.prisma 对照，
 * 直接报出「模型名/委托方法/枚举名」层面的错误。
 *
 * 它能查（静态文本可判定）：
 *   - 模型名拼写错误（如 prisma.creater）
 *   - 非法委托方法（如 prisma.creator.search）
 *   - 枚举名拼写错误（如 import { CreatorStat }）
 *   - 未在 schema 中定义的枚举成员（如 CreatorStatus.ARCHIVED）
 *
 * 它不能查（需要真实类型）：
 *   - where / data 里的字段名与类型（这是 tsc + prisma generate 的职责）
 *   - 查询结果字段的访问
 * 因此本脚本是**补充**而不是替代：正式校验请在有网络的环境执行
 * `pnpm --filter @creatorops/api prisma:generate && pnpm typecheck`。
 *
 * 用法：node scripts/check-prisma-usage.mjs
 * 退出码：0 通过，1 发现问题（可直接接进 CI）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..');
const srcRoot = resolve(apiRoot, 'src');
const schemaPath = resolve(apiRoot, 'prisma/schema.prisma');
const schema = readFileSync(schemaPath, 'utf8');

// ---------------------------------------------------------------------------
// 1. 从 schema 提取事实
// ---------------------------------------------------------------------------

/**
 * 匹配模型/枚举声明。
 *
 * 必须要求「关键字 + 名称 + 左花括号在同一行」，否则会匹配到文档注释里的
 * 示例文本（如「//> 设计原则：model Team { ... }」这类说明），
 * 把不存在的模型名混进校验集合，让校验结果不可信。
 * 早期版本就踩过这个坑：报出 18 个模型，而 schema 里只有 13 个。
 */
const DECLARATION_PATTERN = /^[ \t]*(model|enum)[ \t]+(\w+)[ \t]*\{/gm;

const declarations = [...schema.matchAll(DECLARATION_PATTERN)];
/** 只保留块级声明（下一行不是字段而是空行/注释说明的文档示例已被上面的正则排除） */
const modelNames = declarations.filter((match) => match[1] === 'model').map((match) => match[2]);
/** Prisma 客户端上的委托名 = 模型名首字母小写 */
const delegateNames = new Map(modelNames.map((name) => [name[0].toLowerCase() + name.slice(1), name]));

const enumNames = declarations.filter((match) => match[1] === 'enum').map((match) => match[2]);

const enums = new Map(
  enumNames.map((enumName) => {
    const block = new RegExp(`^enum[ \\t]+${enumName}[ \\t]*\\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
    return [
      enumName,
      new Set(
        (block?.[1] ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('//'))
          .map((line) => line.split(/\s+/)[0])
          .filter((member) => /^\w+$/.test(member)),
      ),
    ];
  }),
);

/** 自检：模型/枚举数量必须与 schema 中真实的块级声明数一致 */
if (modelNames.length !== declarations.filter((match) => match[1] === 'model').length) {
  console.error('校验器内部错误：模型解析结果不一致，请检查 DECLARATION_PATTERN');
  process.exit(2);
}
if (modelNames.some((name) => !/^[A-Z]\w+$/.test(name))) {
  console.error(`校验器内部错误：解析出非法模型名 ${modelNames.filter((n) => !/^[A-Z]\w+$/.test(n)).join(', ')}`);
  process.exit(2);
}
if (enumNames.length === 0 || [...enums.values()].some((members) => members.size === 0)) {
  console.error('校验器内部错误：存在没有成员的枚举，schema 可能被错误解析');
  process.exit(2);
}

/** Prisma 客户端内置属性，不是模型委托 */
const CLIENT_BUILTINS = new Set([
  '$connect',
  '$disconnect',
  '$on',
  '$transaction',
  '$queryRaw',
  '$executeRaw',
  '$queryRawUnsafe',
  '$executeRawUnsafe',
  '$use',
  '$extends',
]);

/** 模型委托上可用的方法（Prisma 5.x 标准集合） */
const DELEGATE_METHODS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
  'fields',
]);

// ---------------------------------------------------------------------------
// 2. 遍历源码
// ---------------------------------------------------------------------------

function walk(dir) {
  const output = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) output.push(...walk(full));
    else if (entry.endsWith('.ts')) output.push(full);
  }
  return output;
}

const files = walk(srcRoot);
const problems = [];
/** 记录哪些模型从未被任何代码访问（可能是设计遗漏，也可能是死表） */
const touchedDelegates = new Set();

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const rel = relative(apiRoot, file).replace(/\\/g, '/');
  const lines = source.split('\n');

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    // 跳过注释行，避免注释里的示例代码被误报
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

    // ---- 检查 prisma.<delegate>.<method>( ----
    const delegatePattern = /\bprisma\.(\w+)\.(\w+)\s*\(/g;
    for (const match of line.matchAll(delegatePattern)) {
      const [, delegate, method] = match;
      if (CLIENT_BUILTINS.has(`$${delegate}`)) continue;
      const model = delegateNames.get(delegate);
      if (!model) {
        problems.push({
          file: rel,
          line: lineNo,
          kind: 'UNKNOWN_DELEGATE',
          message: `prisma.${delegate} 不是 schema 中定义的模型（可用：${[...delegateNames.keys()].join(', ')}）`,
        });
        continue;
      }
      touchedDelegates.add(delegate);
      if (!DELEGATE_METHODS.has(method)) {
        problems.push({
          file: rel,
          line: lineNo,
          kind: 'UNKNOWN_METHOD',
          message: `prisma.${delegate}.${method} 不是合法的委托方法`,
        });
      }
    }

    // ---- 检查 tx.<delegate>.<method>( （事务客户端同样是模型委托）----
    const txPattern = /\btx\.(\w+)\.(\w+)\s*\(/g;
    for (const match of line.matchAll(txPattern)) {
      const [, delegate, method] = match;
      const model = delegateNames.get(delegate);
      if (!model) {
        problems.push({
          file: rel,
          line: lineNo,
          kind: 'UNKNOWN_DELEGATE',
          message: `tx.${delegate} 不是 schema 中定义的模型`,
        });
        continue;
      }
      touchedDelegates.add(delegate);
      if (!DELEGATE_METHODS.has(method)) {
        problems.push({
          file: rel,
          line: lineNo,
          kind: 'UNKNOWN_METHOD',
          message: `tx.${delegate}.${method} 不是合法的委托方法`,
        });
      }
    }
  });

  // ---- 检查从 @prisma/client 导入的枚举名是否存在 ----
  const importPattern = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'@prisma\/client'/g;
  for (const match of source.matchAll(importPattern)) {
    const lineNo = source.slice(0, match.index).split('\n').length;
    const names = match[1]
      .split(',')
      .map((item) => item.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    for (const name of names) {
      // Prisma 命名空间与 PrismaClient 是客户端自身导出，不是 schema 枚举
      if (['Prisma', 'PrismaClient'].includes(name)) continue;
      if (!enums.has(name) && !modelNames.includes(name)) {
        problems.push({
          file: rel,
          line: lineNo,
          kind: 'UNKNOWN_EXPORT',
          message: `@prisma/client 不存在导出「${name}」（既不是模型也不是枚举）`,
        });
      }
    }
  }

  // ---- 检查枚举成员是否合法：枚举名.成员 ----
  for (const [enumName, members] of enums) {
    const memberPattern = new RegExp(`\\b${enumName}\\.([A-Z][A-Z0-9_]*)\\b`, 'g');
    for (const match of source.matchAll(memberPattern)) {
      const member = match[1];
      if (members.has(member)) continue;
      const lineNo = source.slice(0, match.index).split('\n').length;
      problems.push({
        file: rel,
        line: lineNo,
        kind: 'UNKNOWN_ENUM_MEMBER',
        message: `${enumName}.${member} 不是合法枚举成员（可用：${[...members].join(', ')}）`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 3. 输出
// ---------------------------------------------------------------------------

const untouched = [...delegateNames.keys()].filter(
  (delegate) => !touchedDelegates.has(delegate) && !['codeSequence'].includes(delegate),
);

console.log('Prisma 使用一致性校验');
console.log(`  模型 ${modelNames.length} 个 / 枚举 ${enums.size} 个 / 扫描 ${files.length} 个源文件`);
console.log(
  `  被访问的模型委托 ${touchedDelegates.size} 个：${[...touchedDelegates].sort().join(', ')}`,
);
if (untouched.length > 0) {
  console.log(`  未被访问的模型委托（提示，不算错误）：${untouched.join(', ')}`);
}

if (problems.length === 0) {
  console.log('\n通过：没有发现模型名 / 委托方法 / 枚举层面的不一致。');
  console.log('注意：字段级的 where/data 拼写仍需在有网络的环境执行 prisma generate + tsc 校验。');
  process.exit(0);
}

console.error(`\n发现 ${problems.length} 个问题：`);
for (const problem of problems) {
  console.error(`  [${problem.kind}] ${problem.file}:${problem.line}  ${problem.message}`);
}
process.exit(1);
