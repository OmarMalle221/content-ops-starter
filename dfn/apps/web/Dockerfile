# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Diaspora Financial Network — web image (Next.js standalone output). SANDBOX ONLY: every screen
# shows the "Données fictives — Aucun fonds réel" banner; no real funds exist anywhere.
#
#   docker build -f apps/web/Dockerfile --build-arg API_INTERNAL_URL=http://api:4000 -t dfn-web:local .
#
# API_INTERNAL_URL is a BUILD argument: Next resolves the /api/* rewrites (same-origin proxy to the
# API) when it builds, so the image is tied to the API address it was built for. Server components
# also read it at run time (keep both values identical).
# Runtime: uid 10001, tini as PID 1, read-only friendly (writable: /tmp and .next/cache, tmpfs).
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY packages/database/package.json packages/database/
COPY packages/financial-ledger/package.json packages/financial-ledger/
COPY packages/compliance/package.json packages/compliance/
COPY packages/payment-adapters/package.json packages/payment-adapters/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=dfn-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter '@dfn/web...'

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/ui packages/ui
COPY apps/web apps/web
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL \
    NEXT_PUBLIC_DFN_MODE=sandbox
# public/ is empty and therefore absent from a fresh clone: create it so the runtime COPY works.
RUN mkdir -p apps/web/public \
 && pnpm --filter @dfn/web build \
 && test -f apps/web/.next/standalone/apps/web/server.js

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="dfn-web" \
      org.opencontainers.image.description="Diaspora Trust web app — SANDBOX ONLY, fictitious funds" \
      org.opencontainers.image.licenses="UNLICENSED"
ARG API_INTERNAL_URL=http://api:4000
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_DFN_MODE=sandbox \
    API_INTERNAL_URL=$API_INTERNAL_URL \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    HOME=/tmp
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 dfn \
 && useradd --system --uid 10001 --gid dfn --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin dfn \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
# Application files stay owned by root (read-only for the runtime user); only the Next cache is
# writable (mount a tmpfs there when the root filesystem is read-only).
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
RUN mkdir -p apps/web/.next/cache && chown 10001:10001 apps/web/.next/cache
USER 10001:10001
EXPOSE 3000
# /dashboard without a session cookie is answered by the middleware (redirect to /login) without
# calling the API, so this probe checks the web server alone.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/dashboard',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
