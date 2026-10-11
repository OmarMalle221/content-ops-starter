import 'reflect-metadata';
import { createApp } from './bootstrap';
import { env } from './config/env';

async function main() {
  const { app } = await createApp();
  const cfg = env();
  await app.listen(cfg.API_PORT);
  console.log(
    `[dfn-api] SANDBOX mode — listening on ${cfg.API_PUBLIC_URL} (OpenAPI: ${cfg.API_PUBLIC_URL}/docs)`,
  );
}

main().catch((err) => {
  console.error('[dfn-api] failed to start', err);
  process.exit(1);
});
