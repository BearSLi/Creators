import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 全局错误边界。
 *
 * React 18 里渲染期抛错会让整棵树卸载（白屏），错误边界是唯一的兜底手段。
 * 这里做三件事：
 *   1) 兜住渲染异常，展示可读的错误页而不是白屏；
 *   2) 错误详情折叠展示，方便用户截图给研发，同时不吓到普通业务用户；
 *   3) 可重置重试（不刷新页面），因为多数渲染错误来自某次异常数据，重挂载即可恢复。
 */

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 自定义降级 UI */
  fallback?: ReactNode;
  /** 出错时的埋点回调（上报到监控系统用） */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: '' };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? '' });
    this.props.onError?.(error, info);
    // 保留控制台输出：生产环境交给监控 SDK，开发时靠 console 定位
    console.error('[ErrorBoundary] 页面渲染异常', error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null, componentStack: '' });
  };

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="page">
        <div className="card">
          <div className="cardBody" style={{ padding: 'var(--space-8)' }}>
            <h2 style={{ fontSize: 'var(--font-size-lg)' }}>页面出现异常</h2>
            <p style={{ marginTop: 'var(--space-2)', color: 'var(--color-text-secondary)' }}>
              该错误已被记录。你可以先尝试重新加载当前视图；如果反复出现，请把下方的错误详情发给研发同学。
            </p>

            <div className="row wrap" style={{ marginTop: 'var(--space-4)' }}>
              <button type="button" className="btn btnPrimary" onClick={this.handleReset}>
                重试渲染
              </button>
              <button type="button" className="btn" onClick={() => window.location.reload()}>
                刷新页面
              </button>
              <button
                type="button"
                className="btn btnGhost"
                onClick={() => {
                  window.location.href = '/';
                }}
              >
                返回看板
              </button>
            </div>

            <details style={{ marginTop: 'var(--space-5)' }}>
              <summary style={{ cursor: 'pointer', fontSize: 'var(--font-size-sm)' }}>
                查看错误详情
              </summary>
              <pre className="codeBlock" style={{ marginTop: 'var(--space-2)' }}>
                {error.name}: {error.message}
                {componentStack}
              </pre>
            </details>
          </div>
        </div>
      </div>
    );
  }
}
