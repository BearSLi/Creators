import {
  BusinessException,
  StateConflictException,
} from '../../common/exceptions/business.exception';

/**
 * 达人与合作相关的状态机。
 *
 * 为什么不用自由字符串更新状态：
 *   达人状态直接决定结算能否生成、内容能否排期。若允许任意跳转
 *   （例如「线索」直接跳到「合作中」），会绕过签约与合同校验，
 *   最终导致无合同产生结算单——资金风险。
 * 因此把允许的流转固化成表，非法流转直接 409 返回，并附上可选下一步，
 * 让前端能把按钮渲染成「合法动作」而不是一堆灰按钮。
 */

export const CREATOR_STATUS = {
  LEAD: 'LEAD',
  CONTACTING: 'CONTACTING',
  EVALUATING: 'EVALUATING',
  SIGNED: 'SIGNED',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  TERMINATED: 'TERMINATED',
  BLACKLIST: 'BLACKLIST',
} as const;

export type CreatorStatusValue = (typeof CREATOR_STATUS)[keyof typeof CREATOR_STATUS];

export const CREATOR_STATUS_LABELS: Record<CreatorStatusValue, string> = {
  LEAD: '线索',
  CONTACTING: '建联中',
  EVALUATING: '评估中',
  SIGNED: '已签约',
  ACTIVE: '合作中',
  PAUSED: '已暂停',
  TERMINATED: '已解约',
  BLACKLIST: '黑名单',
};

/** 允许的流转：from → 可达的 to 列表 */
export const CREATOR_TRANSITIONS: Record<CreatorStatusValue, CreatorStatusValue[]> = {
  LEAD: ['CONTACTING', 'EVALUATING', 'BLACKLIST', 'TERMINATED'],
  CONTACTING: ['EVALUATING', 'SIGNED', 'BLACKLIST', 'TERMINATED'],
  EVALUATING: ['SIGNED', 'CONTACTING', 'BLACKLIST', 'TERMINATED'],
  SIGNED: ['ACTIVE', 'PAUSED', 'BLACKLIST', 'TERMINATED'],
  ACTIVE: ['PAUSED', 'TERMINATED', 'BLACKLIST'],
  PAUSED: ['ACTIVE', 'TERMINATED', 'BLACKLIST'],
  // 解约后可以重新建联（达人回流是常见业务场景）
  TERMINATED: ['CONTACTING', 'EVALUATING', 'BLACKLIST'],
  // 黑名单只能管理员复议后解除：先退出黑名单到线索，再重新走流程
  BLACKLIST: ['LEAD'],
};

/** 需要填写原因的高风险流转，审计与合规要求留痕 */
export const TRANSITIONS_REQUIRING_REASON: Array<`${CreatorStatusValue}->${CreatorStatusValue}`> = [
  'ACTIVE->TERMINATED',
  'SIGNED->TERMINATED',
  'PAUSED->TERMINATED',
  'CONTACTING->BLACKLIST',
  'EVALUATING->BLACKLIST',
  'SIGNED->BLACKLIST',
  'ACTIVE->BLACKLIST',
  'PAUSED->BLACKLIST',
  'BLACKLIST->LEAD',
];

export interface TransitionCheckResult {
  allowed: boolean;
  reason?: string;
  requiresReason: boolean;
  allowedNext: CreatorStatusValue[];
}

/** 纯函数：判断流转是否合法，便于单测覆盖全矩阵 */
export function canTransition(
  from: CreatorStatusValue,
  to: CreatorStatusValue,
): TransitionCheckResult {
  const allowedNext = CREATOR_TRANSITIONS[from] ?? [];
  const requiresReason = TRANSITIONS_REQUIRING_REASON.includes(`${from}->${to}`);

  if (from === to) {
    return { allowed: false, reason: `状态已经是「${CREATOR_STATUS_LABELS[from]}」，无需变更`, requiresReason, allowedNext };
  }
  if (!allowedNext.includes(to)) {
    return {
      allowed: false,
      reason: `不允许从「${CREATOR_STATUS_LABELS[from]}」直接变更为「${CREATOR_STATUS_LABELS[to]}」`,
      requiresReason,
      allowedNext,
    };
  }
  return { allowed: true, requiresReason, allowedNext };
}

/** 断言流转合法，不合法则抛出带可选下一步的 409，供 Service 直接调用 */
export function assertTransition(
  from: CreatorStatusValue,
  to: CreatorStatusValue,
  options: { reason?: string } = {},
): void {
  const result = canTransition(from, to);
  if (!result.allowed) {
    throw new StateConflictException(result.reason ?? '状态流转不被允许', {
      from,
      to,
      allowedNext: result.allowedNext.map((status) => ({
        value: status,
        label: CREATOR_STATUS_LABELS[status],
      })),
    });
  }
  if (result.requiresReason && !options.reason?.trim()) {
    throw new BusinessException(
      'REASON_REQUIRED',
      `变更为「${CREATOR_STATUS_LABELS[to]}」必须填写原因（用于审计追溯）`,
      400,
      { requiresReason: true, field: 'reason' },
    );
  }
}

/** 业务规则：只有已签约及之后的达人能被排期生产内容 */
export function assertCanBeScheduled(status: CreatorStatusValue): void {
  const schedulable: CreatorStatusValue[] = ['SIGNED', 'ACTIVE', 'PAUSED'];
  if (!schedulable.includes(status)) {
    throw new StateConflictException(
      `达人当前状态为「${CREATOR_STATUS_LABELS[status]}」，需先完成签约才能排期内容`,
      { status, requiredAnyOf: schedulable },
    );
  }
}

/** 业务规则：只有合作中/暂停状态的达人能进入结算 */
export function assertCanBeSettled(status: CreatorStatusValue): void {
  const settleable: CreatorStatusValue[] = ['SIGNED', 'ACTIVE', 'PAUSED', 'TERMINATED'];
  if (!settleable.includes(status)) {
    throw new StateConflictException(
      `达人当前状态为「${CREATOR_STATUS_LABELS[status]}」，不满足结算前置条件`,
      { status, requiredAnyOf: settleable },
    );
  }
}

/** 前端渲染用：返回所有状态与允许的下一步 */
export function describeStatusMachine(from: CreatorStatusValue) {
  return {
    current: { value: from, label: CREATOR_STATUS_LABELS[from] },
    allowedNext: (CREATOR_TRANSITIONS[from] ?? []).map((status) => ({
      value: status,
      label: CREATOR_STATUS_LABELS[status],
      requiresReason: TRANSITIONS_REQUIRING_REASON.includes(`${from}->${status}`),
    })),
  };
}
