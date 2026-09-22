import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import App from './App';

/**
 * 应用入口。
 *
 * 严格模式（StrictMode）在开发环境会双调用 effect，这正是我们想要的：
 * 能提前暴露"忘记清理订阅/定时器"的问题，避免上线后出现重复请求与内存泄漏。
 */
const container = document.getElementById('root');

if (!container) {
  // 挂载点缺失属于部署事故（index.html 被改坏），直接抛出比静默白屏更容易定位
  throw new Error('未找到 #root 挂载点，请检查 index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
