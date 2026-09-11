import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const cookieValue = vi.fn<() => string | undefined>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "ibkr_session" && cookieValue()
        ? { name, value: cookieValue() }
        : undefined,
  }),
}));

// redirect() throws in Next so nothing after it runs; mirror that here, or a
// test could pass while the real page carried on rendering past the gate.
class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));

const { sessionPrincipal, requireSession, requireTenantAdmin } = await import(
  "@/lib/session"
);

const principal = (role: "ADMIN" | "TRADER") => ({
  ok: true,
  json: async () => ({ data: { id: "u1", email: "a@b.c", role } }),
});

beforeEach(() => {
  cookieValue.mockReturnValue("session-token");
  process.env.API_INTERNAL_URL = "http://127.0.0.1:8120";
});
afterEach(() => vi.restoreAllMocks());

describe("sessionPrincipal", () => {
  it("returns the caller the API vouches for", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => principal("ADMIN")));
    expect(await sessionPrincipal()).toMatchObject({ email: "a@b.c" });
  });

  it("sends the session cookie to the API", async () => {
    const fetchMock = vi.fn(async () => principal("TRADER"));
    vi.stubGlobal("fetch", fetchMock);
    await sessionPrincipal();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("http://127.0.0.1:8120/api/v1/auth/me");
    expect((init.headers as Record<string, string>).cookie).toBe(
      "ibkr_session=session-token",
    );
  });

  it("does not call the API when there is no cookie", async () => {
    cookieValue.mockReturnValue(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await sessionPrincipal()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a cookie the API rejects as signed out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));
    expect(await sessionPrincipal()).toBeNull();
  });

  // The important one: an unreachable API must not become "render the page".
  it("fails closed when the API is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    expect(await sessionPrincipal()).toBeNull();
  });
});

describe("requireSession", () => {
  it("redirects to /login, remembering where the visitor was going", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));
    await expect(requireSession("/accounts/U1")).rejects.toThrow(
      "redirect:/login?next=%2Faccounts%2FU1",
    );
  });

  it("lets a live session through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => principal("TRADER")));
    await expect(requireSession("/dashboard")).resolves.toMatchObject({
      role: "TRADER",
    });
  });
});

describe("requireTenantAdmin", () => {
  it("keeps a non-admin off the diagnostics page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => principal("TRADER")));
    await expect(
      requireTenantAdmin("/admin/ibkr-diagnostics"),
    ).rejects.toThrow("redirect:/dashboard");
  });

  it("admits an admin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => principal("ADMIN")));
    await expect(
      requireTenantAdmin("/admin/ibkr-diagnostics"),
    ).resolves.toMatchObject({ role: "ADMIN" });
  });

  it("sends a signed-out visitor to login, not the dashboard", async () => {
    cookieValue.mockReturnValue(undefined);
    await expect(requireTenantAdmin("/admin/ibkr-diagnostics")).rejects.toThrow(
      "redirect:/login?next=%2Fadmin%2Fibkr-diagnostics",
    );
  });
});
