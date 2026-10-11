'use client';
import { useRouter } from 'next/navigation';
import { Select } from '@dfn/ui';

/** Select that navigates to the same page with `param` set to the chosen record (server re-renders). */
export function RecordPicker({
  label,
  options,
  value,
  basePath,
  query,
  param,
}: {
  label: string;
  options: Array<{ id: string; label: string }>;
  value: string;
  basePath: string;
  query: Record<string, string>;
  param: string;
}) {
  const router = useRouter();
  return (
    <Select
      aria-label={label}
      className="w-full sm:w-80"
      value={value}
      onChange={(e) => {
        const qs = new URLSearchParams({ ...query, [param]: e.target.value });
        router.push(`${basePath}?${qs.toString()}`);
      }}
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}
