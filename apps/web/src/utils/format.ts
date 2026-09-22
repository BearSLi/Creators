/**
 * 展示层格式化工具。
 *
 * 核心约束：金额与比率的**原始值永远是后端给的字符串/整数**，这里只做"变成人看的字"，
 * 从不做四则运算后回写。金融数据一旦在前端算过，就会出现"界面 9999.99 后端 10000.00"的对账事故。
 */

/* ---------------- 金额（字符串元） ---------------- */

const moneyFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const integerFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });

/**
 * 字符串元 → 千分位两位小数。不做 Math.round 之外的处理，也不参与计算。
 * 传空值时返回占位符而不是 '0.00'：0 元和"没有数据"在业务上是两件事。
 */
export function formatMoney(value: string | number | null | undefined, placeholder = '—'): string {
  if (value === null || value === undefined || value === '') return placeholder;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(numeric)) return placeholder;
  return moneyFormatter.format(numeric);
}

/** 带 ¥ 前缀的金额展示 */
export function formatYuan(value: string | number | null | undefined, placeholder = '—'): string {
  const text = formatMoney(value, placeholder);
  return text === placeholder ? placeholder : `¥${text}`;
}

/** 大额压缩展示：看板 KPI 卡片用，12.35 万 / 1.20 亿 */
export function formatMoneyCompact(value: string | number | null | undefined, placeholder = '—'): string {
  if (value === null || value === undefined || value === '') return placeholder;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(numeric)) return placeholder;
  const absolute = Math.abs(numeric);
  if (absolute >= 100_000_000) return `${(numeric / 100_000_000).toFixed(2)} 亿`;
  if (absolute >= 10_000) return `${(numeric / 10_000).toFixed(2)} 万`;
  return moneyFormatter.format(numeric);
}

/** 判断是否大额：结算列表用它决定是否高亮，阈值统一走 constants */
export function isNegativeMoney(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false;
  return Number(value) < 0;
}

/* ---------------- 比率 ---------------- */

/**
 * 基点 → 百分比文本。后端 1000 表示 10%。
 * 尾随 0 去掉（10% 而不是 10.00%），但保留小数以避免 6.5% 被显示成 6%。
 */
export function formatBp(bp: number | null | undefined, placeholder = '—'): string {
  if (bp === null || bp === undefined || Number.isNaN(bp)) return placeholder;
  return `${formatPercentValue(bp / 100)}`;
}

/** 已经是百分数的数值（如 engagementRate 12.5）→ '12.5%' */
export function formatPercentValue(value: number | null | undefined, placeholder = '—'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return placeholder;
  const rounded = Math.round(value * 100) / 100;
  return `${rounded}%`;
}

/** 已带百分号的数值（如 avgEngagementRate） */
export function formatPercent(value: number | null | undefined, placeholder = '—'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return placeholder;
  return `${Math.round(value * 100) / 100}%`;
}

/** 环比/同比增量：带正负号，KPI 卡片据此决定箭头方向与颜色 */
export function formatDelta(value: number | null | undefined, placeholder = '—'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return placeholder;
  const rounded = Math.round(value * 100) / 100;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded}%`;
}

/* ---------------- 数值与互动量 ---------------- */

/** 播放/点赞等大数：12345 → 1.23 万；用于表格列，避免长数字撑破列宽 */
export function formatCount(value: string | number | null | undefined, placeholder = '—'): string {
  if (value === null || value === undefined || value === '') return placeholder;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(numeric)) return placeholder;
  if (Math.abs(numeric) >= 100_000_000) return `${(numeric / 100_000_000).toFixed(2)} 亿`;
  if (Math.abs(numeric) >= 10_000) return `${(numeric / 10_000).toFixed(2)} 万`;
  return integerFormatter.format(numeric);
}

/** 精确数字（ID、条数）用千分位，不做万/亿压缩 */
export function formatInteger(value: number | string | null | undefined, placeholder = '—'): string {
  if (value === null || value === undefined || value === '') return placeholder;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(numeric)) return placeholder;
  return integerFormatter.format(numeric);
}

/** 粉丝量：列表里常用「万粉」表述，空值给 — 而不是 0 */
export function formatFollowers(value: number | null | undefined, placeholder = '—'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return placeholder;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return integerFormatter.format(value);
}

/** token / 毫秒等小数值直接千分位 */
export function formatMs(value: number | null | undefined, placeholder = '—'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return placeholder;
  return `${integerFormatter.format(value)} ms`;
}

/** 分 → 元展示（AI 成本字段是 costCents） */
export function formatCents(cents: number | null | undefined, placeholder = '—'): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return placeholder;
  return `¥${moneyFormatter.format(cents / 100)}`;
}

/* ---------------- 日期时间 ---------------- */

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** yyyy-MM-dd */
export function formatDate(value: string | number | Date | null | undefined, placeholder = '—'): string {
  const date = toDate(value);
  if (!date) return placeholder;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** yyyy-MM-dd HH:mm */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  placeholder = '—',
): string {
  const date = toDate(value);
  if (!date) return placeholder;
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 相对时间：审计日志与操作记录里"3 分钟前"比绝对时间更易读 */
export function formatRelative(value: string | number | Date | null | undefined, placeholder = '—'): string {
  const date = toDate(value);
  if (!date) return placeholder;
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} 天前`;
  return formatDate(date);
}

/** 今天往前/往后 n 天的 ISO 日期，看板默认区间与账期筛选大量使用 */
export function shiftDays(days: number, base: Date = new Date()): string {
  const date = new Date(base.getTime());
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

/** 当月第一天 / 最后一天：结算账期默认值 */
export function currentMonthRange(base: Date = new Date()): { start: string; end: string } {
  const start = new Date(base.getFullYear(), base.getMonth(), 1);
  const end = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  return { start: formatDate(start), end: formatDate(end) };
}

/** 上个月账期：财务通常在次月结算上月流水 */
export function previousMonthRange(base: Date = new Date()): { start: string; end: string } {
  const prev = new Date(base.getFullYear(), base.getMonth() - 1, 1);
  return currentMonthRange(prev);
}

/** 距今已逾期天数（正数表示已逾期），结算列表用来标红 */
export function overdueDays(dueDate: string | null | undefined): number | null {
  const date = toDate(dueDate);
  if (!date) return null;
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.floor((startOfToday.getTime() - date.getTime()) / 86_400_000);
  return diff > 0 ? diff : null;
}

/* ---------------- 其他展示辅助 ---------------- */

/** 脱敏兜底：后端理论上已脱敏，前端再做一层展示保护，避免明细列漏出完整手机号 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  if (phone.length !== 11) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(7)}`;
}

/** 姓名脱敏：列表里非授权用户看到 "张*" */
export function maskName(name: string | null | undefined): string {
  if (!name) return '—';
  if (name.length <= 1) return name;
  return `${name.slice(0, 1)}${'*'.repeat(Math.min(name.length - 1, 2))}`;
}

/** 数字评分（0~100）保留一位小数 */
export function formatScore(score: number | null | undefined, placeholder = '—'): string {
  if (score === null || score === undefined || Number.isNaN(score)) return placeholder;
  return (Math.round(score * 10) / 10).toFixed(1);
}

/** 文件大小：导出/附件提示用 */
export function formatBytes(bytes: number | null | undefined, placeholder = '—'): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return placeholder;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 触发浏览器下载。
 * 结算导出返回的是 CSV 文件流，必须用 blob URL 落地，不能走 a.href = '/api/...'，
 * 否则浏览器不会带上 Authorization 头，后端会直接 401。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // 立即回收会打断部分浏览器的下载，延迟释放更稳
  window.setTimeout(() => window.URL.revokeObjectURL(url), 2000);
}

/** 从 Content-Disposition 里解析后端指定的文件名（含中文时是 filename* 形式） */
export function parseFilename(contentDisposition: string | undefined, fallback: string): string {
  if (!contentDisposition) return fallback;
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1]);
  const plainMatch = /filename="?([^";]+)"?/i.exec(contentDisposition);
  if (plainMatch?.[1]) return plainMatch[1];
  return fallback;
}

/** 生成幂等键：AI 调用与结算生成必须带，避免网络重试造成重复计费/重复建单 */
export function createIdempotencyKey(prefix = 'web'): string {
  // crypto.randomUUID 在非安全上下文（http 局域网访问）下可能不存在，做降级
  const cryptoRef = globalThis.crypto;
  const uuid =
    cryptoRef && typeof cryptoRef.randomUUID === 'function'
      ? cryptoRef.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  return `${prefix}-${uuid}`;
}
