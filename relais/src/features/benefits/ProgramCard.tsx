import { Link } from 'react-router';
import { benefits as tb, PROGRAM_STATUS_LABELS } from '../../i18n/benefits.fr';
import type { FileProgram, Program } from '../../lib/benefits';
import { formatDate } from '../../lib/format';
import type { Assessment, Outcome } from '../../shared/benefits/engine';

const OUTCOME_LABEL: Record<Outcome, string> = { met: tb.met, not_met: tb.notMet, unknown: tb.unknownCriterion };
const OUTCOME_MARK: Record<Outcome, string> = { met: '✓', not_met: '✗', unknown: '?' };

/** Source officielle, date de vérification (ou « À VÉRIFIER ») et admissibilité à confirmer : sur chaque carte. */
export function ProgramSource({ program }: { program: Program }) {
    return (
        <div className="flex flex-col gap-1 rounded-lg bg-canvas p-3" data-testid="program-source">
            <p>
                {tb.source(program.source_label)}
                {program.official_url ? (
                    <>
                        {' — '}
                        <a
                            href={program.official_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-bold text-brand underline underline-offset-4"
                        >
                            {tb.officialLink}
                        </a>
                    </>
                ) : (
                    ` — ${tb.officialLinkMissing}`
                )}
            </p>
            <p className={program.verification_status === 'verified' ? 'text-muted' : 'font-bold text-urgent'}>
                {program.verification_status === 'verified' && program.verified_on
                    ? tb.verifiedOn(formatDate(program.verified_on))
                    : tb.toVerify}
            </p>
            <p className="font-bold">{tb.confirmEligibility(program.organization)}</p>
        </div>
    );
}

export function CriteriaReasons({ assessment }: { assessment: Assessment }) {
    return (
        <ul className="flex list-none flex-col gap-1 p-0">
            {assessment.reasons.map((reason) => (
                <li key={reason.label} className="flex gap-2">
                    <span aria-hidden="true" className="w-5 shrink-0 text-center font-bold">
                        {OUTCOME_MARK[reason.status]}
                    </span>
                    <span>
                        {reason.label} <span className="text-muted">({OUTCOME_LABEL[reason.status]})</span>
                    </span>
                </li>
            ))}
        </ul>
    );
}

export function ProgramCard({ program, assessment, fileProgram }: { program: Program; assessment: Assessment; fileProgram?: FileProgram }) {
    return (
        <article aria-labelledby={`program-${program.slug}`} className="flex flex-col gap-3 rounded-xl border-2 border-line bg-surface p-4">
            <div className="flex flex-col gap-1">
                <h3 id={`program-${program.slug}`} className="text-xl font-bold">
                    {program.name}
                </h3>
                <p className="text-muted">{program.organization}</p>
                {fileProgram && (
                    <p>
                        <span className="rounded-md bg-brand-soft px-2 py-1 font-bold text-brand">
                            {PROGRAM_STATUS_LABELS[fileProgram.status]}
                        </span>
                    </p>
                )}
            </div>
            <p>{program.summary}</p>
            <CriteriaReasons assessment={assessment} />
            <ProgramSource program={program} />
            <Link to={program.slug} className="self-start font-bold text-brand underline underline-offset-4">
                {tb.details}
                <span className="sr-only"> : {program.name}</span>
            </Link>
        </article>
    );
}
