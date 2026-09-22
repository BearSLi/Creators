import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import styles from './LoginPage.module.css';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/Toast';
import { resolveErrorMessage, ApiError } from '@/api/client';
import { EMAIL_PATTERN } from '@/utils/constants';

/**
 * 登录页。
 *
 * 三个刻意的设计：
 *   1) 记住"从哪里被踢出来"：401 由 client.ts 用 window.location.replace 跳到
 *      /login?reason=...，这里把原因显式展示，用户才不会以为是密码错了；
 *   2) 演示账号一键填充：这是内部业务系统，交付/评审时需要快速切角色验证权限矩阵
 *      （运营看不到结算审批、财务改不了内容）。生产环境不需要时删掉 DEMO_ACCOUNTS 与对应区块即可；
 *   3) 登录成功跳到 `redirect` 参数指定的原页面，而不是一律进看板——
 *      用户点开的是某个达人详情，登录后应该回到那里。
 */

interface DemoAccount {
  label: string;
  email: string;
  /** 该角色的关键差异点，比罗列权限码更能说明权限模型 */
  highlight: string;
}

const DEMO_PASSWORD = 'CreatorOps@2026';

const DEMO_ACCOUNTS: DemoAccount[] = [
  { label: '系统管理员', email: 'admin@juxingzhimei.com', highlight: '全量权限' },
  { label: '运营', email: 'ops@juxingzhimei.com', highlight: '达人全周期，不能审批资金' },
  { label: '商务', email: 'bd@juxingzhimei.com', highlight: '仅自己负责的达人（数据范围 OWN）' },
  { label: '内容', email: 'content@juxingzhimei.com', highlight: '内容排期，看不到合同金额' },
  { label: '财务', email: 'finance@juxingzhimei.com', highlight: '结算审批与打款' },
  { label: '审计', email: 'audit@juxingzhimei.com', highlight: '全量只读 + 审计日志' },
];

export default function LoginPage() {
  const { login, user, initializing } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const redirectTo = searchParams.get('redirect') ?? '/dashboard';
  const reason = searchParams.get('reason');

  // 已登录用户直接放行：否则用户手动敲 /login 会被自己"困"在登录页
  useEffect(() => {
    if (!initializing && user) {
      navigate(redirectTo, { replace: true });
    }
  }, [initializing, user, navigate, redirectTo]);

  const emailInvalid = email.length > 0 && !EMAIL_PATTERN.test(email);
  const canSubmit = email.length > 0 && password.length > 0 && !emailInvalid && !submitting;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setEmailTouched(true);
    setPasswordTouched(true);
    setErrorText(null);
    if (!canSubmit) return;

    setSubmitting(true);
    try {
      const loggedIn = await login({ email: email.trim(), password });
      toast.success(`欢迎回来，${loggedIn.name}`);
      navigate(redirectTo, { replace: true });
    } catch (error) {
      // 登录失败不弹全局 toast：错误信息要贴在表单上，用户才能边看边改
      setErrorText(resolveErrorMessage(error));
      if (error instanceof ApiError && error.requestId) {
        setErrorText(`${resolveErrorMessage(error)}（请求编号 ${error.requestId}）`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const fillDemo = (account: DemoAccount) => {
    setEmail(account.email);
    setPassword(DEMO_PASSWORD);
    setEmailTouched(false);
    setPasswordTouched(false);
    setErrorText(null);
  };

  return (
    <div className={styles.root}>
      <aside className={styles.brandPane}>
        <div className={styles.brandTop}>
          <span className={styles.brandMark}>C</span>
          <div>
            <div className={styles.brandName}>CreatorOps</div>
            <div className={styles.brandSub}>聚猩智媒 · 达人合作管理平台</div>
          </div>
        </div>

        <div className={styles.brandHero}>
          <h1 className={styles.heroTitle}>
            从线索到结算
            <br />
            一条链路管住达人合作
          </h1>
          <p className={styles.heroDesc}>
            达人主数据 · 合同审批 · 内容排期 · 分润结算 · AI 内容生产，全流程留痕可审计。
          </p>
        </div>

        <ul className={styles.featureList}>
          <li>
            <span className={styles.featureIndex}>01</span>
            <div>
              <div className={styles.featureTitle}>状态机驱动的合作流转</div>
              <div className={styles.featureDesc}>
                线索 → 建联 → 评估 → 签约 → 合作，非法跳转直接拒绝并给出可选下一步
              </div>
            </div>
          </li>
          <li>
            <span className={styles.featureIndex}>02</span>
            <div>
              <div className={styles.featureTitle}>资金不留前端手算</div>
              <div className={styles.featureDesc}>
                金额以字符串元下发、比率以基点下发，前端只做展示与校验，杜绝口径漂移
              </div>
            </div>
          </li>
          <li>
            <span className={styles.featureIndex}>03</span>
            <div>
              <div className={styles.featureTitle}>权限驱动界面</div>
              <div className={styles.featureDesc}>
                菜单、按钮、敏感字段按权限点渲染，手机号与结算金额默认脱敏
              </div>
            </div>
          </li>
        </ul>

        <div className={styles.brandFooter}>
          <span>内部业务系统 · 数据受审计保护</span>
        </div>
      </aside>

      <main className={styles.formPane}>
        <div className={styles.formCard}>
          <h2 className={styles.formTitle}>登录</h2>
          <p className={styles.formSubtitle}>使用企业邮箱登录，账号由系统管理员开通</p>

          {reason && (
            <div className={styles.sessionNotice} role="alert">
              {reason}
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate>
            <div className="field" style={{ marginBottom: 'var(--space-4)' }}>
              <label className="label labelRequired" htmlFor="login-email">
                邮箱
              </label>
              <input
                id="login-email"
                type="email"
                autoComplete="username"
                className={`input ${emailTouched && emailInvalid ? 'inputError' : ''}`}
                placeholder="name@juxingzhimei.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onBlur={() => setEmailTouched(true)}
                disabled={submitting}
              />
              {emailTouched && emailInvalid && (
                <span className="errorText">请输入有效的邮箱地址</span>
              )}
            </div>

            <div className="field" style={{ marginBottom: 'var(--space-3)' }}>
              <label className="label labelRequired" htmlFor="login-password">
                密码
              </label>
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                className="input"
                placeholder="请输入密码"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onBlur={() => setPasswordTouched(true)}
                disabled={submitting}
              />
              {passwordTouched && password.length === 0 && (
                <span className="errorText">请输入密码</span>
              )}
            </div>

            {errorText && (
              <div className={styles.errorBox} role="alert">
                {errorText}
              </div>
            )}

            <button
              type="submit"
              className="btn btnPrimary btnBlock btnLg"
              style={{ marginTop: 'var(--space-4)' }}
              disabled={!canSubmit}
            >
              {submitting && <span className="spinner" aria-hidden="true" />}
              {submitting ? '登录中…' : '登录'}
            </button>
          </form>

          <div className={styles.demoBlock}>
            <div className={styles.demoHeader}>
              <span>演示账号（点击填充，密码统一为 {DEMO_PASSWORD}）</span>
            </div>
            <div className={styles.demoList}>
              {DEMO_ACCOUNTS.map((account) => (
                <button
                  key={account.email}
                  type="button"
                  className={styles.demoItem}
                  onClick={() => fillDemo(account)}
                  disabled={submitting}
                  title={`${account.email} · ${account.highlight}`}
                >
                  <span className={styles.demoLabel}>{account.label}</span>
                  <span className={styles.demoHighlight}>{account.highlight}</span>
                </button>
              ))}
            </div>
          </div>

          <p className={styles.formFooter}>
            登录行为（含 IP 与时间）会写入审计日志；连续失败多次可能触发账号锁定。
          </p>
        </div>
      </main>
    </div>
  );
}
