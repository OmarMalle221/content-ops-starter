import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    setupFiles: ['test/vitest.setup.ts'],
  },
  plugins: [
    // SWC is required so that NestJS decorator metadata is emitted (esbuild does not support it).
    swc.vite({
      module: { type: 'es6' },
      jsc: { target: 'es2022', transform: { decoratorMetadata: true, legacyDecorator: true } },
    }),
  ],
});
