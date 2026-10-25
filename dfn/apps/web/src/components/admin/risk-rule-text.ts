import { dictionaries } from '@/lib/i18n';

type RuleTexts = Record<string, Record<string, string>>;

/** English reference texts: the risk engine writes its descriptions and explanations in English. */
const EN_RULE_TEXTS: RuleTexts = dictionaries.en.reviewQueue.ruleTexts;

/**
 * Risk-rule text (rule description, alert summary or recommendation) in the interface language.
 * A server text equal to one of the rule's known static English strings is swapped for its
 * `reviewQueue.ruleTexts.<CODE>.<field>` translation; anything else — figures, wording changed
 * server-side, unknown rule — is shown as sent.
 */
export function riskRuleText(t: (path: string) => string, ruleCode: string, text: string): string {
  const known = Object.hasOwn(EN_RULE_TEXTS, ruleCode) ? EN_RULE_TEXTS[ruleCode] : undefined;
  const field = known ? Object.keys(known).find((k) => known[k] === text) : undefined;
  return field ? t(`reviewQueue.ruleTexts.${ruleCode}.${field}`) : text;
}
