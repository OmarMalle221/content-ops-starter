import Link from 'next/link';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Stat,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@dfn/ui';
import { StatusBadge } from '@/components/status-badge';
import { RunJobButton } from '@/components/admin/jobs-actions';
import { summaryPreview } from '@/components/admin/jobs-summary';
import { apiFetch } from '@/lib/api-server';
import { formatDate } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Tâches planifiées' };

interface JobRun {
  id: string;
  jobName: string;
  status: string;
  triggeredBy: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  summary: Record<string, unknown> | null;
  error: string | null;
}
interface JobsResponse {
  sandbox: boolean;
  schedulerEnabled: boolean;
  intervalMinutes: number;
  anonymizeAfterDays: number;
  jobs: Array<{ name: string; registered: boolean; lastRun: JobRun | null }>;
}
interface RunsResponse {
  items: JobRun[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_SIZE = 25;

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export default async function AdminJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; page?: string }>;
}) {
  const [sp, { t, locale }, data] = await Promise.all([
    searchParams,
    getT(),
    apiFetch<JobsResponse>('/v1/admin/jobs'),
  ]);
  const knownNames = data.jobs.map((j) => j.name);
  const jobFilter = sp.job && knownNames.includes(sp.job) ? sp.job : undefined;
  const page = Math.max(1, Math.floor(Number(sp.page)) || 1);
  const runs = await apiFetch<RunsResponse>(
    `/v1/admin/jobs/runs?page=${page}&pageSize=${PAGE_SIZE}${jobFilter ? `&jobName=${jobFilter}` : ''}`,
  );
  const registeredCount = data.jobs.filter((j) => j.registered).length;
  const totalPages = Math.max(1, Math.ceil(runs.total / runs.pageSize));
  const jobLabel = (name: string) => {
    const label = t(`jobsAdmin.names.${name}`);
    return label === `jobsAdmin.names.${name}` ? name : label;
  };
  const runsHref = (p: number, job = jobFilter) => `/admin/jobs?${job ? `job=${job}&` : ''}page=${p}`;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t('jobsAdmin.title')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('jobsAdmin.subtitle')} · {t('app.sandbox')}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label={t('jobsAdmin.scheduler')}
          value={data.schedulerEnabled ? t('jobsAdmin.enabled') : t('jobsAdmin.disabled')}
          hint={`${t('jobsAdmin.every')} ${data.intervalMinutes} ${t('jobsAdmin.minutes')}`}
        />
        <Stat
          label={t('jobsAdmin.registered')}
          value={`${registeredCount} / ${data.jobs.length}`}
          hint={t('jobsAdmin.registeredHint')}
        />
        <Stat
          label={t('jobsAdmin.anonymizeAfter')}
          value={`${data.anonymizeAfterDays} ${t('jobsAdmin.days')}`}
          hint={t('jobsAdmin.anonymizeHint')}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('jobsAdmin.job')}</CardTitle>
          <CardDescription>{t('jobsAdmin.bullmq')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('jobsAdmin.job')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('jobsAdmin.lastRun')}</TableHead>
                <TableHead>{t('jobsAdmin.triggeredBy')}</TableHead>
                <TableHead>{t('jobsAdmin.summary')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.jobs.map((job) => {
                const description = t(`jobsAdmin.descriptions.${job.name}`);
                return (
                  <TableRow key={job.name}>
                    <TableCell>
                      <p className="font-medium">{jobLabel(job.name)}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">{job.name}</p>
                      {description !== `jobsAdmin.descriptions.${job.name}` ? (
                        <p className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {job.registered ? (
                        <Badge variant="success">{t('jobsAdmin.registeredBadge')}</Badge>
                      ) : (
                        <Badge variant="muted">{t('jobsAdmin.notRegistered')}</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {job.lastRun ? (
                        <div className="space-y-1">
                          <StatusBadge status={job.lastRun.status} />
                          <p className="text-xs text-muted-foreground">
                            {formatDate(job.lastRun.startedAt, locale, true)} ·{' '}
                            {formatDuration(job.lastRun.durationMs)}
                          </p>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('jobsAdmin.never')}</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {job.lastRun?.triggeredBy ?? '—'}
                    </TableCell>
                    <TableCell className="max-w-xs text-xs text-muted-foreground">
                      {job.lastRun?.status === 'FAILED' ? (
                        <span className="text-destructive">{job.lastRun.error}</span>
                      ) : (
                        summaryPreview(job.lastRun?.summary)
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <RunJobButton name={job.name} label={jobLabel(job.name)} registered={job.registered} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('jobsAdmin.runs')}</CardTitle>
          <CardDescription>
            {runs.total} · {t('app.sandbox')}
          </CardDescription>
          <nav className="flex flex-wrap gap-1 pt-2" aria-label={t('jobsAdmin.runs')}>
            {[undefined, ...knownNames].map((name) => {
              const active = name === jobFilter;
              return (
                <Link
                  key={name ?? 'all'}
                  href={runsHref(1, name)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-xs',
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {name ? jobLabel(name) : t('jobsAdmin.allJobs')}
                </Link>
              );
            })}
          </nav>
        </CardHeader>
        <CardContent>
          {runs.items.length === 0 ? (
            <EmptyState title={t('jobsAdmin.noRuns')} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('jobsAdmin.started')}</TableHead>
                  <TableHead>{t('jobsAdmin.job')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead>{t('jobsAdmin.triggeredBy')}</TableHead>
                  <TableHead>{t('jobsAdmin.duration')}</TableHead>
                  <TableHead>{t('jobsAdmin.summary')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.items.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDate(run.startedAt, locale, true)}
                    </TableCell>
                    <TableCell>
                      <p className="text-sm">{jobLabel(run.jobName)}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">{run.id.slice(0, 8)}</p>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={run.status} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {run.triggeredBy}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDuration(run.durationMs)}
                    </TableCell>
                    <TableCell className="max-w-md text-xs">
                      {run.error ? (
                        <p className="text-destructive">
                          {t('jobsAdmin.error')}: {run.error}
                        </p>
                      ) : null}
                      {run.summary ? (
                        <details>
                          <summary className="cursor-pointer text-muted-foreground">
                            {summaryPreview(run.summary)}
                          </summary>
                          <pre className="mt-1 max-h-48 overflow-auto rounded-md border bg-muted p-2 font-mono text-[11px]">
                            {JSON.stringify(run.summary, null, 2)}
                          </pre>
                        </details>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {totalPages > 1 ? (
            <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {t('jobsAdmin.page')} {runs.page} / {totalPages}
              </span>
              <div className="flex gap-2">
                {runs.page > 1 ? (
                  <Link className="underline-offset-4 hover:underline" href={runsHref(runs.page - 1)}>
                    ← {t('jobsAdmin.previous')}
                  </Link>
                ) : null}
                {runs.page < totalPages ? (
                  <Link className="underline-offset-4 hover:underline" href={runsHref(runs.page + 1)}>
                    {t('jobsAdmin.next')} →
                  </Link>
                ) : null}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
