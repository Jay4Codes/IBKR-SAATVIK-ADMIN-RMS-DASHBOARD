import { headers } from "next/headers";
import { siteFor, type Site } from "./site";

/** The brand for the host this request arrived on. nginx forwards the original Host. */
export async function currentSite(): Promise<Site> {
  const list = await headers();
  return siteFor(list.get("x-forwarded-host") ?? list.get("host"));
}
