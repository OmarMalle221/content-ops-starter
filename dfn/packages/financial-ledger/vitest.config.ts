import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    // ROADMAP §11: at least 90 % of the ledger's lines covered, enforced on every run (CI included).
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/types.ts'],
      reporter: ['text-summary'],
      thresholds: { lines: 90, statements: 90, branches: 85 },
    },
  },
});
