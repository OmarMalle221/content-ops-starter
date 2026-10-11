'use client';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { Alert, AlertDescription } from '@dfn/ui';

export function FormMessage({ error, success }: { error?: string | null; success?: string | null }) {
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (success) {
    return (
      <Alert variant="success">
        <CheckCircle2 className="size-4" />
        <AlertDescription>{success}</AlertDescription>
      </Alert>
    );
  }
  return null;
}
