import { Link } from 'react-router-dom';

/**
 * 404 页面。
 *
 * 放在主框架内部：用户走错路径时导航还在，可以直接点回正确模块，
 * 而不是被丢到一个孤立页面只能点浏览器后退。
 */
export default function NotFoundPage() {
  return (
    <div className="page">
      <div className="card">
        <div className="cardBody" style={{ padding: 'var(--space-12)', textAlign: 'center' }}>
          <div
            className="mono"
            style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 600, color: 'var(--color-primary-600)' }}
          >
            404
          </div>
          <h2 style={{ marginTop: 'var(--space-3)', fontSize: 'var(--font-size-lg)' }}>
            页面不存在或已被移除
          </h2>
          <p className="muted" style={{ marginTop: 'var(--space-2)' }}>
            可能是链接已失效，或该业务数据已被删除。你可以回到经营看板重新进入。
          </p>
          <div
            className="row"
            style={{ marginTop: 'var(--space-5)', justifyContent: 'center' }}
          >
            <Link className="btn btnPrimary" to="/dashboard">
              返回经营看板
            </Link>
            <Link className="btn" to="/creators">
              去达人库
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
