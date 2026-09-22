import { activeTenant } from "./tenant";

type Options = { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown };

async function request<T>(path: string, options: Options = {}): Promise<T> {
  const tenant = activeTenant();
  const method = options.method ?? (options.body !== undefined ? "POST" : "GET");
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: "include",
    cache: "no-store",
    headers: {
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

/** PATCH changes one field of something that already exists. */
export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body });
}

export async function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}
