"use client";

import { Chart } from "./chart";
import { money } from "./tables";

export type ShockPoint = { shock: number; terminal: number; modeled: number };

export function ShockCurve({ points, currency, light, betaSymbol, height = 260 }: {
  points: ShockPoint[];
  currency: string;
  light: boolean;
  betaSymbol?: string;
  height?: number;
}) {
  if (points.length < 2) return null;
  const axis = betaSymbol ? `${betaSymbol} move` : "Move in every underlying";
  const version = `${points.length}:${points[0].terminal}:${points.at(-1)?.terminal}:${points.find(p => p.shock === 0)?.modeled}`;
  return (
    <Chart
      height={height}
      ariaLabel={`P&L in ${currency} against a percentage move${betaSymbol ? ` in ${betaSymbol}` : ""}`}
      unavailable="Chart unavailable. The row above carries the same numbers."
      deps={[version, currency, light]}
      option={(t) => ({
        animation: false,
        legend: { top: 4, left: "center", itemGap: 16, itemWidth: 16, itemHeight: 9, textStyle: { color: t.muted }, inactiveColor: t.line },
        tooltip: {
          trigger: "axis", confine: true,
          backgroundColor: t.raised, borderColor: t.lineStrong, borderWidth: 1,
          textStyle: { color: t.text, fontSize: 12 },
          valueFormatter: (value: number) => money(String(value)),
          axisPointer: { label: { formatter: ({ value }: { value: number }) => `${value > 0 ? "+" : ""}${Number(value).toFixed(1)}%` } },
        },
        grid: { left: 64, right: 24, top: 40, bottom: 40, containLabel: false },
        xAxis: {
          type: "value", name: axis, nameLocation: "middle", nameGap: 26, nameTextStyle: { color: t.muted },
          min: points[0].shock, max: points[points.length - 1].shock,
          axisLine: { lineStyle: { color: t.line } }, axisTick: { show: false },
          axisLabel: { color: t.muted, formatter: (v: number) => `${v > 0 ? "+" : ""}${v}%` },
          splitLine: { lineStyle: { color: t.grid } },
        },
        yAxis: {
          type: "value", name: `P&L (${currency})`, nameLocation: "middle", nameRotate: 90, nameGap: 52,
          axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.muted },
          nameTextStyle: { color: t.muted }, splitLine: { lineStyle: { color: t.grid } },
        },
        visualMap: {
          show: false, type: "piecewise", dimension: 1, seriesIndex: [0, 1],
          pieces: [{ gt: -1e15, lte: 0, color: t.red }, { gt: 0, lte: 1e15, color: t.green }],
        },
        series: [
          {
            name: "At expiry", type: "line", showSymbol: false, z: 3,
            data: points.map(p => [p.shock, p.terminal]), lineStyle: { width: 2.5 },
            markLine: {
              silent: true, symbol: "none", lineStyle: { color: t.lineStrong, type: "dashed" }, label: { show: false },
              data: [{ yAxis: 0 }, { xAxis: 0, lineStyle: { color: t.accent, type: "solid" } }],
            },
          },
          {
            name: "Pre-expiry estimate", type: "line", showSymbol: false, z: 2,
            data: points.map(p => [p.shock, p.modeled]), lineStyle: { type: "dashed", width: 1.8 },
          },
        ],
      })}
    />
  );
}
