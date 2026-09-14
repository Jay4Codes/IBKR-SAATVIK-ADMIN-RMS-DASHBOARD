import { type NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "ibkr_session";

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
  matcher: ["/((?!_next/static|_next/image|api/|favicon.ico|sattvic-logo.png).*)"],
};
