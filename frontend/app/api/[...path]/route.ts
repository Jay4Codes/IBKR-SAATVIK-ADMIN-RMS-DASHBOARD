import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const apiBaseUrl = process.env.API_INTERNAL_URL ?? "http://localhost:8000";
  const target = new URL(`/api/${path.map(encodeURIComponent).join("/")}`, apiBaseUrl);
  target.search = request.nextUrl.search;

  try {
    const response = await fetch(target, {
      cache: "no-store",
      headers: { accept: request.headers.get("accept") ?? "application/json" },
    });

    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ detail: "Market API is unavailable" }, { status: 502 });
  }
}
