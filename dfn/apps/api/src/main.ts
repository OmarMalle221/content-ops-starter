import 'reflect-metadata';
import { createApp } from './bootstrap';
import { env } from './config/env';

/**
 * Upper bound for a graceful shutdown. Orchestrators send SIGTERM and then SIGKILL after their own
 * grace period (docker-compose.yml sets stop_grace_period: 30s), so we stop ourselves slightly
 * earlier and exit non-zero if a shutdown hook hangs (stuck job, unreachable Redis…).
 */
const SHUTDOWN_GRACE_MS = 25_000;

function installShutdownWatchdog() {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      console.log(`[dfn-api] ${signal} received — draining connections and stopping jobs`);
      setTimeout(() => {
        console.error(`[dfn-api] graceful shutdown exceeded ${SHUTDOWN_GRACE_MS} ms — forcing exit`);
        process.exit(1);
      }, SHUTDOWN_GRACE_MS).unref();
    });
  }
}

async function main() {
  const { app } = await createApp();
  const cfg = env();
  // Graceful shutdown: on SIGTERM/SIGINT Nest stops accepting connections, lets in-flight requests
  // finish, then runs onModuleDestroy / beforeApplicationShutdown / onApplicationShutdown hooks
  // (scheduler and BullMQ workers, job leases, Redis, Prisma) before the process exits.
  // Idempotent: Nest ignores signals it already listens to.
  app.enableShutdownHooks();
  installShutdownWatchdog();
  await app.listen(cfg.API_PORT);
  console.log(
    `[dfn-api] SANDBOX mode — instance ${cfg.INSTANCE_ID} listening on ${cfg.API_PUBLIC_URL} (OpenAPI: ${cfg.API_PUBLIC_URL}/docs)`,
  );
}

main().catch((err) => {
  console.error('[dfn-api] failed to start', err);
  process.exit(1);
});
