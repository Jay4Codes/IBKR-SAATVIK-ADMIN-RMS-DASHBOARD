import type { MetadataRoute } from "next";
import { currentSite } from "@/lib/site-server";

/** Only the sign-in page is worth indexing; everything behind it is private and per-client. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const site = await currentSite();
  return {
    rules: {
      userAgent: "*",
      allow: ["/$", "/login", "/social-card"],
      disallow: ["/dashboard", "/accounts", "/admin", "/api/"],
    },
    sitemap: `https://${site.host}/sitemap.xml`,
    host: `https://${site.host}`,
  };
}
