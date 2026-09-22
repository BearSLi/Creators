import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import path from 'node:path';

// e2e 需要真实 PostgreSQL + Redis（用 docker compose up -d 起）。
// 缺少依赖时用例会整体 skip，保证 CI 上没起数据库也不会假红。
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
    // e2e 共享同一个数据库，串行执行避免相互污染
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
