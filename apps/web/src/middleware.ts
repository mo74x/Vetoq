import { NextResponse, type NextRequest } from 'next/server';

const apiInternalUrl = (process.env.API_INTERNAL_URL ?? 'http://localhost:3001').replace(/\/$/, '');

export async function middleware(request: NextRequest) {
  const host = (request.headers.get('host') ?? '').split(':')[0].toLowerCase();
  const mainHost = (process.env.WEB_URL ? new URL(process.env.WEB_URL).hostname : 'localhost').toLowerCase();

  if (host && host !== mainHost && host !== '127.0.0.1' && request.nextUrl.pathname.startsWith('/review/')) {
    try {
      const res = await fetch(`${apiInternalUrl}/v1/review/resolve-domain?host=${encodeURIComponent(host)}`);
      if (res.ok) {
        const { slug } = (await res.json()) as { slug: string };
        const url = request.nextUrl.clone();
        url.pathname = `/p/${slug}${request.nextUrl.pathname}`;
        return NextResponse.rewrite(url);
      }
    } catch {
      // Fall through to normal routing on lookup error
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/review/:path*'],
};
