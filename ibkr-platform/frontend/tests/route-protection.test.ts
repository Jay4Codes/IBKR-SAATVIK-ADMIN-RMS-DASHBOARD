import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { safeNext, loginUrl } from "@/lib/session";

const request = (url: string, cookie?: string) =>
  new NextRequest(new URL(url, "https://rms.example.com"), {
    headers: cookie ? { cookie } : {},
  });

describe("proxy", () => {
  it("sends a signed-out visitor to /login", () => {
    const response = proxy(request("/dashboard"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://rms.example.com/login",
    );
  });

  it.each([
    "/accounts/U1234567",
    "/admin/ibkr-diagnostics",
    "/dashboard?view=positions",
    "/",
  ])("guards %s", (path) => {
    const location = proxy(request(path)).headers.get("location") ?? "";
    expect(new URL(location).pathname).toBe("/login");
    expect(new URL(location).searchParams.get("next")).toBe(path);
  });

  it("keeps the login page reachable", () => {
    expect(proxy(request("/login")).headers.get("location")).toBeNull();
  });

  it("lets a request carrying a session cookie through", () => {
    const response = proxy(request("/dashboard", "ibkr_session=abc123"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not treat the readable tenant cookie as a session", () => {
    const response = proxy(request("/dashboard", "ibkr_tenant=acme"));
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      "/login",
    );
  });
});

describe("safeNext", () => {
  it("keeps a same-origin path", () => {
    expect(safeNext("/accounts/U1?x=1")).toBe("/accounts/U1?x=1");
  });

  it.each([
    "//evil.com",
    "/\\evil.com",
    "https://evil.com",
    "http://evil.com",
    "evil.com",
    "/dashboard\\@evil.com",
    "/dashboard\nLocation: https://evil.com",
    undefined,
    "",
  ])("refuses to send the visitor to %j", (next) => {
    expect(safeNext(next as string | undefined)).toBe("/dashboard");
  });
});

describe("loginUrl", () => {
  it("omits next for the default landing page", () => {
    expect(loginUrl("/dashboard")).toBe("/login");
  });

  it("encodes the target it came from", () => {
    expect(loginUrl("/accounts/U1", "?tab=orders")).toBe(
      "/login?next=%2Faccounts%2FU1%3Ftab%3Dorders",
    );
  });
});
