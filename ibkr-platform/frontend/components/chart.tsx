"use client";

import { useEffect, useRef, useState } from "react";
import type { EChartsType } from "echarts/core";

/** The data-zoom window on screen right now, so a redraw can restate it. */
export type Zoom = { start: number; end: number };

/** The theme tokens a chart draws with, read off the live stylesheet. */
export type Tokens = Record<
  "muted" | "grid" | "line" | "lineStrong" | "accent" | "raised" | "green" | "red",
  string
>;

const NAMES: Record<keyof Tokens, string> = {
  muted: "--muted",
  grid: "--grid",
  line: "--line",
  lineStrong: "--line-strong",
  accent: "--accent",
  raised: "--panel-raised",
  green: "--green",
  red: "--red",
};

/** An echarts canvas that keeps the user's zoom across data refreshes.
 *
 *  The instance is created once and every later change merges into it. Building
 *  a new chart per render — the obvious thing — throws away the data-zoom window
 *  the reader had just set, and with a feed that refetches every fifteen seconds
 *  that means the view snaps back to full range while they are looking at it.
 *  The current window is read back off the option and restated, so a merge can
 *  never quietly reset it.
 */
export function Chart({
  option,
  deps,
  height = 400,
  ariaLabel,
  unavailable = "Chart unavailable.",
}: {
  option: (tokens: Tokens, zoom: Zoom) => Record<string, unknown>;
  /** Values that should redraw the chart; the option builder closes over them. */
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
      Object.entries(NAMES).map(([key, name]) => [key, styles.getPropertyValue(name).trim()]),
    ) as Tokens;
    const bars = instance.getOption()?.dataZoom as { start?: number; end?: number }[] | undefined;
    const zoom = { start: bars?.[0]?.start ?? 0, end: bars?.[0]?.end ?? 100 };
    // A complete option replacement prevents ECharts from retaining stale
    // series data when only the live reference price changed. `zoom` is read
    // above and included in the replacement, so the reader's window survives.
    instance.setOption(option(tokens, zoom), { notMerge: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, ...deps]);

  return failed ? (
    <p role="alert">{unavailable}</p>
  ) : (
    <div ref={ref} style={{ height }} role="img" aria-label={ariaLabel} />
  );
}
