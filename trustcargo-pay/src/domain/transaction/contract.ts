import { FULL_BPS } from '../money';
import type { ContractTerms, MilestoneTerm } from '../model';

export type MilestoneIssue =
    'NO_MILESTONES' | 'TOO_MANY_MILESTONES' | 'SHARE_NOT_POSITIVE' | 'SUM_NOT_100' | 'DUPLICATE_KEY' | 'MISSING_TITLE';

export const MAX_MILESTONES = 10;

export function validateMilestoneTerms(milestones: readonly MilestoneTerm[]): MilestoneIssue[] {
    const issues = new Set<MilestoneIssue>();
    if (milestones.length === 0) issues.add('NO_MILESTONES');
    if (milestones.length > MAX_MILESTONES) issues.add('TOO_MANY_MILESTONES');
    const keys = new Set<string>();
    let total = 0;
    for (const m of milestones) {
        if (!Number.isInteger(m.shareBps) || m.shareBps <= 0) issues.add('SHARE_NOT_POSITIVE');
        if (keys.has(m.key)) issues.add('DUPLICATE_KEY');
        if (!m.title.trim()) issues.add('MISSING_TITLE');
        keys.add(m.key);
        total += m.shareBps;
    }
    if (milestones.length > 0 && total !== FULL_BPS) issues.add('SUM_NOT_100');
    return [...issues];
}

export function totalShareBps(milestones: readonly { shareBps: number }[]): number {
    return milestones.reduce((acc, m) => acc + m.shareBps, 0);
}

type TermsField = keyof ContractTerms;

/** Top-level fields that changed between two versions — shown to parties before re-acceptance. */
export function diffTerms(previous: ContractTerms, next: ContractTerms): TermsField[] {
    const fields = Object.keys(next) as TermsField[];
    return fields.filter((f) => JSON.stringify(previous[f]) !== JSON.stringify(next[f]));
}

/** Illustrative default schedule for vehicle exports. Must be explicitly accepted by both parties. */
export const DEFAULT_VEHICLE_MILESTONES: MilestoneTerm[] = [
    {
        key: 'initial-checks',
        title: 'Vérifications initiales',
        description: 'Inspection indépendante du véhicule et contrôle des documents de propriété.',
        shareBps: 1000,
        requiredEvidence: ['INSPECTION_REPORT', 'TITLE']
    },
    {
        key: 'shipping',
        title: 'Preuve d’expédition',
        description: 'Connaissement maritime et déclaration d’exportation conformes.',
        shareBps: 4000,
        requiredEvidence: ['BILL_OF_LADING', 'EXPORT_DECLARATION']
    },
    {
        key: 'final-acceptance',
        title: 'Validation finale',
        description: 'Réception du véhicule à destination et validation par l’acheteur.',
        shareBps: 5000,
        requiredEvidence: ['DELIVERY_PROOF']
    }
];
