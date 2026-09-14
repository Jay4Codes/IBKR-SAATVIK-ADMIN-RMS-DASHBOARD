export const TENANT_COOKIE = "ibkr_tenant";

export function activeTenant(): string | null {
  if (typeof document === "undefined") return null;
  const found = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${TENANT_COOKIE}=`));
  return found ? decodeURIComponent(found.slice(TENANT_COOKIE.length + 1)) : null;
}
