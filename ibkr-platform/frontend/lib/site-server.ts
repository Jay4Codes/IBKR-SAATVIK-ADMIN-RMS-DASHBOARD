import { headers } from "next/headers";
import { siteFor, type Site } from "./site";

export async function currentSite(): Promise<Site> {
  const list = await headers();
  return siteFor(list.get("x-forwarded-host") ?? list.get("host"));
}
