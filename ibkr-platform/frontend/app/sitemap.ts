import type { MetadataRoute } from "next";
import { currentSite } from "@/lib/site-server";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = await currentSite();
  return [{ url: `https://${site.host}/login`, changeFrequency: "monthly", priority: 1 }];
}
