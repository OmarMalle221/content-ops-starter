import { Suspense } from 'react';
import { MfaForm } from '@/components/forms/mfa-form';

export const metadata = { title: 'MFA' };

export default function MfaPage() {
  return (
    <Suspense>
      <MfaForm />
    </Suspense>
  );
}
