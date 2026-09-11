/**
 * Server-side route protection.
 *
 * The API guards every endpoint, so an unauthenticated visitor could never read
 * data — but until this existed the pages themselves rendered for anyone, and
 * the bounce to /login only happened once a client-side fetch came back 401.
 * That put the whole operations UI, diagnostics included, on the public web and
 * made "am I signed in?" a question the browser answered.
 *
 * These helpers answer it on the server, before a protected page renders, by
 * asking the API who the caller is. A cookie is not treated as proof: only a
 * session the API still recognises counts, so a revoked or expired session is
 * turned away on the next navigation rather than after a failed fetch.
 */
// No `server-only` guard: it is not a dependency here, and importing
// `next/headers` already makes this module fail to build inside a client
// component, which is the same protection.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const SESSION_COOKIE = "ibkr_session";

export type Principal = {
  id: string;
  email: string;
  role: "ADMIN" | "TRADER";
  is_super_admin: boolean;
  accounts: string[];
  tenant: { tenant_id: string; is_admin: boolean } | null;
  impersonating: boolean;
};

/**
 * A post-sign-in destination that cannot leave this origin.
 *
 * `next` reaches us from a URL the visitor controls, and handing it to
 * `redirect()` unchecked turns the login page into an open redirect. Only a
 * single-slash absolute path survives: `//evil.com` and `/\evil.com` are both
 * protocol-relative URLs in a browser, and a backslash is a slash to some
 * parsers, so anything past the first character that is not a path character
 * is rejected outright.
 */
export function safeNext(next: string | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/")) return fallback;
  if (next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (next.includes("\\") || next.includes("\n") || next.includes("\r")) return fallback;
  return next;
}

export function loginUrl(pathname: string, search = ""): string {
  const target = `${pathname}${search}`;
  return target === "/dashboard"
    ? "/login"
    : `/login?next=${encodeURIComponent(target)}`;
}

/**
 * The signed-in caller, or null. Never throws: an API that is down or slow
 * leaves the visitor unauthenticated, which the callers below turn into a
 * redirect to /login. Failing closed is the only safe direction here — a
 * 502 must not become "render the admin page".
 */
export async function sessionPrincipal(): Promise<Principal | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const apiBaseUrl = process.env.API_INTERNAL_URL ?? "http://localhost:8000";
  try {
    const response = await fetch(new URL("/api/v1/auth/me", apiBaseUrl), {
      cache: "no-store",
      headers: {
        accept: "application/json",
        cookie: `${SESSION_COOKIE}=${token}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return (body?.data as Principal) ?? null;
  } catch {
    return null;
  }
}

/** Gate a page on being signed in. Redirects to /login when not. */
export async function requireSession(
  pathname: string,
  search = "",
): Promise<Principal> {
  const principal = await sessionPrincipal();
  if (!principal) redirect(loginUrl(pathname, search));
  return principal;
}

/**
 * Gate a page on tenant administration — the same bar
 * `require_tenant_admin` sets on the endpoints these pages call, so the UI
 * stops offering a screen whose every request would come back 403.
 */
export async function requireTenantAdmin(
  pathname: string,
  search = "",
): Promise<Principal> {
  const principal = await requireSession(pathname, search);
  if (principal.role !== "ADMIN") redirect("/dashboard");
  return principal;
}
