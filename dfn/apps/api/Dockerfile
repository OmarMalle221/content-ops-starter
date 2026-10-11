# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Diaspora Financial Network — API image. SANDBOX ONLY (DFN_MODE=sandbox, ADR-0003).
# Compiled build + hardened runtime: see docs/decisions/ADR-0013-build-compile-et-conteneurs.md.
#
#   docker build -f apps/api/Dockerfile -t dfn-api:local .        (context = the dfn/ directory)
#
# Stages
#   base       Debian slim + corepack (pnpm version pinned by package.json#packageManager)
#   manifests  workspace manifests + lockfile only (layer cache for installs)
#   deps       full install of the @dfn/api closure (dev tools: tsup, SWC, prisma CLI)
#   build      prisma generate + tsup bundle (apps/api/dist), source maps included
#   prod-deps  production-only install + the generated Prisma client, dev toolchains pruned
#   runtime    dist/ + production node_modules + Prisma schema/migrations, uid 10001, tini
#
# The runtime image contains no secret: every credential comes from the environment at run time.
# It runs with a read-only root filesystem: writable paths are /data/storage (volume, documents
# when STORAGE_DRIVER=local) and /tmp (tmpfs). Migrations run as a one-shot job with this image:
#   node /app/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /repo

FROM base AS manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/financial-ledger/package.json packages/financial-ledger/
COPY packages/compliance/package.json packages/compliance/
COPY packages/payment-adapters/package.json packages/payment-adapters/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui/package.json packages/ui/

FROM manifests AS deps
RUN --mount=type=cache,id=dfn-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter '@dfn/api...'

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/database packages/database
COPY packages/financial-ledger packages/financial-ledger
COPY packages/compliance packages/compliance
COPY packages/payment-adapters packages/payment-adapters
COPY packages/contracts packages/contracts
COPY apps/api apps/api
COPY infra/ops/reconcile-ledger.ts infra/ops/reconcile-ledger.ts
# tsup transforms every file with SWC (tsconfig emitDecoratorMetadata) — Nest DI metadata is kept.
RUN pnpm --filter @dfn/database generate \
 && pnpm --filter @dfn/api build \
 && grep -q 'design:paramtypes' apps/api/dist/main.js \
 && cp -a "$(readlink -f packages/database/node_modules/@prisma/client)/../../.prisma" /tmp/prisma-client

FROM manifests AS prod-deps
RUN --mount=type=cache,id=dfn-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter '@dfn/api...'
COPY --from=build /tmp/prisma-client /tmp/prisma-client
# 1. Install the client generated in the build stage next to @prisma/client (same lockfile, so the
#    same virtual-store directory). It embeds the query engine for this platform.
# 2. Drop what the compiled bundle never loads: workspace links (bundled into dist), ts-node and
#    tsconfig-paths (development entry point) and their TypeScript / SWC / @types peers.
# 3. Expose the Prisma CLI (a peer of @prisma/client, with its schema engine) at a stable path for
#    the migrate job, and fail the build if it is missing.
RUN set -eu; \
    client_dir="$(readlink -f apps/api/node_modules/@prisma/client)"; \
    rm -rf "$client_dir/../../.prisma"; \
    cp -a /tmp/prisma-client "$client_dir/../../.prisma"; \
    rm -rf /tmp/prisma-client; \
    rm -rf apps/api/node_modules/@dfn apps/api/node_modules/ts-node apps/api/node_modules/tsconfig-paths \
           node_modules/.pnpm/node_modules/@dfn node_modules/.pnpm/ts-node@* node_modules/.pnpm/typescript@* \
           node_modules/.pnpm/@swc+* node_modules/.pnpm/@types+*; \
    find node_modules apps/api/node_modules -xtype l -delete; \
    cli_dir="$(cd apps/api && node -p "require('path').dirname(require.resolve('prisma/package.json', { paths: [require('path').dirname(require.resolve('@prisma/client/package.json'))] }))")"; \
    ln -s "$(realpath --relative-to=node_modules "$cli_dir")" node_modules/prisma; \
    node node_modules/prisma/build/index.js --version >/dev/null; \
    cd apps/api && node -e "require('@prisma/client'); require('argon2'); require('@nestjs/core')"

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="dfn-api" \
      org.opencontainers.image.description="Diaspora Financial Network API — SANDBOX ONLY, fictitious funds" \
      org.opencontainers.image.licenses="UNLICENSED"
ENV NODE_ENV=production \
    DFN_MODE=sandbox \
    API_PORT=4000 \
    STORAGE_DIR=/data/storage \
    HOME=/tmp \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
# openssl/libssl: Prisma engines; tini: PID 1 that forwards SIGTERM and reaps zombies.
# npm, npx, corepack and yarn are removed: nothing is installed at run time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 dfn \
 && useradd --system --uid 10001 --gid dfn --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin dfn \
 && mkdir -p /data/storage \
 && chown 10001:10001 /data/storage \
 && chmod 0700 /data/storage \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app/apps/api
# Application files stay owned by root: the runtime user can read but never modify them.
COPY --from=prod-deps /repo/node_modules /app/node_modules
COPY --from=prod-deps /repo/apps/api/node_modules /app/apps/api/node_modules
COPY --from=prod-deps /repo/apps/api/package.json /app/apps/api/package.json
COPY --from=build /repo/apps/api/dist /app/apps/api/dist
COPY --from=build /repo/packages/database/prisma/schema.prisma /app/apps/api/prisma/schema.prisma
COPY --from=build /repo/packages/database/prisma/migrations /app/apps/api/prisma/migrations
USER 10001:10001
EXPOSE 4000
VOLUME ["/data/storage"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
