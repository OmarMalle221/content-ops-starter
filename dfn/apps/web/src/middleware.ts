import { NextResponse, type NextRequest } from 'next/server';

const COOKIE = process.env.SESSION_COOKIE_NAME ?? 'dfn_session';
const PROTECTED = [
  '/dashboard',
  '/transactions',
  '/wallet',
  '/transfers',
  '/business',
  '/documents',
  '/disputes',
  '/notifications',
  '/settings',
  '/admin',
];

/** Cheap first line: redirect to login when no session cookie is present. The API re-validates every request. */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`)) && !req.cookies.get(COOKIE)) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!api|_next|favicon.ico|.*\\..*).*)'] };
