import { getCurrency, minorToDecimalString, parseDecimalToMinor } from '@dfn/shared';
import type {
  RiskEvent,
  RiskSeverity,
  RiskSignal,
  StructuringFacts,
  StructuringFlow,
  StructuringOperation,
  StructuringOperationKind,
  StructuringSubject,
} from './types';

export const STRUCTURING_RULE_CODE = 'STRUCTURING';

/** Events on which the API computes structuring facts (one operation kind per event). */
export const STRUCTURING_EVENT_KINDS: Partial<Record<RiskEvent, StructuringOperationKind>> = {
  'transaction.funded': 'PROTECT_FUNDING',
  'transfer.authorized': 'TRANSFER',
  'wallet.self_deposit': 'SELF_DEPOSIT',
  'invoice.wallet_payment': 'INVOICE_PAYMENT',
};

export const STRUCTURING_FLOW_OF: Record<StructuringOperationKind, StructuringFlow> = {
  SELF_DEPOSIT: 'INBOUND',
  PROTECT_FUNDING: 'INBOUND',
  TRANSFER: 'OUTBOUND',
  INVOICE_PAYMENT: 'OUTBOUND',
};

/** Kinds aggregated together for a flow. */
export function structuringKindsOf(flow: StructuringFlow): StructuringOperationKind[] {
  return (Object.keys(STRUCTURING_FLOW_OF) as StructuringOperationKind[]).filter(
    (k) => STRUCTURING_FLOW_OF[k] === flow,
  );
}

/** Maximum number of operations itemised in the explanation (the counts always cover them all). */
export const STRUCTURING_EVIDENCE_LIMIT = 50;

/**
 * The aggregate threshold is configured once as a nominal decimal ("10000.00") and applied to every
 * currency: the fraction is re-scaled (truncated or padded) to the currency exponent before parsing,
 * so "10000.00" means 10 000.00 CAD (1 000 000 minor units) and 10 000 XOF (10 000 minor units).
 */
/**
 * Parses STRUCTURING_THRESHOLD: comma-separated entries, either a plain decimal (the default for
 * every currency, at most one) or `CCC:decimal` for a specific currency, e.g.
 * `10000.00,XOF:4400000,GNF:63000000`. Returns the decimal threshold to apply to `currencyCode`,
 * or null when neither a currency entry nor a default exists (structuring is then not evaluated).
 */
export function structuringThresholdFor(spec: string, currencyCode: string): string | null {
  let fallback: string | null = null;
  for (const raw of spec
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const [left, right] = raw.split(':');
    if (right === undefined) {
      fallback = left!;
    } else if (left!.toUpperCase() === currencyCode.toUpperCase()) {
      return right;
    }
  }
  return fallback;
}

/** True when every entry of a STRUCTURING_THRESHOLD specification is well formed. */
export function isValidStructuringThresholdSpec(spec: string): boolean {
  const entries = spec.split(',').map((e) => e.trim());
  if (!entries.length || entries.some((e) => !e)) return false;
  let defaults = 0;
  for (const entry of entries) {
    if (/^\d{1,13}([.,]\d{1,2})?$/.test(entry)) defaults++;
    else if (!/^[A-Z]{3}:\d{1,13}([.,]\d{1,2})?$/.test(entry)) return false;
  }
  return defaults <= 1;
}

export function structuringThresholdMinor(threshold: string, currencyCode: string): bigint {
  const { exponent } = getCurrency(currencyCode);
  const [whole, frac = ''] = threshold.trim().replace(',', '.').split('.');
  const scaledFrac = frac.slice(0, exponent).padEnd(exponent, '0');
  return parseDecimalToMinor(exponent === 0 ? whole : `${whole}.${scaledFrac}`, currencyCode);
}

export interface StructuringSubjectAnalysis {
  subject: StructuringSubject;
  /** Operations strictly below the threshold (and above zero), oldest first. */
  operations: StructuringOperation[];
  count: number;
  sumMinor: bigint;
  triggered: boolean;
  severity: RiskSeverity | null;
}

export interface StructuringAnalysis {
  thresholdMinor: bigint;
  subjects: StructuringSubjectAnalysis[];
  /** The subject retained for the signal (most operations, then largest sum, organisation first). */
  retained: StructuringSubjectAnalysis | null;
}

const byTime = (a: StructuringOperation, b: StructuringOperation) =>
  a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0;

/**
 * Pure analysis: per subject, keeps the operations each BELOW the threshold and fires when at least
 * two of them add up to the threshold or more. When the triggering operation is identified
 * (`current`), it must itself be one of these below-threshold operations: a single large operation
 * is not structuring (it is caught by the high-value rules instead).
 */
export function analyzeStructuring(facts: StructuringFacts): StructuringAnalysis {
  const thresholdMinor = structuringThresholdMinor(facts.threshold, facts.currencyCode);
  const subjects = facts.subjects.map<StructuringSubjectAnalysis>((subject) => {
    const seen = new Set<string>();
    const operations = subject.operations
      .filter((op) => op.amountMinor > 0n && op.amountMinor < thresholdMinor)
      .filter((op) => {
        const key = `${op.kind}:${op.reference}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort(byTime);
    const count = operations.length;
    const sumMinor = operations.reduce((acc, op) => acc + op.amountMinor, 0n);
    const hasCurrent = subject.operations.some((op) => op.current);
    const currentIncluded = !hasCurrent || operations.some((op) => op.current);
    const triggered = thresholdMinor > 0n && count >= 2 && sumMinor >= thresholdMinor && currentIncluded;
    return {
      subject,
      operations,
      count,
      sumMinor,
      triggered,
      severity: triggered ? (count >= 3 ? 'HIGH' : 'MEDIUM') : null,
    };
  });
  const retained =
    subjects
      .filter((s) => s.triggered)
      .sort((a, b) => {
        if (a.count !== b.count) return b.count - a.count;
        if (a.sumMinor !== b.sumMinor) return a.sumMinor > b.sumMinor ? -1 : 1;
        if (a.subject.type !== b.subject.type) return a.subject.type === 'ORGANIZATION' ? -1 : 1;
        return 0;
      })[0] ?? null;
  return { thresholdMinor, subjects, retained };
}

/**
 * Stable de-duplication key of a structuring pattern: one open alert per subject, currency and
 * flow within the window.
 */
export function structuringDedupKey(
  flow: StructuringFlow,
  subject: Pick<StructuringSubject, 'type' | 'id'>,
  currencyCode: string,
): string {
  return `${STRUCTURING_RULE_CODE}:${flow}:${subject.type}:${subject.id}:${currencyCode}`;
}

/** Builds the explainable STRUCTURING signal, or null when the pattern is absent. */
export function structuringSignal(facts: StructuringFacts): RiskSignal | null {
  const analysis = analyzeStructuring(facts);
  const r = analysis.retained;
  if (!r || !r.severity) return null;
  const ccy = facts.currencyCode;
  const sum = minorToDecimalString(r.sumMinor, ccy);
  const threshold = minorToDecimalString(analysis.thresholdMinor, ccy);
  const references = r.operations.map((op) => op.reference);
  const kinds = [...new Set(r.operations.map((op) => op.kind))].sort();
  const high = r.severity === 'HIGH';
  return {
    ruleCode: STRUCTURING_RULE_CODE,
    severity: r.severity,
    score: high ? 45 : 25,
    explanation: {
      summary:
        `${r.count} operations each below ${threshold} ${ccy} total ${sum} ${ccy} within ` +
        `${facts.windowHours} h (${r.subject.type === 'ORGANIZATION' ? 'same organisation' : 'same user'}) — possible structuring`,
      factors: {
        subjectType: r.subject.type,
        subjectId: r.subject.id,
        currencyCode: ccy,
        flow: facts.flow,
        operationsCount: r.count,
        sum,
        sumMinor: r.sumMinor.toString(),
        threshold,
        thresholdMinor: analysis.thresholdMinor.toString(),
        windowHours: facts.windowHours,
        kinds: kinds.join(','),
        references: references.slice(-20).join(', '),
        dedupKey: structuringDedupKey(facts.flow, r.subject, ccy),
      },
      recommendation:
        'Review the operations together (purpose, source of funds, links between them). Do not inform the customer of a ' +
        'possible report (tipping-off); escalate to the compliance officer if suspicion is reasonable.',
      evidence: r.operations.slice(-STRUCTURING_EVIDENCE_LIMIT).map((op) => ({
        kind: op.kind,
        reference: op.reference,
        amount: minorToDecimalString(op.amountMinor, ccy),
        amountMinor: op.amountMinor.toString(),
        occurredAt: op.occurredAt,
        current: Boolean(op.current),
      })),
    },
  };
}
