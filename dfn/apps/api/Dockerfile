# syntax=docker/dockerfile:1.7
# DFN API — sandbox image. Runs TypeScript through ts-node (transpile-only); a compiled
# distribution build is a listed hardening step before any non-sandbox deployment.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/financial-ledger/package.json packages/financial-ledger/
COPY packages/compliance/package.json packages/compliance/
COPY packages/payment-adapters/package.json packages/payment-adapters/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui/package.json packages/ui/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @dfn/api... --filter @dfn/database...

FROM deps AS runtime
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @dfn/database generate
ENV NODE_ENV=production DFN_MODE=sandbox API_PORT=4000
EXPOSE 4000
USER node
WORKDIR /app/apps/api
CMD ["sh", "-c", "pnpm --filter @dfn/database migrate:deploy && node -r ts-node/register/transpile-only -r tsconfig-paths/register src/main.ts"]
