import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import path from 'node:path';

// NestJS 依赖 emitDecoratorMetadata，esbuild 不支持，因此用 SWC 转换 TS。
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // 核心业务逻辑必须有覆盖：结算引擎与权限判定是资金/安全相关模块
      include: ['src/modules/**/*.ts'],
      exclude: ['**/*.module.ts', '**/*.dto.ts', '**/*.controller.ts', '**/index.ts'],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 55,
        statements: 60,
      },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
