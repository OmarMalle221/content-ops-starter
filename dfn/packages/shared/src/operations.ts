import { RegulatoryGateLevel } from './enums';

/**
 * Review-queue SLA (hours from alert creation to first decision), by severity. Overridable with
 * REVIEW_SLA_HOURS_HIGH / _MEDIUM / _LOW on the API.
 */
export const REVIEW_SLA_DEFAULT_HOURS = { HIGH: 24, MEDIUM: 72, LOW: 168 } as const;

export interface RegulatoryGateDefinition {
  code: string;
  title: string;
  jurisdiction: string;
  referenceDoc: string;
  level: RegulatoryGateLevel;
}

/**
 * Regulatory gates of ROADMAP.md §10. Tracking register only: satisfying every gate does NOT
 * switch the platform out of sandbox — DFN_MODE stays "sandbox" in this code base.
 */
export const REGULATORY_GATES: readonly RegulatoryGateDefinition[] = [
  {
    code: 'R1',
    title:
      'Avis juridique écrit sur la qualification des activités (Protect, Wallet, Transfer) et le modèle « fonds détenus par un partenaire agréé »',
    jurisdiction: 'Canada, Québec, Sénégal, Guinée',
    referenceDoc: 'docs/compliance/README.md',
    level: RegulatoryGateLevel.BLOCKING,
  },
  {
    code: 'R2',
    title:
      'Fournisseur KYC/KYB et criblage sanctions contractualisé ; fin des statuts SIMULATED_* en production',
    jurisdiction: 'Toutes',
    referenceDoc: 'docs/compliance/KYC_KYB.md',
    level: RegulatoryGateLevel.BLOCKING,
  },
  {
    code: 'R3',
    title:
      'Inscription ESM auprès de CANAFE (ou confirmation écrite de non-assujettissement) ; programme LBC/FT approuvé',
    jurisdiction: 'Canada',
    referenceDoc: 'docs/compliance/CANADA_CANAFE.md',
    level: RegulatoryGateLevel.BLOCKING,
  },
  {
    code: 'R4',
    title:
      "Enregistrement fournisseur de services de paiement (Banque du Canada, LAPD) ou analyse d'exclusion validée ; protection des fonds",
    jurisdiction: 'Canada',
    referenceDoc: 'docs/compliance/CANADA_BANQUE_DU_CANADA.md',
    level: RegulatoryGateLevel.BLOCKING,
  },
  {
    code: 'R5',
    title: "Permis d'entreprise de services monétaires (AMF) ou confirmation de non-assujettissement",
    jurisdiction: 'Québec',
    referenceDoc: 'docs/compliance/QUEBEC_ESM.md',
    level: RegulatoryGateLevel.BLOCKING,
  },
  {
    code: 'R6',
    title:
      'Partenariat avec une banque / un EME agréé BCEAO et conformité change ; équivalent BCRG pour la Guinée',
    jurisdiction: 'UEMOA, Guinée',
    referenceDoc: 'docs/compliance/SENEGAL_BCEAO.md',
    level: RegulatoryGateLevel.BLOCKING,
  },
  {
    code: 'R7',
    title:
      "Protection des données : EFVP (Loi 25), déclarations CDP, transferts transfrontaliers, registre d'incidents",
    jurisdiction: 'Toutes',
    referenceDoc: 'docs/compliance/DATA_PROTECTION.md',
    level: RegulatoryGateLevel.BLOCKING,
  },
  {
    code: 'R8',
    title:
      "Audit de sécurité indépendant (test d'intrusion, revue du registre et des gardes), plan de reprise testé",
    jurisdiction: '—',
    referenceDoc: 'SECURITY.md',
    level: RegulatoryGateLevel.BLOCKING,
  },
  {
    code: 'R9',
    title:
      "Assurance responsabilité / cyber, conditions d'utilisation et politique de litiges validées par un conseil",
    jurisdiction: 'Canada, Québec',
    referenceDoc: 'docs/compliance/DISPUTE_HANDLING.md',
    level: RegulatoryGateLevel.STRONG,
  },
  {
    code: 'R10',
    title: 'Activité DDA : avis juridique spécifique, aucun lancement sans cadre explicite',
    jurisdiction: 'Canada, UEMOA',
    referenceDoc: 'docs/compliance/STABLECOIN_RISKS.md',
    level: RegulatoryGateLevel.ABSOLUTE,
  },
];
