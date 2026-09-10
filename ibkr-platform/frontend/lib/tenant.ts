/**
 * The active tenant, as this browser sees it.
 *
 * The server sets a readable `ibkr_tenant` cookie on sign-in and on every
 * switch. It is a *preference*, not a credential: the API re-resolves the
 * caller's membership on every request, so pointing this at a tenant the user
 * does not belong to earns a 403 rather than access.
 */
export const TENANT_COOKIE = "ibkr_tenant";

export function activeTenant(): string | null {
  if (typeof document === "undefined") return null;
  const found = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${TENANT_COOKIE}=`));
  return found ? decodeURIComponent(found.slice(TENANT_COOKIE.length + 1)) : null;
}
