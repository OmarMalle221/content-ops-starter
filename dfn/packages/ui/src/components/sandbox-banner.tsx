import { FlaskConical } from 'lucide-react';

/** Mandatory on every demo surface: « Données fictives — Aucun fonds réel ». */
export function SandboxBanner({ text }: { text: string }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-sandbox px-4 py-1.5 text-center text-xs font-semibold tracking-wide text-sandbox-foreground"
    >
      <FlaskConical className="size-3.5" aria-hidden />
      <span>{text}</span>
    </div>
  );
}
