'use client';
import { AlertTriangle } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@dfn/ui';
import { CopyButton } from '@/components/copy-button';
import { useI18n } from '@/lib/i18n-client';

/**
 * Shows a secret (API key or webhook signing secret) exactly once. The value lives only in the
 * parent's state: once the dialog is closed it cannot be displayed again, mirroring the API.
 */
export function SecretRevealDialog({
  secret,
  title,
  description,
  warning,
  onClose,
}: {
  secret: string | null;
  title: string;
  description: string;
  warning: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open={secret !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/40 p-3">
          <code className="block break-all font-mono text-sm" data-testid="revealed-secret">
            {secret ?? ''}
          </code>
        </div>
        <div className="flex items-center justify-between gap-2">
          <Badge variant="sandbox">{t('app.sandbox')}</Badge>
          <CopyButton value={secret ?? ''} />
        </div>
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t('dev.keys.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
