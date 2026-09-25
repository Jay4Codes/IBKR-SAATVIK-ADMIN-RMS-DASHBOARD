import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SiteProvider } from "@/components/site-context";
import { currentSite } from "@/lib/site-server";

export async function generateMetadata(): Promise<Metadata> {
  const site = await currentSite();
  const card = { url: "/social-card", width: 1200, height: 630, alt: `${site.title}: ${site.card.tagline}` };
  return {
    metadataBase: new URL(`https://${site.host}`),
    title: { default: site.title, template: `%s · ${site.name}` },
    description: site.description,
    applicationName: site.name,
    authors: [{ name: "Ekalon Solutions", url: "https://ekalonsolutions.com" }],
    creator: "Ekalon Solutions",
    keywords: ["IBKR", "Interactive Brokers", "risk management", "RMS", "options", "scenario P&L", site.name],
    alternates: { canonical: "/" },
    icons: {
      icon: [
        { url: site.favicon, sizes: "32x32", type: "image/png" },
        { url: site.icon, sizes: "512x512", type: "image/png" },
      ],
      shortcut: site.favicon,
      apple: { url: site.appleIcon, sizes: "180x180" },
    },
    manifest: "/manifest.webmanifest",
    openGraph: {
      type: "website",
      url: "/",
      siteName: site.name,
      title: site.title,
      description: site.description,
      locale: "en_US",
      images: [card],
    },
    twitter: {
      card: "summary_large_image",
      title: site.title,
      description: site.description,
      images: [card],
    },
    robots: {
      index: true,
      follow: false,
      googleBot: { index: true, follow: false, "max-image-preview": "large" },
    },
    formatDetection: { telephone: false, email: false, address: false },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const site = await currentSite();
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor: site.themeColor,
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const site = await currentSite();
  return (
    <html lang="en" data-site={site.key}>
      <body>
        <SiteProvider site={site}>{children}</SiteProvider>
      </body>
    </html>
  );
}
