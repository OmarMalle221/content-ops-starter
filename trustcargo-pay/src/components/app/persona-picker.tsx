'use client';
import { ArrowRight, Building2, ShieldCheck } from 'lucide-react';
import { ActionForm, SubmitButton } from './action-form';
import { useI18n } from './i18n-provider';
import type { ActionState } from '@/lib/action-state';

export interface PersonaCard {
    key: string;
    fullName: string;
    headline: string;
    city: string;
    country: string;
    staff: boolean;
}

export function PersonaPicker({
    personas,
    action
}: {
    personas: PersonaCard[];
    action: (s: ActionState, f: FormData) => Promise<ActionState>;
}) {
    const { t } = useI18n();
    const groups = [
        { title: t('landing.groupParties'), items: personas.filter((p) => !p.staff), Icon: Building2 },
        { title: t('landing.groupStaff'), items: personas.filter((p) => p.staff), Icon: ShieldCheck }
    ];
    return (
        <div className="space-y-6">
            {groups.map((g) => (
                <div key={g.title}>
                    <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                        <g.Icon className="size-3.5" aria-hidden />
                        {g.title}
                    </h3>
                    <ul className="grid gap-2 sm:grid-cols-2">
                        {g.items.map((p) => (
                            <li key={p.key}>
                                <ActionForm action={action}>
                                    <input type="hidden" name="persona" value={p.key} />
                                    <SubmitButton
                                        variant="secondary"
                                        className="h-auto w-full justify-between px-4 py-3 text-left whitespace-normal"
                                        data-testid={`persona-${p.key}`}
                                        aria-label={`${t('landing.signInAs')} : ${p.fullName}`}
                                    >
                                        <span className="min-w-0">
                                            <span className="block font-semibold">{p.fullName}</span>
                                            <span className="block text-xs font-normal text-muted-foreground">
                                                {p.headline} · {p.city}
                                            </span>
                                        </span>
                                        <ArrowRight className="text-muted-foreground" aria-hidden />
                                    </SubmitButton>
                                </ActionForm>
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </div>
    );
}
