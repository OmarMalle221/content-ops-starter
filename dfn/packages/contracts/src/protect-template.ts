import { hashContract } from './hash';
import type { ProtectContractTerms, RenderedContract } from './types';

export const PROTECT_TEMPLATE_CODE = 'DFN_PROTECT_CONDITIONAL_PAYMENT';
export const PROTECT_TEMPLATE_VERSION = '1.0.0-sandbox';

const L = {
  fr: {
    title: 'CONVENTION DE PAIEMENT CONDITIONNEL — DIASPORA PROTECT (SANDBOX)',
    notice:
      'DOCUMENT DE DÉMONSTRATION. Données fictives — Aucun fonds réel. Cette convention ne crée aucune obligation financière réelle tant que la plateforme fonctionne en mode sandbox et sans partenaire financier agréé.',
    parties: 'PARTIES',
    buyer: 'Acheteur',
    seller: 'Vendeur',
    object: 'OBJET',
    amount: 'MONTANT ET DEVISE',
    fee: 'Frais de plateforme (simulés)',
    conditions: 'CONDITIONS DE RÈGLEMENT',
    milestones: 'JALONS DE LIVRAISON ET DE LIBÉRATION',
    evidence: 'Preuves requises',
    delivery: 'Délai de livraison maximal',
    inspection: "Fenêtre d'inspection après livraison",
    days: 'jours',
    disputes: 'LITIGES',
    disputesText:
      "Toute partie peut ouvrir une contestation tant que des fonds sont détenus. L'ouverture d'une contestation gèle automatiquement les libérations. La décision motivée de l'équipe de révision peut faire l'objet d'une demande de révision dans le délai indiqué dans la décision.",
    law: 'DROIT APPLICABLE',
    custody:
      'GARDE DES FONDS : les fonds réels seront toujours détenus et manipulés par un prestataire légalement habilité. En mode sandbox, un partenaire simulé confirme la réception et exécute des libérations fictives.',
    acceptance: 'ACCEPTATION',
    acceptanceText:
      "Chaque partie accepte la présente version en cliquant sur « Accepter les conditions ». L'empreinte numérique (SHA-256) de la version acceptée est conservée dans l'historique de la transaction.",
    clauses: 'CLAUSES ADDITIONNELLES',
  },
  en: {
    title: 'CONDITIONAL PAYMENT AGREEMENT — DIASPORA PROTECT (SANDBOX)',
    notice:
      'DEMONSTRATION DOCUMENT. Simulated data — No real funds. This agreement creates no real financial obligation while the platform runs in sandbox mode without a licensed financial partner.',
    parties: 'PARTIES',
    buyer: 'Buyer',
    seller: 'Seller',
    object: 'SUBJECT',
    amount: 'AMOUNT AND CURRENCY',
    fee: 'Platform fee (simulated)',
    conditions: 'SETTLEMENT CONDITIONS',
    milestones: 'DELIVERY AND RELEASE MILESTONES',
    evidence: 'Required evidence',
    delivery: 'Maximum delivery time',
    inspection: 'Inspection window after delivery',
    days: 'days',
    disputes: 'DISPUTES',
    disputesText:
      'Either party may open a dispute while funds are held. Opening a dispute automatically freezes releases. The reasoned decision of the review team can be appealed within the period stated in the decision.',
    law: 'GOVERNING LAW',
    custody:
      'CUSTODY OF FUNDS: real funds are always held and handled by a legally authorised provider. In sandbox mode a simulated partner confirms receipt and executes fictitious releases.',
    acceptance: 'ACCEPTANCE',
    acceptanceText:
      'Each party accepts this version by clicking “Accept terms”. The SHA-256 fingerprint of the accepted version is kept in the transaction history.',
    clauses: 'ADDITIONAL CLAUSES',
  },
} as const;

export function renderProtectContract(
  terms: ProtectContractTerms,
  locale: 'fr' | 'en' = 'fr',
): RenderedContract {
  const t = L[locale];
  const buyer = terms.parties.find((p) => p.role === 'BUYER');
  const seller = terms.parties.find((p) => p.role === 'SELLER');
  const lines: string[] = [];
  lines.push(t.title, '', t.notice, '', `Référence / Reference: ${terms.transactionReference}`, '');
  lines.push(`1. ${t.parties}`);
  lines.push(
    `   ${t.buyer}: ${buyer?.displayName ?? '—'} <${buyer?.email ?? '—'}>${buyer?.country ? ` (${buyer.country})` : ''}`,
  );
  lines.push(
    `   ${t.seller}: ${seller?.displayName ?? '—'} <${seller?.email ?? '—'}>${seller?.country ? ` (${seller.country})` : ''}`,
  );
  lines.push(
    '',
    `2. ${t.object}`,
    `   ${terms.title}`,
    `   ${terms.description}`,
    `   ${terms.category} — ${terms.originCountry} → ${terms.destinationCountry}`,
  );
  lines.push(
    '',
    `3. ${t.amount}`,
    `   ${terms.totalAmount} ${terms.currencyCode}`,
    `   ${t.fee}: ${terms.platformFee} ${terms.currencyCode}`,
  );
  lines.push('', `4. ${t.conditions}`);
  lines.push(`   ${t.delivery}: ${terms.deliveryDeadlineDays} ${t.days}`);
  lines.push(`   ${t.inspection}: ${terms.inspectionWindowDays} ${t.days}`);
  lines.push('', `5. ${t.milestones}`);
  for (const m of terms.milestones) {
    lines.push(`   ${m.sequence}. ${m.title} — ${m.amount} ${terms.currencyCode}`);
    if (m.description) lines.push(`      ${m.description}`);
    lines.push(`      ${t.evidence}: ${m.requiredEvidence.join(', ') || '—'}`);
  }
  lines.push('', `6. ${t.disputes}`, `   ${t.disputesText}`);
  lines.push('', `7. ${t.law}`, `   ${terms.governingLaw}`);
  lines.push('', `8. ${t.custody}`);
  if (terms.additionalClauses) lines.push('', `9. ${t.clauses}`, `   ${terms.additionalClauses}`);
  lines.push('', `${t.acceptance}`, `${t.acceptanceText}`);
  const bodyText = lines.join('\n');
  return {
    templateCode: PROTECT_TEMPLATE_CODE,
    templateVersion: PROTECT_TEMPLATE_VERSION,
    locale,
    bodyText,
    contentHash: hashContract(PROTECT_TEMPLATE_CODE, PROTECT_TEMPLATE_VERSION, terms, bodyText),
  };
}
