import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { currentSite } from "@/lib/site-server";

const icons = new Map<string, Promise<string>>();

/** The brand's square icon as a data URL, read once per process from the shipped public/ folder. */
function iconData(path: string): Promise<string> {
  if (!icons.has(path)) {
    icons.set(
      path,
      readFile(join(process.cwd(), "public", path)).then(bytes => `data:image/png;base64,${bytes.toString("base64")}`),
    );
  }
  return icons.get(path)!;
}

/** 1200×630 link-preview card, branded for whichever host asked for it. */
export async function GET() {
  const site = await currentSite();
  const { card } = site;
  const icon = await iconData(site.icon);
  const image = new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 80px",
          background: card.background,
          position: "relative",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: -160,
            top: -260,
            width: 860,
            height: 780,
            borderRadius: 9999,
            background: card.glow,
            opacity: site.key === "sattvic" ? 0.22 : 0.9,
          }}
        />
        {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders plain img, not next/image */}
        <img src={icon} width={150} height={150} style={{ borderRadius: 16, marginBottom: 44 }} alt="" />
        <div style={{ display: "flex", fontSize: 68, fontWeight: 700, color: card.text, letterSpacing: -1 }}>
          {site.name}
        </div>
        <div style={{ display: "flex", fontSize: 32, color: card.muted, marginTop: 14 }}>{card.tagline}</div>
        <div style={{ display: "flex", gap: 16, marginTop: 34 }}>
          {["Live positions", "Scenario P&L", "Worst-case risk", "Alerts"].map(item => (
            <div
              key={item}
              style={{
                display: "flex",
                fontSize: 22,
                color: card.text,
                padding: "8px 18px",
                borderRadius: 9999,
                border: `2px solid ${card.accent}`,
              }}
            >
              {item}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", position: "absolute", left: 80, bottom: 48, fontSize: 26, color: card.accent }}>
          {site.host}
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
  image.headers.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  image.headers.set("Vary", "Host");
  return image;
}
