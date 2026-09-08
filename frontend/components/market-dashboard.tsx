"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Activity, ArrowDownRight, ArrowUpRight, Database, RefreshCw } from "lucide-react";

import { CandlestickChart } from "@/components/candlestick-chart";
import { VolumeChart } from "@/components/volume-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CandleSeries } from "@/lib/types";

export function MarketDashboard() {
  const [query, setQuery] = useState("AAPL");
  const [symbol, setSymbol] = useState("AAPL");
  const [data, setData] = useState<CandleSeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/v1/market/candles?symbol=${encodeURIComponent(symbol)}&limit=90`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        setData((await response.json()) as CandleSeries);
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError("Could not reach the market API. Start the FastAPI service and retry.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [symbol]);

  const metrics = useMemo(() => {
    const candles = data?.candles ?? [];
    const latest = candles.at(-1);
    const previous = candles.at(-2);
    const change = latest && previous ? latest.close - previous.close : 0;
    const percent = previous ? (change / previous.close) * 100 : 0;
    const totalVolume = candles.reduce((sum, candle) => sum + candle.volume, 0);
    return { latest, change, percent, averageVolume: candles.length ? totalVolume / candles.length : 0 };
  }, [data]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const nextSymbol = query.trim().toUpperCase();
    if (nextSymbol) setSymbol(nextSymbol);
  }

  const positive = metrics.change >= 0;

  return (
    <main className="mx-auto min-h-screen w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-emerald-300">
            <Activity className="size-5" />
            <span className="text-xs font-semibold uppercase tracking-[0.25em]">Sattvic Terminal</span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Market intelligence, distilled.</h1>
        </div>
        <form onSubmit={submit} className="flex w-full gap-2 sm:w-auto">
          <input
            aria-label="Ticker symbol"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-neutral-900 px-3 text-sm uppercase text-white outline-none placeholder:text-neutral-600 focus:border-emerald-400/50 sm:w-36"
            maxLength={12}
            placeholder="Ticker"
          />
          <Button type="submit" disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            Load
          </Button>
        </form>
      </header>

      {error ? (
        <Card className="border-rose-400/20 bg-rose-400/5 p-6 text-rose-200">{error}</Card>
      ) : (
        <div className="grid gap-4">
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="Last price" value={metrics.latest ? `$${metrics.latest.close.toFixed(2)}` : "—"} />
            <MetricCard
              label="Day change"
              value={`${positive ? "+" : ""}${metrics.change.toFixed(2)} (${metrics.percent.toFixed(2)}%)`}
              positive={positive}
            />
            <MetricCard label="Average volume" value={formatCompact(metrics.averageVolume)} />
            <Card>
              <CardContent className="flex h-full items-center justify-between pt-5">
                <div>
                  <p className="text-xs uppercase tracking-wider text-neutral-500">Data source</p>
                  <div className="mt-2 flex items-center gap-2">
                    <Database className="size-4 text-emerald-300" />
                    <span className="font-medium capitalize text-neutral-100">{data?.source ?? "Loading"}</span>
                  </div>
                </div>
                <Badge>{data?.source === "mongodb" ? "Live store" : "Demo"}</Badge>
              </CardContent>
            </Card>
          </section>

          <Card className="overflow-hidden">
            <CardHeader className="flex-row items-center justify-between border-b border-white/5">
              <div>
                <CardTitle className="text-xl text-white">{data?.symbol ?? symbol} price action</CardTitle>
                <p className="mt-1 text-sm text-neutral-500">Daily OHLC · Lightweight Charts</p>
              </div>
              <Badge className="border-white/10 bg-white/5 text-neutral-300">90D</Badge>
            </CardHeader>
            <CardContent className="p-2 sm:p-4">
              {data ? <CandlestickChart candles={data.candles} /> : <ChartSkeleton height="h-[390px]" />}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base text-white">Volume profile</CardTitle>
              <p className="text-sm text-neutral-500">Apache ECharts</p>
            </CardHeader>
            <CardContent>
              {data ? <VolumeChart candles={data.candles} /> : <ChartSkeleton height="h-40" />}
            </CardContent>
          </Card>
        </div>
      )}
    </main>
  );
}

function MetricCard({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  const TrendIcon = positive === undefined ? null : positive ? ArrowUpRight : ArrowDownRight;
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-xs uppercase tracking-wider text-neutral-500">{label}</p>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-2xl font-semibold tabular-nums text-white">{value}</span>
          {TrendIcon ? <TrendIcon className={`size-5 ${positive ? "text-emerald-300" : "text-rose-400"}`} /> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function ChartSkeleton({ height }: { height: string }) {
  return <div className={`${height} w-full animate-pulse rounded-xl bg-white/5`} />;
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

