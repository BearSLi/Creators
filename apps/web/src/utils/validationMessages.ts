/**
 * 把 class-validator 的英文默认消息转成中文。
 *
 * ## 为什么需要
 *
 * DTO 里只有**部分**字段写了自定义中文 `message`（如「结算模式非法」「预算格式不正确」），
 * 其余走 class-validator 默认英文：
 *
 * ```
 * vertical must be one of the following values: SHORT_DRAMA, LIFESTYLE, …
 * brandId must be a UUID
 * projectId must be a UUID
 * property status should not exist
 * ```
 *
 * 一个全中文的后台里弹出这些句子，用户虽然终于知道「是哪个字段」了，
 * 但仍然读不懂「错在哪、该填什么」。所以在这里做一层展示层翻译。
 *
 * ## 设计原则
 *
 * 1. **只翻译，不解释业务**：不猜测意图，只把句式换成中文；
 * 2. **绝不丢信息**：任何不匹配的句子原样返回。宁可显示英文，
 *    也不能因为翻译规则没覆盖就变成「校验失败」这种没有信息量的兜底；
 * 3. **保留字段名与合法取值**：`must be one of the following values: A, B`
 *    会把 A、B 完整列出 —— 那恰恰是用户最需要的信息；
 * 4. **纯函数**：不依赖 i18n 框架、不读全局状态，便于测试。
 *
 * 注意：本条链路只影响**展示**。真正的校验事实仍以 `ApiError.fieldErrors`
 * 里的原始消息为准，前端不解析它们做逻辑判断（`fieldErrors` 的键才是逻辑依据）。
 */

/** 字段级错误消息里出现的技术字段名 → 中文字段名（尽量贴近表单标签） */
const FIELD_LABELS: Record<string, string> = {
  name: '名称',
  title: '标题',
  creatorId: '达人',
  brandId: '品牌',
  contractId: '合同',
  ownerId: '负责人',
  teamId: '团队',
  projectId: '项目',
  contentId: '内容',
  settlementId: '结算单',
  tagIds: '标签',
  vertical: '垂类',
  status: '状态',
  tier: '分级',
  score: '评估分',
  budget: '预算',
  actualCost: '实际成本',
  fixedFee: '固定费用',
  cpaUnitPrice: 'CPA 单价',
  platformFeeBp: '平台费（基点）',
  agencyShareBp: '公司分成（基点）',
  talentShareBp: '达人分成（基点）',
  taxWithholdBp: '代扣税（基点）',
  settlementMode: '结算方式',
  currency: '币种',
  effectiveFrom: '生效开始日期',
  effectiveTo: '生效结束日期',
  startDate: '开始日期',
  dueDate: '截止日期',
  scheduledAt: '排期时间',
  publishedAt: '发布时间',
  exclusivity: '独家合作',
  exclusivityScope: '独家范围',
  deliverableSpec: '交付要求',
  breachClause: '违约责任',
  attachmentUrls: '附件链接',
  brief: '项目 brief',
  remark: '备注',
  category: '分类',
  color: '颜色',
  email: '邮箱',
  password: '密码',
  phone: '手机号',
  wechat: '微信',
  idCard: '证件号',
  realName: '真实姓名',
  city: '城市',
  agencyType: '机构类型',
  agencyName: '机构名称',
  sourceChannel: '来源渠道',
  styleTags: '风格标签',
  accounts: '平台账号',
  platform: '平台',
  nickname: '昵称',
  platformUid: '平台账号 ID',
  followerCount: '粉丝数',
  dataSource: '数据来源',
  avatarUrl: '头像',
  reason: '原因',
  note: '备注',
  month: '账期月份',
  periodStart: '账期开始',
  periodEnd: '账期结束',
};

/** 把技术字段名换成中文标签，取不到就原样返回 */
function fieldLabel(field: string): string {
  const known = FIELD_LABELS[field];
  if (known) return known;
  // 嵌套路径（accounts.0.platform）取最后一段再试一次
  const lastSegment = field.split('.').pop() ?? field;
  const indexed = lastSegment.replace(/^\d+$/, '');
  return FIELD_LABELS[indexed] ?? FIELD_LABELS[lastSegment] ?? field;
}

/**
 * 把 `vertical must be one of the following values: A, B` 这类句子转成中文。
 * 不匹配任何规则时返回原文（绝不返回空串或泛化兜底）。
 */
export function humanizeValidationMessage(message: string): string {
  const text = message.trim();
  if (text === '') return message;

  // 「多传了未声明字段」：class-validator 的 whitelist 拒绝
  const undeclared = /^property\s+(\S+)\s+should not exist$/i.exec(text);
  if (undeclared) {
    return `不支持字段「${fieldLabel(undeclared[1])}」：后端未声明该字段，通常是前端多传了参数`;
  }

  // 通用句式：<field> must be ... / <field> should not be ...
  const withField =
    /^([A-Za-z_][\w.]*)\s+(must|should)\s+(.+)$/.exec(text) ??
    /^([A-Za-z_][\w.]*)\s+(.+)$/.exec(text);
  if (!withField) return text;

  const field = fieldLabel(withField[1]);
  const rest = (withField[3] ?? withField[2]).trim();

  // 枚举取值：把合法取值完整保留，这是用户最需要的信息
  const oneOf = /^be one of the following values:\s*(.+)$/i.exec(rest);
  if (oneOf) {
    const values = oneOf[1]
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .join('、');
    return `${field}必须是以下值之一：${values}`;
  }

  if (/^be a UUID$/i.test(rest)) return `${field}格式不正确（需为 UUID）`;
  if (/^be a string$/i.test(rest)) return `${field}必须是文本`;
  if (/^be a boolean value$/i.test(rest)) return `${field}必须是布尔值（true/false）`;
  if (/^be an integer number$/i.test(rest)) return `${field}必须是整数`;
  if (/^be a number conforming to the specified constraints$/i.test(rest)) {
    return `${field}数值不符合要求`;
  }
  if (/^be a valid ISO 8601 date string$/i.test(rest)) return `${field}必须是合法日期`;
  if (/^be an email$/i.test(rest)) return `${field}必须是合法邮箱`;
  if (/^be a hexadecimal color$/i.test(rest)) return `${field}必须是十六进制颜色值`;
  if (/^be an array$/i.test(rest)) return `${field}必须是数组`;
  if (/^not be empty$/i.test(rest)) return `${field}不能为空`;

  const tooLong = /^be shorter than or equal to (\d+) characters$/i.exec(rest);
  if (tooLong) return `${field}长度不能超过 ${tooLong[1]} 个字符`;

  const tooShort = /^be longer than or equal to (\d+) characters$/i.exec(rest);
  if (tooShort) return `${field}长度不能少于 ${tooShort[1]} 个字符`;

  const maxValue = /^not be greater than (\d+)$/i.exec(rest);
  if (maxValue) return `${field}不能大于 ${maxValue[1]}`;

  const minValue = /^not be less than (\d+)$/i.exec(rest);
  if (minValue) return `${field}不能小于 ${minValue[1]}`;

  const maxItems = /^contain no more than (\d+) elements$/i.exec(rest);
  if (maxItems) return `${field}最多 ${maxItems[1]} 项`;

  const minItems = /^contain at least (\d+) elements$/i.exec(rest);
  if (minItems) return `${field}至少 ${minItems[1]} 项`;

  if (/^match .* regular expression$/i.test(rest)) return `${field}格式不正确`;

  // 未覆盖的句式：保留字段中文名 + 原英文说明，信息不丢
  return `${field}：${rest}`;
}
