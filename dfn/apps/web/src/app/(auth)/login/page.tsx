import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/forms/login-form';
import { getSession } from '@/lib/api-server';

export const metadata = { title: 'Connexion' };

export default async function LoginPage() {
  const session = await getSession();
  if (session && !session.mfaRequired) redirect('/dashboard');
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
