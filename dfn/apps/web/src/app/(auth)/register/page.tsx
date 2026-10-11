import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { RegisterForm } from '@/components/forms/register-form';
import { getSession } from '@/lib/api-server';

export const metadata = { title: 'Inscription' };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ invitation?: string }>;
}) {
  const session = await getSession();
  if (session && !session.mfaRequired) redirect('/dashboard');
  const { invitation } = await searchParams;
  return (
    <Suspense>
      <RegisterForm invitationToken={invitation} />
    </Suspense>
  );
}
