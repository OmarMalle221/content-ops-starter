import Link from 'next/link';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@dfn/ui';
import { Logo } from '@/components/logo';
import { OrgInviteAccept } from '@/components/forms/org-invite-accept';
import { getSession } from '@/lib/api-server';
import { getT } from '@/lib/i18n-server';

export default async function OrgInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [{ t }, session] = await Promise.all([getT(), getSession()]);
  return (
    <main className="container flex min-h-[calc(100vh-2rem)] flex-col">
      <header className="flex h-16 items-center">
        <Logo />
      </header>
      <div className="mx-auto w-full max-w-lg py-10">
        <Card>
          <CardHeader>
            <CardTitle>{t('business.invite')}</CardTitle>
            <CardDescription>{t('app.sandbox')}</CardDescription>
          </CardHeader>
          <CardContent>
            {session && !session.mfaRequired ? (
              <OrgInviteAccept token={token} />
            ) : (
              <Button asChild>
                <Link href={`/login?next=${encodeURIComponent(`/invite/org/${token}`)}`}>
                  {t('auth.login')}
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
