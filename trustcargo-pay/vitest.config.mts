import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        tsconfigPaths: true,
        alias: {
            'server-only': new URL('./tests/stubs/server-only.ts', import.meta.url).pathname
        }
    },
    test: {
        environment: 'node',
        include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
        setupFiles: ['tests/setup.ts'],
        restoreMocks: true
    }
});
