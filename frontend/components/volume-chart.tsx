"use client";

import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

import type { Candle } from "@/lib/types";

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

export function VolumeChart({ candles }: { candles: Candle[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || candles.length === 0) return;

    const chart = echarts.init(container, undefined, { renderer: "canvas" });
    chart.setOption({
      animationDuration: 450,
      grid: { left: 8, right: 8, top: 12, bottom: 4, containLabel: true },
      tooltip: {
        trigger: "axis",
        backgroundColor: "#171717",
        borderColor: "rgba(255,255,255,.1)",
        textStyle: { color: "#fafafa" },
      },
      xAxis: {
        type: "category",
        data: candles.map((candle) =>
          new Date(candle.timestamp * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        ),
        axisLine: { lineStyle: { color: "rgba(255,255,255,.08)" } },
        axisLabel: { show: false },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: "#737373", formatter: (value: number) => `${(value / 1_000_000).toFixed(1)}m` },
        splitLine: { lineStyle: { color: "rgba(255,255,255,.04)" } },
      },
      series: [
        {
          name: "Volume",
          type: "bar",
          barMaxWidth: 8,
          data: candles.map((candle) => ({
            value: candle.volume,
            itemStyle: { color: candle.close >= candle.open ? "rgba(52,211,153,.55)" : "rgba(251,113,133,.5)" },
          })),
        },
      ],
    });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [candles]);

  return <div ref={containerRef} className="h-40 w-full" aria-label="Trading volume chart" />;
}

