import { riskRules } from './rules';
import type { RiskEvaluation, RiskFacts, RiskRule, RiskSeverity, RiskSignal } from './types';

const SEVERITY_ORDER: RiskSeverity[] = ['LOW', 'MEDIUM', 'HIGH'];

/**
 * Explainable rules engine. It is deliberately simple: every signal carries the facts
 * that triggered it. The output is advisory — the product never blocks or confiscates
 * funds automatically on the basis of a score (see docs/compliance/AML_POLICY.md).
 */
export class RiskEngine {
  constructor(private readonly rules: RiskRule[] = riskRules) {}

  evaluate(facts: RiskFacts): RiskEvaluation {
    const signals: RiskSignal[] = [];
    for (const rule of this.rules) {
      if (!rule.appliesTo.includes(facts.event)) continue;
      const signal = rule.evaluate(facts);
      if (signal) signals.push(signal);
    }
    const totalScore = Math.min(
      100,
      signals.reduce((acc, s) => acc + s.score, 0),
    );
    const highestSeverity = signals.reduce<RiskSeverity | null>((acc, s) => {
      if (!acc) return s.severity;
      return SEVERITY_ORDER.indexOf(s.severity) > SEVERITY_ORDER.indexOf(acc) ? s.severity : acc;
    }, null);
    const recommendation: RiskEvaluation['recommendation'] =
      totalScore >= 40 || highestSeverity === 'HIGH' ? 'MANUAL_REVIEW' : totalScore > 0 ? 'MONITOR' : 'NONE';
    return { totalScore, highestSeverity, signals, recommendation };
  }

  listRules() {
    return this.rules.map((r) => ({ code: r.code, description: r.description, appliesTo: r.appliesTo }));
  }
}
