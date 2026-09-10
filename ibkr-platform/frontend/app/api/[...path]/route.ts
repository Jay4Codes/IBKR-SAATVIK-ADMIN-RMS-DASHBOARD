import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Headers forwarded verbatim; anything else the browser sends is dropped. */
const FORWARDED = ["cookie", "origin", "x-requested-with", "x-tenant"] as const;

const WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const apiBaseUrl = process.env.API_INTERNAL_URL ?? "http://localhost:8000";
  const target = new URL(
    `/api/${path.map(encodeURIComponent).join("/")}`,
    apiBaseUrl,
  );
  target.search = request.nextUrl.search;

  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }

  try {
    const response = await fetch(target, {
      cache: "no-store",
      method: request.method,
      body: WITH_BODY.has(request.method) ? await request.text() : undefined,
      headers,
    });

    // The login and tenant-switch responses each set a cookie; getSetCookie()
    // keeps them as separate headers instead of folding them into one string,
    // which browsers would parse as a single malformed cookie.
    const outgoing = new Headers({
      "content-type":
        response.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    });
    for (const cookie of response.headers.getSetCookie()) {
      outgoing.append("set-cookie", cookie);
    }

    return new Response(response.body, {
      status: response.status,
      headers: outgoing,
    });
  } catch {
    return NextResponse.json({ detail: "API is unavailable" }, { status: 502 });
  }
}

export { proxy as GET, proxy as POST, proxy as DELETE };
