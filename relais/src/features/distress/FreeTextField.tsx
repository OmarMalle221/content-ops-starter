import { useId, useRef, type TextareaHTMLAttributes } from 'react';
import { detectDistress } from '../../shared/distress/detect';
import { useDistress } from './DistressProvider';

/**
 * Zone de saisie libre. Toutes les saisies libres de Relais passent par ce composant : chaque
 * modification est analysée par le détecteur de détresse, et l'écran d'urgence s'affiche dès qu'une
 * phrase en évoque une. Il ne s'affiche qu'une fois par situation détectée, tant que le texte la contient.
 */
export function FreeTextField({
    label,
    hint,
    value,
    onValueChange,
    compact = false,
    ...textarea
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
    label: string;
    hint?: string;
    value: string;
    onValueChange: (value: string) => void;
    /** Zone basse (une ou deux lignes) : titres, précisions. */
    compact?: boolean;
}) {
    const id = useId();
    const { report } = useDistress();
    const lastSignature = useRef('');

    function handleChange(next: string) {
        onValueChange(next);
        const result = detectDistress(next);
        const signature = result.categories.join(',');
        if (result.level !== 'none' && signature !== lastSignature.current) report(result);
        lastSignature.current = signature;
    }

    return (
        <div className="flex flex-col gap-1">
            <label htmlFor={id} className="font-bold">
                {label}
            </label>
            {hint && (
                <p id={`${id}-hint`} className="text-muted">
                    {hint}
                </p>
            )}
            <textarea
                id={id}
                aria-describedby={hint ? `${id}-hint` : undefined}
                className={`${compact ? 'min-h-14' : 'min-h-32'} rounded-lg border-2 border-muted bg-surface p-3 text-lg`}
                value={value}
                onChange={(event) => handleChange(event.target.value)}
                {...textarea}
            />
        </div>
    );
}
