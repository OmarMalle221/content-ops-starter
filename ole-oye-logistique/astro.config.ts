import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { siteConfig } from './src/config/site.config';

// Sur Netlify, `URL` contient l'adresse publique du site. `SITE_URL` permet de la forcer.
const site = process.env.SITE_URL || process.env.URL || siteConfig.url;

export default defineConfig({
  site,
  trailingSlash: 'always',
  build: { format: 'directory' },
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/admin'),
      i18n: {
        defaultLocale: siteConfig.defaultLocale,
        locales: Object.fromEntries(siteConfig.locales.map((l) => [l.code, l.htmlLang])),
      },
    }),
  ],
  vite: { plugins: [tailwindcss()] },
});
