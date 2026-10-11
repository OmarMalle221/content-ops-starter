import Link from 'next/link';
import { Button } from '@dfn/ui';

export default function NotFound() {
  return (
    <main className="container flex min-h-[60vh] flex-col items-center justify-center text-center">
      <p className="text-6xl font-semibold text-primary">404</p>
      <p className="mt-2 text-muted-foreground">Page introuvable / Page not found</p>
      <Button asChild className="mt-6">
        <Link href="/dashboard">Diaspora Trust</Link>
      </Button>
    </main>
  );
}
