import { activeTenant } from "./tenant";

type Options = { method?: "GET" | "POST" | "DELETE"; body?: unknown };

async function request<T>(path: string, options: Options = {}): Promise<T> {
  const tenant = activeTenant();
  const method = options.method ?? (options.body !== undefined ? "POST" : "GET");
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: "include",
    cache: "no-store",
    headers: {
      // Names the tenant this call acts inside. The cookie already carries it;
      // the header lets one page address a different tenant without changing
      // the browser-wide choice.
      ...(tenant ? { "X-Tenant": tenant } : {}),
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  const value = await response.json();
  if (response.status === 401 && window.location.pathname !== "/login") {
    // A session that expired mid-visit. The server gates block the *next*
    // navigation; this catches the open tab, which would otherwise sit there
    // failing every poll.
    //
    // Full navigation, not next/navigation's redirect(): this runs inside a
    // TanStack Query queryFn, where a thrown NEXT_REDIRECT is never caught by
    // the router and instead surfaces as a "NEXT_REDIRECT" query error.
    const here = `${window.location.pathname}${window.location.search}`;
    window.location.replace(
      here === "/dashboard" ? "/login" : `/login?next=${encodeURIComponent(here)}`,
    );
    return new Promise<never>(() => {});
  }
  if (!response.ok) throw new Error(value.error ?? "API unavailable");
  return value.data;
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, body !== undefined ? { body } : {});
}

/** DELETE is separate: it carries no body but still mutates. */
export async function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}
