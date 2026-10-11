'use client';
import { Button } from '@dfn/ui';

export interface ChecklistOption {
  value: string;
  label: string;
  hint?: string;
}

/** Checkbox list used for API scopes and webhook events, with select-all / clear helpers. */
export function Checklist({
  idPrefix,
  options,
  selected,
  onChange,
  selectAllLabel,
  clearLabel,
}: {
  idPrefix: string;
  options: ChecklistOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  selectAllLabel: string;
  clearLabel: string;
}) {
  const toggle = (value: string, checked: boolean) =>
    onChange(checked ? [...new Set([...selected, value])] : selected.filter((v) => v !== value));
  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={selected.length === options.length}
          onClick={() => onChange(options.map((o) => o.value))}
        >
          {selectAllLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={selected.length === 0}
          onClick={() => onChange([])}
        >
          {clearLabel}
        </Button>
      </div>
      <div className="grid max-h-64 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
        {options.map((o) => {
          const id = `${idPrefix}-${o.value.replace(/[^a-z0-9]/gi, '-')}`;
          return (
            <label
              key={o.value}
              htmlFor={id}
              className="flex cursor-pointer items-start gap-2 rounded p-1.5 text-sm hover:bg-muted"
            >
              <input
                id={id}
                type="checkbox"
                className="mt-0.5 size-4 accent-primary"
                checked={selected.includes(o.value)}
                onChange={(e) => toggle(o.value, e.target.checked)}
              />
              <span>
                <span className="font-mono text-xs">{o.label}</span>
                {o.hint ? <span className="block text-xs text-muted-foreground">{o.hint}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
