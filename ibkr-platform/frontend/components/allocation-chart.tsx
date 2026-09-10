"use client";
import { useEffect, useRef, useState } from "react";
import { Account } from "@/lib/types";
import { money } from "./tables";

export function AllocationChart({
  accounts,
  light,
}: {
  accounts: Account[];
  light: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void Promise.all([
      import("echarts/core"),
      import("echarts/charts"),
      import("echarts/components"),
      import("echarts/renderers"),
    ])
      .then(([echarts, charts, components, renderers]) => {
        if (cancelled || !ref.current) return;
        echarts.use([
          charts.BarChart,
          components.GridComponent,
          components.TooltipComponent,
          renderers.SVGRenderer,
        ]);
        const styles = getComputedStyle(ref.current);
        const muted = styles.getPropertyValue("--muted").trim();
        const accent = styles.getPropertyValue("--accent").trim();
        const grid = styles.getPropertyValue("--grid").trim();
        const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
        chart.setOption({
          animation: false,
          grid: {
            top: 8,
            bottom: 22,
            left: 4,
            right: narrow ? 8 : 20,
            containLabel: true,
          },
          tooltip: {
            trigger: "axis",
            axisPointer: { type: "shadow" },
            confine: true,
            textStyle: { fontSize: 11 },
          },
          xAxis: {
            type: "value",
            axisLabel: {
              color: muted,
              fontSize: narrow ? 8 : 9,
              hideOverlap: true,
            },
            splitLine: { lineStyle: { color: grid } },
          },
          yAxis: {
            type: "category",
            data: accounts.map((a) => a.account_id),
            axisLabel: { color: muted, fontSize: narrow ? 9 : 10 },
            axisTick: { show: false },
            axisLine: { show: false },
          },
          series: [
            {
              name: "Net liquidation",
              type: "bar",
              data: accounts.map((a) =>
                a.net_liquidation === null ? null : Number(a.net_liquidation),
              ),
              barMaxWidth: 12,
              itemStyle: { color: accent },
            },
          ],
        });
        const observer = new ResizeObserver(() => chart.resize());
        observer.observe(ref.current);
        dispose = () => {
          observer.disconnect();
          chart.dispose();
        };
      })
      .catch((error) => console.error("Allocation chart failed", error));
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [accounts, light, narrow]);
  return (
    <>
      <div
        className="chart"
        ref={ref}
        style={{
          height: Math.min(
            320,
            Math.max(110, accounts.length * (narrow ? 30 : 34) + 40),
          ),
        }}
        role="img"
        aria-label="Net liquidation by account"
      />
      <div className="allocation">
        {accounts.map((a) => (
          <div key={a.account_id}>
            <span>{a.account_id}</span>
            <b>{money(a.net_liquidation)}</b>
          </div>
        ))}
      </div>
    </>
  );
}
