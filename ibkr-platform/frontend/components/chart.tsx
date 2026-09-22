"use client";

import { useEffect, useRef, useState } from "react";
import type { EChartsType } from "echarts/core";

export type Zoom = { start: number; end: number };

export type Selected = Record<string, boolean>;

export type Tokens = Record<
  "text" | "muted" | "grid" | "line" | "lineStrong" | "accent" | "raised" | "green" | "red",
  string
>;

const NAMES: Record<keyof Tokens, string> = {
  text: "--text",
  muted: "--muted",
  grid: "--grid",
  line: "--line",
  lineStrong: "--line-strong",
  accent: "--accent",
  raised: "--panel-raised",
  green: "--green",
  red: "--red",
};

// jsdom (and a first paint before tokens land) returns "" for custom
// properties. visualMap lerps those stops and crashes on an empty color.
const FALLBACKS: Tokens = {
  text: "#e8e4dc",
  muted: "#9a958c",
  grid: "#2a2824",
  line: "#3a3834",
  lineStrong: "#55524c",
  accent: "#c4a35a",
  raised: "#1c1b18",
  green: "#5ccba4",
  red: "#f08b8f",
};

export function Chart({
  option,
  deps,
  height = 400,
  ariaLabel,
  unavailable = "Chart unavailable.",
}: {
  option: (tokens: Tokens, zoom: Zoom, selected?: Selected) => Record<string, unknown>;
  deps: unknown[];
  height?: number;
  ariaLabel: string;
  unavailable?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const [failed, setFailed] = useState(false);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void Promise.all([
      import("echarts/core"),
      import("echarts/charts"),
      import("echarts/components"),
      import("echarts/renderers"),
    ])
      .then(([ec, charts, components, renderers]) => {
        if (cancelled || !ref.current) return;
        ec.use([
          charts.LineChart,
          components.GridComponent,
          components.TooltipComponent,
          components.LegendComponent,
          components.MarkLineComponent,
          components.AxisPointerComponent,
          components.VisualMapComponent,
          components.DataZoomInsideComponent,
          components.DataZoomSliderComponent,
          renderers.SVGRenderer,
        ]);
        const instance = ec.init(ref.current, undefined, { renderer: "svg" });
        const observer = new ResizeObserver(() => instance.resize());
        observer.observe(ref.current);
        chart.current = instance;
        dispose = () => {
          observer.disconnect();
          instance.dispose();
          chart.current = null;
        };
        setStarted(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      setStarted(false);
      dispose?.();
    };
  }, []);

  useEffect(() => {
    const instance = chart.current;
    if (!instance || !ref.current) return;
    const styles = getComputedStyle(ref.current);
    const tokens = Object.fromEntries(
      Object.entries(NAMES).map(([key, name]) => {
        const value = styles.getPropertyValue(name).trim();
        return [key, value || FALLBACKS[key as keyof Tokens]];
      }),
    ) as Tokens;
    const current = instance.getOption() as
      | { dataZoom?: { start?: number; end?: number }[]; legend?: { selected?: Selected }[] }
      | undefined;
    const bars = current?.dataZoom;
    const zoom = { start: bars?.[0]?.start ?? 0, end: bars?.[0]?.end ?? 100 };
    const selected = current?.legend?.[0]?.selected;
    instance.setOption(option(tokens, zoom, selected), { notMerge: true });
  }, [started, ...deps]);

  return failed ? (
    <p role="alert">{unavailable}</p>
  ) : (
    <div ref={ref} style={{ height }} role="img" aria-label={ariaLabel} />
  );
}
