import type { RiskReason } from '@/domain/model';
import type { Translator } from '@/i18n';

/** Renders an explainable risk reason in the viewer's language. */
export function riskReasonText(t: Translator, reason: RiskReason): string {
    const p: Record<string, string | number> = { ...reason.params };
    if (typeof p.role === 'string') p.role = t(`partyRole.${p.role}`);
    if (typeof p.documentType === 'string') p.documentType = t(`documentType.${p.documentType}`);
    if (typeof p.status === 'string') p.status = t(`kyc.${p.status}`);
    if (typeof p.types === 'string')
        p.types = p.types
            .split(',')
            .map((x) => t(`documentType.${x}`))
            .join(', ');
    return t(`riskReason.${reason.code}`, p);
}
