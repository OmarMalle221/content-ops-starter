import { defineConfig } from 'tsup';

/**
 * Compiled build of the API (ADR-0013).
 *
 * - Workspace packages (@dfn/*) are consumed as TypeScript source, so they are bundled
 *   (resolved through the tsconfig `paths`).
 * - Every other bare import (NestJS, Prisma client, argon2, pino, bullmq…) stays external and is
 *   loaded from node_modules at runtime: native addons and the generated Prisma client cannot be
 *   bundled, and Nest relies on optional `require()` calls that must keep resolving normally.
 * - tsconfig.base.json enables `emitDecoratorMetadata`; tsup then transforms every file with SWC
 *   (`@swc/core` is a devDependency) so `design:paramtypes` metadata — required by Nest's
 *   dependency injection — is emitted. esbuild alone would silently drop it.
 */
export default defineConfig({
  entry: {
    main: 'src/main.ts',
    'export-openapi': 'scripts/export-openapi.ts',
    'reconcile-ledger': '../../infra/ops/reconcile-ledger.ts',
  },
  outDir: 'dist',
  tsconfig: 'tsconfig.json',
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  splitting: false,
  skipNodeModulesBundle: true,
  noExternal: [/^@dfn\//],
  sourcemap: true,
  keepNames: true,
  minify: false,
  clean: true,
  dts: false,
  shims: false,
});
