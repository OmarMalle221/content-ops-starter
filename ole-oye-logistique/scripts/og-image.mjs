/**
 * Génère `public/og-image.png` (1200 × 630 px) à partir de la page `/og/`.
 *
 *   npm run og
 *
 * Demande Playwright et son navigateur, à installer une seule fois :
 *   npm install --no-save playwright && npx playwright install chromium
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const page = fileURLToPath(new URL('../dist/og/index.html', import.meta.url));
const output = fileURLToPath(new URL('../public/og-image.png', import.meta.url));

if (!existsSync(page)) {
  console.error('dist/og/index.html est introuvable : lancer `npm run build` avant `npm run og`.');
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright est requis : npm install --no-save playwright && npx playwright install chromium');
  process.exit(1);
}

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
// Les feuilles de style du build ont des chemins absolus (/_astro/…) : on les sert depuis dist/.
await tab.route('**/*', (route) => {
  const url = new URL(route.request().url());
  if (url.protocol !== 'file:' || url.pathname === pathToFileURL(page).pathname) return route.continue();
  const file = fileURLToPath(new URL(`../dist${url.pathname}`, import.meta.url));
  return existsSync(file) ? route.fulfill({ path: file }) : route.continue();
});
await tab.goto(pathToFileURL(page).href);
await tab.evaluate(() => document.fonts.ready);
await tab.screenshot({ path: output, clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();
console.log(`Image d'aperçu écrite : ${output}`);
