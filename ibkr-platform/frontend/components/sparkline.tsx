"use client";

import { useId } from "react";

/**
 * A 120×24 payoff shape: terminal P&L across the plotted range, zero as a
 * baseline, gains and losses drawn in their own colours. Reads as a condor,
 * a collar or a naked short before any number does.
 */
export function Sparkline({ values, width = 120, height = 24, label }: { values: number[]; width?: number; height?: number; label: string }) {
  const id = useId();
  if (values.length < 2) return <span className="spark empty" aria-hidden="true" />;
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const pad = 1.5;
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => pad + (1 - (v - lo) / span) * (height - pad * 2);
  const zero = y(0);
  const path = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true" data-label={label}>
      <defs>
        <clipPath id={`${id}-up`}><rect x={0} y={0} width={width} height={zero} /></clipPath>
        <clipPath id={`${id}-down`}><rect x={0} y={zero} width={width} height={height - zero} /></clipPath>
      </defs>
      <line className="spark-zero" x1={0} x2={width} y1={zero} y2={zero} />
      <path className="spark-up" d={path} clipPath={`url(#${id}-up)`} />
      <path className="spark-down" d={path} clipPath={`url(#${id}-down)`} />
    </svg>
  );
}
