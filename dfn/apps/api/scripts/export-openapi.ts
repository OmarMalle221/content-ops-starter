import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../src/bootstrap';

async function main() {
  const { app, document } = await createApp();
  const out = resolve(process.argv[2] ?? '../../docs/api/openapi.json');
  writeFileSync(out, JSON.stringify(document, null, 2));
  // eslint-disable-next-line no-console
  console.log(`OpenAPI written to ${out}`);
  await app.close();
}
main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
