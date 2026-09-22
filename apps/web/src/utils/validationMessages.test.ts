import { describe, expect, it } from 'vitest';
import { humanizeValidationMessage } from './validationMessages';

/**
 * 展示层翻译的回归测试。
 *
 * 为什么值得单独测：这段逻辑的失败方式很隐蔽 —— 翻译规则没覆盖时会**静默返回英文原文**，
 * 界面不报错、类型也对，只有用户看到一个中英混杂的提示才发现。
 * 所以这里既覆盖已支持的句式，也**显式锁定「不丢信息」的兜底行为**。
 */
describe('humanizeValidationMessage', () => {
  it('把「未声明字段」翻译成可理解的中文，并保留字段名', () => {
    expect(humanizeValidationMessage('property status should not exist')).toContain('状态');
    expect(humanizeValidationMessage('property description should not exist')).toContain('description');
  });

  it('枚举取值必须完整列出合法值（这是用户最需要的信息）', () => {
    const result = humanizeValidationMessage(
      'vertical must be one of the following values: SHORT_DRAMA, LIFESTYLE, BEAUTY',
    );
    expect(result).toContain('SHORT_DRAMA');
    expect(result).toContain('LIFESTYLE');
    expect(result).toContain('BEAUTY');
    expect(result).toContain('垂类');
  });

  it('常见类型错误翻译成中文并带中文字段名', () => {
    expect(humanizeValidationMessage('brandId must be a UUID')).toBe('品牌格式不正确（需为 UUID）');
    expect(humanizeValidationMessage('title must be a string')).toBe('标题必须是文本');
    expect(humanizeValidationMessage('effectiveFrom must be a valid ISO 8601 date string')).toBe(
      '生效开始日期必须是合法日期',
    );
  });

  it('长度与数值边界保留阈值', () => {
    expect(humanizeValidationMessage('title must be longer than or equal to 2 characters')).toBe(
      '标题长度不能少于 2 个字符',
    );
    expect(humanizeValidationMessage('brief must be shorter than or equal to 5000 characters')).toBe(
      '项目 brief长度不能超过 5000 个字符',
    );
    expect(humanizeValidationMessage('pageSize must not be greater than 100')).toBe(
      'pageSize不能大于 100',
    );
  });

  it('自定义中文 message 原样返回，不被二次加工', () => {
    const custom = '结算模式非法';
    expect(humanizeValidationMessage(custom)).toBe(custom);
    expect(humanizeValidationMessage('预算格式不正确，需为最多两位小数的金额字符串')).toBe(
      '预算格式不正确，需为最多两位小数的金额字符串',
    );
  });

  it('未覆盖的句式不得丢失信息（宁可显示英文，也不能变成泛化兜底）', () => {
    const unknown = 'someField must be something we never mapped';
    const result = humanizeValidationMessage(unknown);
    expect(result).toContain('something we never mapped');
  });

  it('空消息原样返回，不产生空串提示', () => {
    expect(humanizeValidationMessage('')).toBe('');
    expect(humanizeValidationMessage('   ')).toBe('   ');
  });

  it('嵌套路径（平台账号行）能取到最后一段的字段名', () => {
    expect(humanizeValidationMessage('accounts.0.platform must be one of the following values: DOUYIN, BILIBILI')).toContain(
      '平台',
    );
  });
});
