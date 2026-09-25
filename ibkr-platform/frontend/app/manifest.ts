import type { MetadataRoute } from "next";
import { currentSite } from "@/lib/site-server";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const site = await currentSite();
  return {
    name: site.title,
    short_name: site.name,
    description: site.description,
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: site.card.background,
    theme_color: site.themeColor,
    icons: [
      { src: site.appleIcon, sizes: "180x180", type: "image/png" },
      { src: site.icon, sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
