#!/usr/bin/env node
// Budget du premier chargement : JavaScript et CSS que index.html charge d'emblée (script d'entrée,
// modulepreload, feuilles de style), compressés en gzip comme en production. Les pages chargées à la
// demande n'en font pas partie. Échoue si le budget est dépassé.
//   node scripts/check-bundle.mjs [dossier-de-build]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = 240;
const dir = process.argv[2] ?? 'dist';
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const assets = [
    ...html.matchAll(/<script[^>]+src="\/(assets\/[^"]+\.js)"/g),
    ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/(assets\/[^"]+\.js)"/g),
    ...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/(assets\/[^"]+\.css)"/g)
].map((m) => m[1]);

let total = 0;
for (const asset of [...new Set(assets)]) {
    const size = gzipSync(readFileSync(join(dir, asset)), { level: 9 }).length;
    total += size;
    console.log(`${(size / 1024).toFixed(1).padStart(7)} ko  ${asset}`);
}
const totalKb = total / 1024;
console.log(`${totalKb.toFixed(1).padStart(7)} ko  premier chargement (budget ${BUDGET_KB} ko)`);
if (assets.length === 0 || totalKb > BUDGET_KB) {
    console.error(assets.length === 0 ? 'Aucun fichier trouvé dans index.html.' : 'Budget dépassé.');
    process.exit(1);
}
