/**
 * First gate: no session cookie, no protected page.
 *
 * Deliberately a cookie *presence* check and nothing more. Proxy runs on every
 * request, prefetches included, so it reads the cookie and never calls the API —
 * the Next.js authentication guide calls this an optimistic check and warns
 * against putting a lookup here. It exists to turn the common case (a visitor
 * who was never signed in) away for free, before any page renders.
 *
 * It is not the security boundary. A forged cookie gets past this and is then
 * rejected by `requireSession()` in lib/session.ts, which asks the API whether
 * the session is real before the page renders. Both gates are wanted: this one
 * is cheap and catches everyone without a cookie, that one is authoritative.
 *
 * Named `proxy`, not `middleware` — the middleware convention is deprecated in
 * Next 16 and renamed to this file.
 */
import { type NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "ibkr_session";

/** Reachable signed out. Everything not listed here requires a session. */
const PUBLIC_PATHS = new Set(["/login"]);

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  const login = new URL("/login", request.url);
  const target = `${pathname}${search}`;
  if (target !== "/dashboard") login.searchParams.set("next", target);
  return NextResponse.redirect(login);
}

export const config = {
  /**
   * Everything except Next's own build output, the API proxy, and the icon.
   * Excluding the build output matters: without it this would redirect the
   * stylesheet and every JS chunk to /login and the app would render unstyled.
   *
   * `api/` is excluded on purpose. It has to reach /auth/login while signed
   * out, and every route behind it is guarded by the API itself, which answers
   * 401 in a form the client already knows how to handle.
   */
  matcher: ["/((?!_next/static|_next/image|api/|favicon.ico|sattvic-logo.png).*)"],
};
