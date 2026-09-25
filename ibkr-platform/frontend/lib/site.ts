/**
 * One build serves several hostnames. Each hostname is its own brand: page titles, link
 * previews, icons and the wordmark all follow the host the visitor typed, never the tenant.
 */
export type SiteKey = "sattvic" | "ekalon";

export type Site = {
  key: SiteKey;
  host: string;
  /** Short brand name, used for the tab title suffix and the web-app name. */
  name: string;
  /** Full title of the landing page and of link previews. */
  title: string;
  description: string;
  /** Small caps line above the sign-in heading. */
  eyebrow: string;
  footer: string;
  logo: { src: string; width: number; height: number; alt: string };
  icon: string;
  appleIcon: string;
  favicon: string;
  themeColor: string;
  card: { background: string; glow: string; accent: string; text: string; muted: string; tagline: string };
};

export const SITES: Record<SiteKey, Site> = {
  sattvic: {
    key: "sattvic",
    host: "sattvic-rms.ekalonsolutions.com",
    name: "Sattvic RMS",
    title: "Sattvic Wealth · Risk Management System",
    description:
      "Sattvic Wealth's live IBKR risk desk: positions, scenario P&L, worst-case risk and alerts across every account.",
    eyebrow: "SATTVIC / RMS",
    footer: "SATTVIC WEALTH · RMS",
    logo: { src: "/sattvic-logo.png", width: 1250, height: 829, alt: "Sattvic Wealth" },
    icon: "/brand/sattvic-icon-512.png",
    appleIcon: "/brand/sattvic-apple-touch.png",
    favicon: "/brand/sattvic-favicon-32.png",
    themeColor: "#f7931e",
    card: {
      background: "#1a0f05",
      glow: "#f7931e",
      accent: "#ffb45c",
      text: "#fff7ee",
      muted: "#e9cfb4",
      tagline: "Live IBKR risk desk",
    },
  },
  ekalon: {
    key: "ekalon",
    host: "rms.ekalonsolutions.com",
    name: "Ekalon RMS",
    title: "Ekalon RMS · Risk Management for IBKR",
    description:
      "Ekalon's multi-client risk management system for Interactive Brokers: live positions, scenario P&L, worst-case risk and Telegram alerts.",
    eyebrow: "EKALON / RMS",
    footer: "EKALON SOLUTIONS · RMS",
    logo: { src: "/brand/ekalon-wordmark.png", width: 679, height: 202, alt: "Ekalon Solutions" },
    icon: "/brand/ekalon-icon-512.png",
    appleIcon: "/brand/ekalon-apple-touch.png",
    favicon: "/brand/ekalon-favicon-32.png",
    themeColor: "#0c1a1a",
    card: {
      background: "#0b1717",
      glow: "#12302f",
      accent: "#2ee6d6",
      text: "#f2f7f7",
      muted: "#9fb5b3",
      tagline: "Risk management for Interactive Brokers",
    },
  },
};

/** Map a Host header to its brand. Anything that is not a Sattvic host gets the Ekalon brand. */
export function siteFor(host: string | null | undefined): Site {
  const name = (host ?? "").split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
  if (name.startsWith("sattvic-rms.") || name.startsWith("saatvik-rms.")) return SITES.sattvic;
  if (name === SITES.sattvic.host) return SITES.sattvic;
  return { ...SITES.ekalon, host: name.endsWith("ekalonsolutions.com") ? name : SITES.ekalon.host };
}

/** Public, unauthenticated paths that link previews, browsers and crawlers fetch. */
export const PUBLIC_ASSET_PATHS = ["/robots.txt", "/sitemap.xml", "/manifest.webmanifest", "/social-card"];
