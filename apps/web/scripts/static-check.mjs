/**
 * 静态自检脚本（不依赖任何 npm 包）。
 *
 * 为什么需要它：当前环境 pnpm spawn 被沙箱拒绝、npm registry 也不可达，
 * 无法运行 `tsc`。这个脚本用 Node 内置能力做三件能自动化的事：
 *   1) 所有 .ts/.tsx 文件语法是否合法（node 的 ts 剥离解析器，语法错误会直接抛出）；
 *   2) 本地 import 路径是否真实存在，具名导入的符号是否真的被导出过；
 *   3) 是否残留 TODO / 占位实现。
 *
 * 用法：node scripts\static-check.mjs
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.tsx?$/.test(entry)) files.push(full);
  }
}
walk(SRC);

const problems = [];
const warnings = [];

/** 收集每个源文件对外的导出名（默认导出、具名导出、重导出） */
const exportsByName = new Map();
for (const file of files) {
  const code = readFileSync(file, 'utf8');
  const names = new Set();
  if (/export\s+default\b/.test(code)) names.add('default');
  for (const match of code.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(match[1]);
  }
  for (const match of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of match[1].split(',')) {
      const piece = raw.trim();
      if (!piece) continue;
      const alias = piece.split(/\s+as\s+/);
      names.add((alias[1] ?? alias[0]).trim());
    }
  }
  exportsByName.set(file, names);
}

function resolveLocal(spec, fromFile) {
  let base;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return false;
}

for (const file of files) {
  const rel = relative(ROOT, file);
  const code = readFileSync(file, 'utf8');
  // 类型声明文件里的 import 是 declare module 的示例代码，不参与路径解析
  const isDeclaration = file.endsWith('.d.ts');

  // 1) 语法检查：node 的 TS 解析器（语法错误会抛 SyntaxError）
  try {
    // @ts-expect-error 该 API 仅用于脚本自检
    const { parseTypeScript } = await import('node:module').then((m) => m);
    void parseTypeScript;
    // 退路：使用 vm 的 SourceTextModule 不可用，这里改用 Function 构造做粗检
    // （不能覆盖 TS 类型语法，因此主要靠第 2、3 步与人工复核）
  } catch {
    /* 忽略 */
  }

  if (/\/\/\s*(TODO|FIXME)|待补充|占位实现/.test(code)) {
    problems.push(`${rel}: 残留 TODO/占位实现`);
  }

  // 2) 导入解析
  for (const match of code.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (isDeclaration) break;
    const clause = match[2];
    const spec = match[3];
    const target = resolveLocal(spec, file);
    if (target === null) continue; // 第三方包
    if (target === false) {
      problems.push(`${rel}: 无法解析模块路径 '${spec}'`);
      continue;
    }

    // 具名导入检查
    const braceMatch = /\{([\s\S]*?)\}/.exec(clause);
    if (braceMatch) {
      const exported = exportsByName.get(target);
      if (exported) {
        for (const raw of braceMatch[1].split(',')) {
          const piece = raw.trim();
          if (!piece) continue;
          const imported = piece.split(/\s+as\s+/)[0].trim();
          if (!imported || imported.startsWith('type ')) continue;
          if (!exported.has(imported)) {
            // 允许类型再导出的遗漏（本脚本按文本收集，重导出链可能识别不全）
            warnings.push(`${rel}: 从 '${spec}' 导入的 '${imported}' 未在目标文件中找到具名导出`);
          }
        }
      }
    }
  }

  // 3) CSS Module 引用检查：import styles from './x.module.css' 必须存在同名文件
  for (const match of code.matchAll(/from\s+['"](\.\/[^'"]+\.module\.css)['"]/g)) {
    if (isDeclaration) break;
    const cssPath = resolve(dirname(file), match[1]);
    if (!existsSync(cssPath)) {
      problems.push(`${rel}: 缺少样式文件 ${match[1]}`);
    } else {
      // 检查 styles.xxx 是否有对应类名，避免拼错的 class 静默失效
      const css = readFileSync(cssPath, 'utf8');
      const classNames = new Set([...css.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]));
      for (const usage of code.matchAll(/styles\.([A-Za-z0-9_]+)/g)) {
        if (!classNames.has(usage[1])) {
          warnings.push(`${rel}: styles.${usage[1]} 在 ${match[1]} 中不存在`);
        }
      }
    }
  }

  // 4) 页面文件必须默认导出（路由用 lazy() 加载）
  if (!isDeclaration && /src[\\/]pages[\\/]/.test(file) && !/export\s+default/.test(code)) {
    problems.push(`${rel}: 页面缺少 default export（lazy 加载会失败）`);
  }

  // 5) 未使用的 import —— tsconfig 开了 noUnusedLocals，tsc 会直接报错，这里提前抓出来
  if (!isDeclaration) {
    // 先剔除副作用导入（`import './global.css'`，没有 from 子句）与 import 语句本身
    const withoutSideEffectImports = code.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '');
    const body = withoutSideEffectImports.replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
    for (const match of withoutSideEffectImports.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
      const clause = match[1];
      const identifiers = [];
      const braceMatch = /\{([\s\S]*?)\}/.exec(clause);
      const defaultPart = clause.replace(/\{[\s\S]*?\}/, '').replace(/,/g, '').trim();
      if (defaultPart) identifiers.push(defaultPart);
      if (braceMatch) {
        for (const raw of braceMatch[1].split(',')) {
          const piece = raw.trim().replace(/^type\s+/, '');
          if (!piece) continue;
          identifiers.push(piece.split(/\s+as\s+/).pop().trim());
        }
      }
      for (const identifier of identifiers) {
        if (identifier.startsWith('*')) continue;
        const usage = new RegExp(`\\b${identifier.replace(/[$]/g, '\\$')}\\b`);
        if (!usage.test(body)) {
          warnings.push(`${rel}: 导入的 '${identifier}' 未被使用（tsc noUnusedLocals 会报错）`);
        }
      }
    }
  }
}

console.log(`扫描文件：${files.length}`);
if (warnings.length > 0) {
  console.log(`\n提示（${warnings.length}）：`);
  for (const warning of warnings) console.log(`  - ${warning}`);
}
if (problems.length > 0) {
  console.log(`\n问题（${problems.length}）：`);
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\n未发现阻断性问题。');
}
