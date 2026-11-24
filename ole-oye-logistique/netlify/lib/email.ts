import { siteConfig, destinationBySlug, pick } from '../../src/config/site.config';
import { createTranslator, type Dict } from '../../src/i18n/core';
import type { QuoteData } from '../../src/lib/quote-schema';
import fr from '../../src/i18n/fr.json';
import en from '../../src/i18n/en.json';

// Le courriel interne est rédigé dans la langue par défaut du site.
const dictionaries: Record<string, Dict> = { fr, en };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export interface QuoteEmail {
  subject: string;
  text: string;
  html: string;
}

/** Compose le courriel qui prévient l'exportateur d'une nouvelle demande de devis. */
export function buildQuoteEmail(quote: QuoteData, reference: string): QuoteEmail {
  const lang = siteConfig.defaultLocale;
  const { t } = createTranslator(dictionaries, lang);
  const destination = destinationBySlug(quote.destination);
  const destinationLabel = destination
    ? `${destination.city}, ${pick(destination.country, lang)}`
    : t('quote.destinationOther');
  const whatsappUrl = `https://wa.me/${quote.phone.replace(/\D/g, '')}`;

  const rows: [string, string | null][] = [
    [t('email.reference'), reference],
    [t('quote.name'), quote.full_name],
    [t('quote.phone'), quote.phone],
    [t('quote.email'), quote.email],
    [t('quote.shipmentType'), t(`quote.types.${quote.shipment_type}`)],
    [t('quote.vehicleMake'), quote.vehicle_make],
    [t('quote.vehicleModel'), quote.vehicle_model],
    [t('quote.vehicleYear'), quote.vehicle_year ? String(quote.vehicle_year) : null],
    [t('email.running'), quote.vehicle_running === null ? null : t(quote.vehicle_running ? 'email.yes' : 'email.no')],
    [t('quote.containerSize'), quote.container_size ? t(`quote.container${quote.container_size}`) : null],
    [t('quote.destination'), destinationLabel],
    [t('quote.desiredDate'), quote.desired_date],
    [t('quote.message'), quote.message],
    [t('email.locale'), quote.locale],
  ];
  const filled = rows.filter((row): row is [string, string] => Boolean(row[1]));

  const text = [
    t('email.intro'),
    '',
    ...filled.map(([label, value]) => `${label} : ${value}`),
    '',
    `${t('email.whatsapp')} : ${whatsappUrl}`,
    t('email.replyHint'),
  ].join('\n');

  const html = `<!doctype html><html lang="${lang}"><body style="font-family:Arial,Helvetica,sans-serif;color:#1e293b;line-height:1.5">
<p>${escapeHtml(t('email.intro'))}</p>
<table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
${filled
  .map(
    ([label, value]) =>
      `<tr><th align="left" valign="top" style="border-bottom:1px solid #e2e8f0;color:#475569;font-weight:600">${escapeHtml(label)}</th><td style="border-bottom:1px solid #e2e8f0;white-space:pre-wrap">${escapeHtml(value)}</td></tr>`,
  )
  .join('\n')}
</table>
<p><a href="${escapeHtml(whatsappUrl)}" style="display:inline-block;background:#25d366;color:#05301a;font-weight:700;padding:10px 16px;border-radius:8px;text-decoration:none">${escapeHtml(t('email.whatsapp'))}</a></p>
<p style="color:#475569">${escapeHtml(t('email.replyHint'))}</p>
</body></html>`;

  return { subject: t('email.subject', { reference, name: quote.full_name }), text, html };
}

/**
 * Envoie la notification par Resend. Ne lève jamais d'erreur : la demande est
 * déjà enregistrée, un courriel en échec ne doit pas la faire échouer.
 */
export async function sendQuoteNotification(quote: QuoteData, reference: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.QUOTE_NOTIFY_EMAIL;
  const from = process.env.QUOTE_FROM_EMAIL;
  if (!apiKey || !to || !from) {
    console.warn('email: notification non envoyée (RESEND_API_KEY, QUOTE_NOTIFY_EMAIL ou QUOTE_FROM_EMAIL manquant)');
    return false;
  }
  const email = buildQuoteEmail(quote, reference);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${siteConfig.name} <${from}>`,
        to: to.split(',').map((address) => address.trim()),
        reply_to: quote.email,
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
    });
    if (!response.ok) {
      console.error('email: Resend a répondu', response.status, await response.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error('email', error);
    return false;
  }
}
