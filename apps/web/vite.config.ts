import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 与 tsconfig.app.json 的 paths 保持同源，避免"编辑器能跳转、构建却找不到模块"
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // host: true 让容器/局域网同事也能访问开发服务器（内网联调常用）
    host: true,
    proxy: {
      // 开发期由 vite 代理到本地 API，前端代码里始终只写相对路径 /api，
      // 部署到 nginx 时无需改任何业务代码，只改 nginx.conf 的 upstream
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
  build: {
    // 生产排查线上白屏需要能定位到源码行，sourcemap 一并交给 nginx 静态托管
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // echarts 体积大且更新频率低，单独切块避免业务代码改动导致整包缓存失效
        manualChunks: {
          echarts: ['echarts', 'echarts-for-react'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
