import { rm } from 'node:fs/promises';
import { defineConfig } from 'astro/config';
import type { AstroIntegration } from 'astro';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { siteConfig } from './src/config/site.config';

// Sur Netlify, `URL` contient l'adresse publique du site. `SITE_URL` permet de la forcer.
const site = process.env.SITE_URL || process.env.URL || siteConfig.url;

/** Retire du site publié les pages des fonctionnalités désactivées dans la config. */
const dropDisabledPages: AstroIntegration = {
  name: 'drop-disabled-pages',
  hooks: {
    'astro:build:done': async ({ dir }) => {
      if (!siteConfig.features.tracking) await rm(new URL('admin/', dir), { recursive: true, force: true });
    },
  },
};

export default defineConfig({
  site,
  trailingSlash: 'always',
  build: { format: 'directory' },
  integrations: [
    sitemap({
      // Hors sitemap : l'administration, le gabarit d'image et la racine (simple redirection).
      filter: (page) => !/^\/(admin\/|og\/)?$/.test(new URL(page).pathname),
      i18n: {
        defaultLocale: siteConfig.defaultLocale,
        locales: Object.fromEntries(siteConfig.locales.map((l) => [l.code, l.htmlLang])),
      },
    }),
    dropDisabledPages,
  ],
  vite: { plugins: [tailwindcss()] },
});
