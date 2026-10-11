'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';
import { DocumentKind } from '@dfn/shared';
import { Button, Input, Label, Select } from '@dfn/ui';
import { ClientApiError, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from './action-dialog';

export function UploadDocumentDialog({
  transactionId,
  organizationId,
  defaultKind = 'OTHER',
  onUploaded,
  variant = 'outline',
}: {
  transactionId?: string;
  organizationId?: string;
  defaultKind?: string;
  onUploaded?: (doc: any) => void;
  variant?: 'outline' | 'default';
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [kind, setKind] = useState(defaultKind);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  return (
    <ActionDialog
      trigger={
        <Button type="button" variant={variant} size="sm">
          <Upload /> {t('actions.UPLOAD_DOCUMENT')}
        </Button>
      }
      title={t('docs.upload')}
      description={t('docs.encrypted')}
      confirmLabel={t('common.upload')}
      disabled={!file}
      onConfirm={async () => {
        if (!file) return;
        const fd = new FormData();
        fd.append('file', file);
        fd.append('kind', kind);
        if (title) fd.append('title', title);
        if (organizationId && !transactionId) fd.append('organizationId', organizationId);
        const res = await fetch(
          transactionId ? `/api/v1/transactions/${transactionId}/documents` : '/api/v1/documents',
          { method: 'POST', body: fd, credentials: 'include' },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(errorMessage(new ClientApiError(res.status, body)));
        setFile(null);
        setTitle('');
        onUploaded?.(body);
        router.refresh();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="doc-kind">{t('docs.kind')}</Label>
        <Select id="doc-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.values(DocumentKind).map((k) => (
            <option key={k} value={k}>
              {t(`docs.kinds.${k}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="doc-title">{t('tx.title')}</Label>
        <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="doc-file">{t('docs.file')}</Label>
        <Input
          id="doc-file"
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>
    </ActionDialog>
  );
}
