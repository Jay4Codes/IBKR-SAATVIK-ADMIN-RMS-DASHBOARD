"use client";

import { memo, ReactNode, useEffect, useRef, useState } from "react";
import {
  Assumption,
  buildPriceCurve,
  expiryDate,
  PricePoint,
  previousClose,
  priceCdf,
  priceDensity,
  RiskLeg,
  strategyStats,
  underlyingKey,
} from "@/lib/payoff";
import { Chart, Tokens } from "./chart";
import { Amount, money } from "./tables";

type Marker = { strike: number; right: string; quantity: number; expiry: string };

function markers(legs: RiskLeg[]): Marker[] {
  const merged = new Map<string, Marker>();
  for (const leg of legs) {
    if (leg.position.sec_type !== "OPT" || !(leg.strike > 0)) continue;
    const id = `${leg.strike}:${leg.position.right}:${leg.position.expiry}`;
    const found = merged.get(id);
    if (found) found.quantity += leg.quantity;
    else merged.set(id, { strike: leg.strike, right: leg.position.right, quantity: leg.quantity, expiry: leg.position.expiry });
  }
  return [...merged.values()].filter(m => m.quantity !== 0).sort((a, b) => a.strike - b.strike);
}

export function scaleTicks(lo: number, hi: number, target = 9): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [];
  const rough = span / target;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(s => s >= rough) ?? 10 * magnitude;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    out.push(Number(v.toPrecision(12)));
  }
  return out;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export const PLOT_LEFT = 64;
export const PLOT_RIGHT = 24;

const pinWidth = (pin: Marker) =>
  `${pin.strike}`.length * 7.5 + 16 + (Math.abs(pin.quantity) !== 1 ? 22 : 0);

export function assignRows(pins: Marker[], lo: number, hi: number, width: number) {
  const span = hi - lo;
  const rowEnds: number[] = [];
  return pins.map(pin => {
    const centre = span > 0 ? ((pin.strike - lo) / span) * width : 0;
    const half = pinWidth(pin) / 2;
    let row = rowEnds.findIndex(end => centre - half >= end);
    if (row === -1) row = rowEnds.length;
    rowEnds[row] = centre + half + 6;
    return { pin, row };
  });
}

function StrikeRuler({ legs, lo, hi, spot, symbol }: { legs: RiskLeg[]; lo: number; hi: number; spot: number; symbol: string }) {
  const place = (price: number) => ((price - lo) / (hi - lo)) * 100;
  const [ref, width] = useWidth<HTMLDivElement>();
  const pins = markers(legs).filter(m => m.strike >= lo && m.strike <= hi);
  const placed = assignRows(pins, lo, hi, width || 1200);
  const rows = placed.reduce((most, p) => Math.max(most, p.row + 1), 1);
  return (
    <div className="strike-ruler" role="group" aria-label="Held strikes against the underlying price">
      <div className="ruler-track" ref={ref} style={{ height: `${rows * 26 + 14}px` }}>
        {placed.map(({ pin, row }) => (
          <span
            key={`${pin.strike}:${pin.right}`}
            className={`strike-pin ${pin.right === "C" ? "call" : "put"} ${pin.quantity < 0 ? "short" : "long"}`}
            style={{
              left: `${place(pin.strike)}%`,
              top: `${row * 26}px`,
              ["--drop" as string]: `${(rows - row) * 26 - 6}px`,
            }}
            title={`${pin.quantity > 0 ? "Long" : "Short"} ${Math.abs(pin.quantity)} × ${pin.strike} ${pin.right === "C" ? "call" : "put"}, expiring ${expiryDate(pin.expiry) || pin.expiry}`}
          >
            {pin.strike}{pin.right}
            {Math.abs(pin.quantity) !== 1 && <b>×{Math.abs(pin.quantity)}</b>}
          </span>
        ))}
        {spot >= lo && spot <= hi && (
          <span className="spot-pin" style={{ left: `${place(spot)}%` }}>
            <small>{symbol}</small>
          </span>
        )}
      </div>
      <div className="ruler-scale" aria-hidden="true">
        {scaleTicks(lo, hi).map(value => (
          <span key={value} style={{ left: `${place(value)}%` }}>{money(String(value), 0)}</span>
        ))}
      </div>
    </div>
  );
}

function valueLabel(t: Tokens, position: "top" | "bottom") {
  return {
    show: true, position, distance: 8,
    backgroundColor: t.raised, borderColor: t.lineStrong, borderWidth: 1,
    padding: [3, 7], borderRadius: 4, color: t.text, fontSize: 12, fontWeight: 600,
    formatter: ({ value }: { value: [number, number] }) => money(String(value[1])),
  };
}

function PayoffGraph({
  points, density, currency, breakevens, spot, light, version, probabilityBelow,
}: {
  points: PricePoint[];
  density: [number, number][];
  currency: string;
  breakevens: number[];
  spot: number;
  light: boolean;
  version: string;
  probabilityBelow: (price: number) => number | null;
}) {
  return (
    <Chart
      height={420}
      ariaLabel={`Payoff in ${currency} against the underlying price, with the probability of each level at expiry`}
      unavailable="Chart unavailable. The scenario table above carries the same numbers."
      deps={[version, currency, light]}
      option={(t, zoom, selected) => ({
        animation: false,
        legend: { type: "scroll", top: 46, left: "center", itemGap: 16, itemWidth: 16, itemHeight: 9, textStyle: { color: t.muted }, inactiveColor: t.line, pageIconColor: t.accent, pageIconInactiveColor: t.muted, pageTextStyle: { color: t.muted }, ...(selected ? { selected } : {}) },
        tooltip: {
          trigger: "axis", confine: true, renderMode: "richText",
          backgroundColor: t.raised, borderColor: t.lineStrong, borderWidth: 1,
          textStyle: { color: t.text, fontSize: 13 },
          position: (point: number[], _p: unknown, _d: unknown, _r: unknown, size: { contentSize: number[]; viewSize: number[] }) => {
            const [width] = size.contentSize;
            const x = Math.min(Math.max(point[0] - width / 2, 4), size.viewSize[0] - width - 4);
            return [x, 6];
          },
          formatter: (series: { axisValue: number }[]) => {
            const price = series[0]?.axisValue ?? 0;
            const move = spot > 0 ? ((price / spot - 1) * 100) : 0;
            return `${money(String(price))}  (${move > 0 ? "+" : ""}${move.toFixed(2)}%)`;
          },
        },
        axisPointer: {
          label: {
            show: true, margin: 8, backgroundColor: t.raised, borderColor: t.lineStrong,
            borderWidth: 1, color: t.muted, fontSize: 12, padding: [4, 8],
            formatter: ({ value }: { value: number }) => {
              const below = probabilityBelow(Number(value));
              if (below === null) return money(String(value));
              const pct = (n: number) => `${(n * 100).toFixed(n > 0.1 ? 0 : 1)}%`;
              return `◄ ${pct(below)}     ${pct(1 - below)} ►`;
            },
          },
        },
        grid: { left: PLOT_LEFT, right: PLOT_RIGHT, top: 78, bottom: 92, containLabel: false },
        dataZoom: [
          { type: "inside", xAxisIndex: 0, filterMode: "none", ...zoom },
          {
            type: "slider", xAxisIndex: 0, filterMode: "none", ...zoom, bottom: 12, height: 28, brushSelect: false,
            backgroundColor: "transparent", borderColor: t.line, fillerColor: `${t.accent}26`,
            dataBackground: { lineStyle: { color: t.muted, width: 1, opacity: 0.7 }, areaStyle: { color: t.muted, opacity: 0.18 } },
            selectedDataBackground: { lineStyle: { color: t.accent, width: 1 }, areaStyle: { color: t.accent, opacity: 0.28 } },
            handleSize: "110%", handleStyle: { color: t.raised, borderColor: t.lineStrong, borderWidth: 1, shadowBlur: 0 },
            moveHandleSize: 6, moveHandleStyle: { color: t.lineStrong },
            textStyle: { color: t.muted }, labelFormatter: (v: number) => money(String(v), 0),
          },
        ],
        xAxis: {
          type: "value", min: points[0].price, max: points[points.length - 1].price,
          axisPointer: {
            show: true, type: "line", snap: false,
            lineStyle: { color: t.muted, width: 1, type: "solid" },
            label: {
              show: true, margin: 8, backgroundColor: t.raised, borderColor: t.lineStrong,
              borderWidth: 1, color: t.muted, fontSize: 12, padding: [4, 8],
              formatter: ({ value }: { value: number }) => {
                const below = probabilityBelow(Number(value));
                if (below === null) return money(String(value));
                const pct = (n: number) => `${(n * 100).toFixed(n > 0.1 ? 0 : 1)}%`;
                return `◄ ${pct(below)}     ${pct(1 - below)} ►`;
              },
            },
          },
          axisLine: { lineStyle: { color: t.line } }, axisTick: { show: false },
          axisLabel: { color: t.muted, formatter: (v: number) => money(String(v), 0) },
          splitLine: { lineStyle: { color: t.grid } },
        },
        yAxis: [
          {
            type: "value", name: `P&L (${currency})`, nameLocation: "middle", nameRotate: 90, nameGap: 52,
            axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.muted },
            nameTextStyle: { color: t.muted }, splitLine: { lineStyle: { color: t.grid } },
          },
          { type: "value", show: false, min: 0, max: Math.max(...density.map(d => d[1]), 1e-9) * 3.2 },
        ],
        visualMap: {
          show: false, type: "piecewise", dimension: 1, seriesIndex: [1, 2],
          pieces: [
            { gt: -1e15, lte: 0, color: t.red },
            { gt: 0, lte: 1e15, color: t.green },
          ],
        },
        series: [
          {
            name: "Probability", type: "line", yAxisIndex: 1, showSymbol: false, silent: true, z: 1,
            data: density, lineStyle: { width: 0 },
            areaStyle: { color: t.accent, opacity: light ? 0.1 : 0.16 },
          },
          {
            name: "At expiry", type: "line", showSymbol: false, z: 3,
            data: points.map(p => [p.price, p.terminal]), lineStyle: { width: 2.5 },
            emphasis: { scale: 1.6, label: valueLabel(t, "top") },
            markLine: {
              silent: true, symbol: "none",
              label: {
                show: true, position: "insideStartTop", distance: 4, color: t.muted, fontSize: 11,
                backgroundColor: t.raised, borderColor: t.line, borderWidth: 1,
                padding: [2, 5], borderRadius: 3,
                formatter: ({ value }: { value: number }) => money(String(value), 0),
              },
              lineStyle: { color: t.lineStrong, type: "dashed" },
              data: [
                { yAxis: 0, label: { show: false } },
                ...breakevens.map(price => ({ xAxis: price })),
                { xAxis: spot, lineStyle: { color: t.accent, type: "solid" }, label: { show: false } },
              ],
            },
          },
          {
            name: "Pre-expiry estimate", type: "line", showSymbol: false, z: 2,
            data: points.map(p => [p.price, p.modeled]), lineStyle: { type: "dashed", width: 1.8 },
            emphasis: { scale: 1.6, label: valueLabel(t, "bottom") },
          },
        ],
      })}
    />
  );
}

export const StrategyPayoff = memo(function StrategyPayoff({
  legs, assumptions, keys, currency, rate, offset, light, range, horizon, toolbar,
}: {
  legs: RiskLeg[];
  assumptions: Record<string, Assumption>;
  keys: string[];
  currency: string;
  rate: number;
  offset: number;
  light: boolean;
  range: number;
  horizon: number;
  /** Controls that belong on the header line, beside the underlying's price. */
  toolbar?: ReactNode;
}) {
  const key = keys[0];
  const assumption = assumptions[key];
  const spot = assumption?.spot;
  if (!key || !(spot > 0)) return null;

  const scoped = legs.filter(leg => underlyingKey(leg.position) === key);
  const points = buildPriceCurve(scoped, assumptions, key, range, horizon, rate / 100);
  const wide = buildPriceCurve(scoped, assumptions, key, 95, horizon, rate / 100);
  if (!points.length) return null;

  const years = Math.max(0, Math.min(...scoped.filter(l => l.position.sec_type === "OPT").map(l => l.days)) - horizon) / 365;
  const stats = strategyStats(points, wide, scoped, spot, assumption.volatility, years, rate / 100, assumption.dividend, offset);
  const shown = points.map(p => ({ ...p, terminal: p.terminal + offset, modeled: p.modeled + offset }));
  const density: [number, number][] = points.map(p => [
    p.price,
    priceDensity(p.price, spot, assumption.volatility, years, rate / 100, assumption.dividend),
  ]);
  const at = shown.find(p => p.price >= spot) ?? shown[0];
  const probabilityBelow = (price: number) =>
    years > 0 && assumption.volatility > 0
      ? priceCdf(price, spot, assumption.volatility, years, rate / 100, assumption.dividend)
      : null;
  const symbol = key.split(":").at(-1) ?? "";
  const prior = previousClose(scoped, key);
  const change = prior && prior > 0
    ? { absolute: spot - prior, percent: (spot / prior - 1) * 100, from: prior }
    : undefined;
  const version = `${shown.length}:${offset}:${assumption.volatility}:${spot}:${horizon}:${range}`;

  return (
    <div className="strategy" style={{ ["--plot-left" as string]: `${PLOT_LEFT}px`, ["--plot-right" as string]: `${PLOT_RIGHT}px` }}>
      {/* The expiry control belongs on this line — it names which book the price
          describes — but after the price, not before it: the number is what the
          eye comes here for. */}
      <div className="strategy-head">
        <span className="ticker">{symbol}</span>
        <b>{money(String(spot))}</b>
        {change !== undefined && (
          <span className={`change ${change.absolute < 0 ? "negative" : change.absolute > 0 ? "positive" : ""}`}>
            {change.absolute > 0 ? "+" : ""}{money(String(change.absolute))}
            {" "}({change.absolute > 0 ? "+" : ""}{change.percent.toFixed(2)}%)
            <small>since {money(String(change.from))}</small>
          </span>
        )}
        {toolbar}
      </div>

      <StrikeRuler legs={scoped} lo={points[0].price} hi={points[points.length - 1].price} spot={spot} symbol={symbol} />

      <div className="strategy-stats">
        <div>
          <label>{stats.netCredit >= 0 ? "Net credit" : "Net debit"}</label>
          <strong>{money(String(Math.abs(stats.netCredit)))}</strong>
        </div>
        <div>
          <label>Max loss</label>
          <strong>{stats.uncappedDownside ? "Uncapped" : <Amount value={String(stats.maxLoss)} />}</strong>
        </div>
        <div>
          <label>Max profit</label>
          <strong>{stats.uncappedUpside ? "Uncapped" : <Amount value={String(stats.maxProfit)} />}</strong>
        </div>
        <div>
          <label>Chance of profit</label>
          <strong>{stats.chanceOfProfit === null ? "—" : `${(stats.chanceOfProfit * 100).toFixed(0)}%`}</strong>
        </div>
        <div className="wide">
          <label>Breakevens</label>
          <strong>{stats.breakevens.length ? stats.breakevens.map(b => money(String(b))).join(" – ") : "None in range"}</strong>
        </div>
        <div>
          <label>P&amp;L at {money(String(spot))}</label>
          <strong><Amount value={String(at?.modeled)} /></strong>
        </div>
      </div>

      <PayoffGraph
        points={shown}
        density={density}
        currency={currency}
        breakevens={stats.breakevens}
        spot={spot}
        light={light}
        version={version}
        probabilityBelow={probabilityBelow}
      />
    </div>
  );
});
