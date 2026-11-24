import type { APIRoute } from 'astro';
import { siteConfig } from '../config/site.config';

export const GET: APIRoute = ({ site }) => {
  const sitemap = new URL('/sitemap-index.xml', site ?? siteConfig.url).href;
  const body = ['User-agent: *', 'Allow: /', 'Disallow: /admin', 'Disallow: /api/', '', `Sitemap: ${sitemap}`, ''].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
