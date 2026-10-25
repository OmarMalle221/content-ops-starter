import { expect, test, type Page } from '@playwright/test';
import { dialog, expectSandboxScreen, frMoney, journeyEmail, registerThroughUi } from './journey-helpers';

/**
 * Phase 6 — Diaspora Business through the UI: an invoice created with the form (live integer
 * totals), sent, paid in two recorded payments (PARTIALLY_PAID → PAID); a quote created, sent,
 * accepted and converted into a new invoice.
 */
const RAW_KEY = /\b(invoicing|quotesX|business|clients|reports|common|status)\.[a-zA-Z]+(\.[a-zA-Z]+)*\b/;
const CONFIRM = /^(Confirmer|Confirm)$/;

async function fillDocumentForm(
  page: Page,
  doc: { customer: string; taxPercent: string; description: string; quantity: string; unitPrice: string },
) {
  const form = dialog(page);
  await expect(form).toBeVisible();
  await form.getByLabel(/Nom du client|Customer name/).fill(doc.customer);
  await form.getByLabel(/Taxe \(%\)|Tax \(%\)/).fill(doc.taxPercent);
  await form.getByLabel(/^Description$/).fill(doc.description);
  await form.getByLabel(/^(Qté|Qty)$/).fill(doc.quantity);
  await form.getByLabel(/Prix unitaire|Unit price/).fill(doc.unitPrice);
  return form;
}

test('invoice: create, send, partial then full payment; quote: create, send, accept, convert', async ({
  page,
}) => {
  await registerThroughUi(page, {
    email: journeyEmail('business'),
    firstName: 'Awa',
    lastName: 'Sy',
    country: 'SN',
  });

  // ── Invoice created through the form: 2 × 125.50 + 18 % tax = 251.00 + 45.18 = 296.18.
  await page.goto('/business/invoices');
  await expectSandboxScreen(page, RAW_KEY);
  await page
    .getByRole('button', { name: /Nouvelle facture|New invoice/ })
    .first()
    .click();
  const invoiceForm = await fillDocumentForm(page, {
    customer: 'Boutique Teranga',
    taxPercent: '18',
    description: 'Conseil export — forfait',
    quantity: '2',
    unitPrice: '125.50',
  });
  await expect(invoiceForm.getByText(frMoney('251.00', '$')).first()).toBeVisible();
  await expect(invoiceForm.getByText(frMoney('45.18', '$'))).toBeVisible();
  await expect(invoiceForm.getByText(frMoney('296.18', '$'))).toBeVisible();
  await invoiceForm.getByRole('button', { name: CONFIRM }).click();

  await expect(page).toHaveURL(/\/business\/invoices\/[0-9a-f-]{36}/);
  const invoiceHeading = page.getByRole('heading', { name: /INV-\d{4}-0001/ });
  await expect(invoiceHeading).toBeVisible();
  await expect(page.getByText(/^(Brouillon|Draft)$/).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Conseil export — forfait' })).toBeVisible();
  await expect(page.getByText(/^(Taxes|Tax) \(18\.00 %\)$/).first()).toBeVisible();
  await expectSandboxScreen(page, RAW_KEY);

  // Send to the customer.
  await page.getByRole('button', { name: /Envoyer au client|Send to customer/ }).click();
  await dialog(page).getByRole('button', { name: CONFIRM }).click();
  await expect(page.getByText(/^(Envoyée|Sent)$/).first()).toBeVisible();

  // First (partial) payment recorded: 100.00 → PARTIALLY_PAID, balance due 196.18.
  await page.getByRole('button', { name: /Enregistrer un paiement|Record a payment/ }).click();
  const payment = dialog(page);
  await payment.getByLabel(/^(Montant|Amount)/).fill('100.00');
  await payment.getByLabel(/^(Référence|Reference)$/).fill('VIR-E2E-0001');
  await payment.getByRole('button', { name: CONFIRM }).click();
  await expect(payment).toBeHidden();
  await expect(page.getByText(/^(Partiellement payée|Partially paid)$/).first()).toBeVisible();
  await expect(page.getByText(frMoney('196.18', '$')).first()).toBeVisible();

  // Second payment settles the balance → PAID, no further payment action.
  await page.getByRole('button', { name: /Enregistrer un paiement|Record a payment/ }).click();
  await payment.getByLabel(/^(Montant|Amount)/).fill('196.18');
  await payment.getByRole('button', { name: CONFIRM }).click();
  await expect(payment).toBeHidden();
  await expect(page.getByText(/^(Payée \(fictif\)|Paid \(fictitious\))$/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Enregistrer un paiement|Record a payment/ })).toHaveCount(0);
  await expect(page.getByText(frMoney('0.00', '$')).first()).toBeVisible();
  await expectSandboxScreen(page, RAW_KEY);

  // ── Quote created through the form, sent, accepted and converted into an invoice.
  await page.goto('/business/quotes');
  await expectSandboxScreen(page, RAW_KEY);
  await page
    .getByRole('button', { name: /Nouveau devis|New quote/ })
    .first()
    .click();
  const quoteForm = await fillDocumentForm(page, {
    customer: 'Atelier Ndiaye',
    taxPercent: '0',
    description: 'Audit logistique export',
    quantity: '1',
    unitPrice: '500.00',
  });
  await expect(quoteForm.getByText(frMoney('500.00', '$')).first()).toBeVisible();
  await quoteForm.getByRole('button', { name: CONFIRM }).click();

  await expect(page).toHaveURL(/\/business\/quotes\/[0-9a-f-]{36}/);
  const quoteUrl = page.url();
  const quoteHeading = page.getByRole('heading', { name: /QUO-\d{4}-0001/ });
  await expect(quoteHeading).toBeVisible();
  const quoteNumber = (await quoteHeading.innerText()).match(/QUO-\d{4}-0001/)![0];
  await expect(page.getByText(/^(Brouillon|Draft)$/).first()).toBeVisible();

  await page.getByRole('button', { name: /Envoyer au client|Send to customer/ }).click();
  await dialog(page).getByRole('button', { name: CONFIRM }).click();
  await expect(page.getByText(/^(Envoyé|Sent)$/).first()).toBeVisible();

  await page.getByRole('button', { name: /Marquer accepté|Mark accepted/ }).click();
  await dialog(page).getByRole('button', { name: CONFIRM }).click();
  const convert = page.getByRole('button', { name: /Convertir en facture|Convert to invoice/ });
  await expect(convert).toBeVisible();

  await convert.click();
  const conversion = dialog(page);
  await expect(conversion.getByLabel(/Échéance de la facture|Invoice due date/)).toHaveValue(
    /^\d{4}-\d{2}-\d{2}$/,
  );
  await conversion.getByRole('button', { name: CONFIRM }).click();

  // The new invoice carries the next number of the sequence and links back to its quote.
  await expect(page).toHaveURL(/\/business\/invoices\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { name: /INV-\d{4}-0002/ })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(quoteNumber) })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Audit logistique export' })).toBeVisible();
  await expectSandboxScreen(page, RAW_KEY);

  await page.goto(quoteUrl);
  await expect(page.getByText(/^(Converti en facture|Converted to invoice)$/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Convertir en facture|Convert to invoice/ })).toHaveCount(0);
});
