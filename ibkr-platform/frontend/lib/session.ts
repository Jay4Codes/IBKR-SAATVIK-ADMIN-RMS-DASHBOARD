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

export async function requireSession(
  pathname: string,
  search = "",
): Promise<Principal> {
  const principal = await sessionPrincipal();
  if (!principal) redirect(loginUrl(pathname, search));
  return principal;
}

export async function requireTenantAdmin(
  pathname: string,
  search = "",
): Promise<Principal> {
  const principal = await requireSession(pathname, search);
  if (principal.role !== "ADMIN") redirect("/dashboard");
  return principal;
}
