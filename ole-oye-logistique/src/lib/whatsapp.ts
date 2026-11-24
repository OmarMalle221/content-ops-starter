import { siteConfig } from '../config/site.config';

/** Lien WhatsApp vers le numéro du client, avec un message pré-rempli facultatif. */
export function whatsappLink(message?: string): string {
  const base = `https://wa.me/${siteConfig.contact.whatsapp}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}
