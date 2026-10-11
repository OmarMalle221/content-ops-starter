import { BookOpen } from 'lucide-react';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@dfn/ui';
import { getT } from '@/lib/i18n-server';
import type { ScopeOption } from './types';

/** Static, deterministic samples (no secrets, no dates). */
const CURL_SAMPLE = `curl -s http://localhost:4000/v1/transactions \\
  -H "Authorization: Bearer dfn_sk_xxxxxxxx_…"

curl -s -X POST http://localhost:4000/v1/transactions \\
  -H "Authorization: Bearer dfn_sk_xxxxxxxx_…" \\
  -H "Idempotency-Key: commande-2026-0001" \\
  -H "Content-Type: application/json" \\
  --data @transaction.json`;

const VERIFY_SAMPLE = `// X-DFN-Signature: t=<unix seconds>,v1=<hex>
const { createHmac, timingSafeEqual } = require('node:crypto');
const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
const valid = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'));`;

export async function DocsCard({ scopes, docsPath }: { scopes: ScopeOption[]; docsPath: string }) {
  const { t, locale } = await getT();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="size-4" /> {t('dev.docs.title')}
        </CardTitle>
        <CardDescription>{t('dev.docs.description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('dev.docs.sampleHint')}</p>
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
            {CURL_SAMPLE}
          </pre>
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
            {VERIFY_SAMPLE}
          </pre>
          <div className="space-y-1 text-sm">
            <p>
              <span className="font-medium">
                {t('dev.docs.headersTitle')}
                {locale === 'fr' ? ' :' : ':'}
              </span>{' '}
              <span className="text-muted-foreground">{t('dev.docs.headersText')}</span>
            </p>
            <p>
              <span className="font-medium">
                {t('dev.docs.errorsTitle')}
                {locale === 'fr' ? ' :' : ':'}
              </span>{' '}
              <span className="text-muted-foreground">{t('dev.docs.errorsText')}</span>
            </p>
            <p className="text-muted-foreground">
              {t('dev.docs.fullDocs')}
              {locale === 'fr' ? ' : ' : ': '}
              <code className="font-mono text-xs">{docsPath}</code> · {t('dev.docs.swagger')}
              {locale === 'fr' ? ' : ' : ': '}
              <code className="font-mono text-xs">GET /docs</code>
            </p>
          </div>
        </div>
        <div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('dev.docs.scope')}</TableHead>
                <TableHead>{t('dev.docs.scopeDescription')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scopes.map((s) => (
                <TableRow key={s.scope}>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-[11px]">
                      {s.scope}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{s.description[locale]}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
