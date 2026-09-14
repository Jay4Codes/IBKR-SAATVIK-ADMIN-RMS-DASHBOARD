import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PayoffPanel } from "@/components/payoff-panel";
import { Position } from "@/lib/types";

const charts: { option: Record<string, unknown>; setOption: ReturnType<typeof vi.fn>; disposed: boolean }[] = [];
vi.mock("echarts/core", () => ({
  use: vi.fn(),
  init: () => {
    const chart = {
      option: {} as Record<string, unknown>,
      disposed: false,
      setOption: vi.fn((option: Record<string, unknown>) => Object.assign(chart.option, option)),
      getOption: () => chart.option,
      dispose: () => { chart.disposed = true; },
      resize: vi.fn(),
    };
    charts.push(chart);
    return chart;
  },
}));
vi.mock("echarts/charts", () => ({ LineChart: {} }));
vi.mock("echarts/components", () => ({ GridComponent: {}, TooltipComponent: {}, LegendComponent: {}, MarkLineComponent: {}, DataZoomInsideComponent: {}, DataZoomSliderComponent: {}, AxisPointerComponent: {}, VisualMapComponent: {} }));
vi.mock("echarts/renderers", () => ({ SVGRenderer: {} }));
afterEach(() => { vi.unstubAllGlobals(); charts.length = 0; });

function futureExpiry(days: number): string {
  const date = new Date(Date.now() + days * 86400000);
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

function position(fields: Partial<Position> = {}): Position {
  return { account_id: "A", con_id: 1, symbol: "XYZ", local_symbol: "", sec_type: "OPT", currency: "USD", expiry: "20991231", strike: "100", right: "C", multiplier: "100", quantity: "1", average_cost: "500", market_price: "5", market_value: "500", unrealized_pnl: "0", ...fields };
}
type RealizedLeg = { realized_pnl: string; commission: string; currency: string; account_id: string };
function stubRealized(legs: RealizedLeg[] = []) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        total: "0", commission: "0", count: legs.length, by_account: [],
        legs: legs.map(leg => ({ symbol: "XYZ", underlying: "XYZ", expiry: "20991231", side: "SLD", quantity: "1", price: "1", executed_at: "2026-09-11T00:00:00Z", ...leg })),
      },
    }),
  })));
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

function panel(rows: Position[], props: Partial<React.ComponentProps<typeof PayoffPanel>> = {}, legs: RealizedLeg[] = []) {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  stubRealized(legs);
  const view = render(<PayoffPanel rows={rows} loading={false} error={false} light={false} {...props} />, { wrapper: wrapper() });
  const toggle = screen.queryByText("Model inputs");
  if (toggle) fireEvent.click(toggle);
  return view;
}

describe("payoff panel", () => {
  it("withholds curves while any account is loading or failed", () => {
    const { rerender } = panel([position()], { loading: true });
    expect(screen.getByRole("status")).toHaveTextContent("Loading all account positions");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    rerender(<PayoffPanel rows={[position()]} loading={false} error light={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent("every account");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
  it("requires an underlying reference price even when an option has a mark", async () => {
    panel([position()]);
    expect(screen.getByLabelText("XYZ reference price")).toHaveValue(null);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("XYZ reference price"), { target: { value: "100" } });
    expect(await screen.findByRole("img")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveAccessibleName("RMS by account ID · Scenario P&L (USD)");
    fireEvent.change(screen.getByLabelText("Volatility (%)"), { target: { value: "" } });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
  it("separates currencies and labels account scope", async () => {
    panel([position({ sec_type: "STK", average_cost: "80", market_price: "100" }), position({ sec_type: "STK", currency: "EUR", con_id: 2, average_cost: "90", market_price: "100" })], { accountId: "A" });
    expect(screen.getByRole("heading")).toHaveTextContent("Account payoff");
    expect(screen.getByRole("table")).toHaveAccessibleName("RMS by account ID · Scenario P&L (EUR)");
    fireEvent.click(screen.getByLabelText("Risk currency"));
    fireEvent.click(screen.getByRole("option", { name: "USD" }));
    expect(screen.getByRole("table")).toHaveAccessibleName("RMS by account ID · Scenario P&L (USD)");
    expect(screen.getByText(/1 included legs/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
  it("reports unsupported positions without treating them as zero risk", () => {
    panel([position({ sec_type: "FOP" })]);
    expect(screen.getByText(/Partial coverage: 1 excluded/)).toBeInTheDocument();
    expect(screen.getByText(/Unsupported FOP contract/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("recalculates on live stock marks and retains an explicit reference override", () => {
    const stock = position({ sec_type: "STK", average_cost: "80", market_price: "100", unrealized_pnl: "20" });
    const { rerender } = panel([stock], { accountId: "A" });
    expect(screen.getByLabelText("XYZ reference price")).toHaveAttribute("placeholder", "100.00");
    rerender(<PayoffPanel rows={[{ ...stock, market_price: "110", unrealized_pnl: "30" }]} accountId="A" loading={false} error={false} light={false} />);
    expect(screen.getByLabelText("XYZ reference price")).toHaveAttribute("placeholder", "110.00");
    expect(screen.getAllByText("31.10")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("XYZ reference price"), { target: { value: "120" } });
    rerender(<PayoffPanel rows={[{ ...stock, market_price: "115", unrealized_pnl: "35" }]} accountId="A" loading={false} error={false} light={false} />);
    expect(screen.getByLabelText("XYZ reference price")).toHaveValue(120);
    expect(screen.getAllByText("34.00").length).toBeGreaterThanOrEqual(2);
  });
  it("offers the broker's underlying mark as the placeholder and models it", () => {
    const { rerender } = panel([position({ underlying_price: "7612.5" })]);
    expect(screen.getByLabelText("XYZ reference price")).toHaveValue(null);
    expect(screen.getByLabelText("XYZ reference price")).toHaveAttribute("placeholder", "7,612.50");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Live broker mark")).toBeInTheDocument();
    expect(screen.getByText("USD:XYZ reference").parentElement).toHaveTextContent("7,612.50");
    rerender(<PayoffPanel rows={[position({ underlying_price: "7650" })]} loading={false} error={false} light={false} />);
    expect(screen.getByLabelText("XYZ reference price")).toHaveAttribute("placeholder", "7,650.00");
  });
  it("recalculates both the RMS table and graph when the live reference moves", async () => {
    const first = position({ underlying_price: "100" });
    const { rerender } = panel([first]);
    await waitFor(() => expect(charts).toHaveLength(1));
    const chart = charts[0];
    const beforeRow = screen.getByRole("row", { name: /Scenario underlying level/ }).textContent;
    const beforeSeries = JSON.stringify(chart.option.series);

    rerender(
      <PayoffPanel
        rows={[{ ...first, underlying_price: "110" }]}
        loading={false}
        error={false}
        light={false}
      />,
    );

    await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("XYZ reference price")).toHaveAttribute("placeholder", "110.00");
    expect(screen.getByText("USD:XYZ reference").parentElement).toHaveTextContent("110.00");
    const updatedRow = screen.getByRole("row", { name: /Scenario underlying level/ });
    expect(updatedRow).toHaveTextContent("XYZ 111.10");
    expect(updatedRow.textContent).not.toBe(beforeRow);
    expect(JSON.stringify(chart.option.series)).not.toBe(beforeSeries);
  });
  it("names a vendor previous-session close instead of calling it a live mark", () => {
    const { rerender } = panel([position({ underlying_price: "7612.5", underlying_source: "aggs_prev" })]);
    expect(screen.getByText(/previous session close, not a live mark/)).toBeInTheDocument();
    expect(screen.queryByText("Live broker mark")).not.toBeInTheDocument();
    rerender(<PayoffPanel rows={[position({ underlying_price: "7612.5", underlying_source: "indices_snapshot" })]} loading={false} error={false} light={false} />);
    expect(screen.getByText("Massive live snapshot")).toBeInTheDocument();
    rerender(<PayoffPanel rows={[position({ underlying_price: "7612.5" })]} loading={false} error={false} light={false} />);
    expect(screen.getByText("Live broker mark")).toBeInTheDocument();
  });
  it("labels a stored underlying LTP as cached rather than live", () => {
    panel([position({ underlying_price: "7583.88", underlying_source: "ib_und_price_cached" })]);
    expect(screen.getByLabelText("XYZ reference price")).toHaveAttribute("placeholder", "7,583.88");
    expect(screen.getByText("Stored last underlying price — not live")).toBeInTheDocument();
  });
  it("keeps a typed reference price and hands the field back when it is cleared", () => {
    const { rerender } = panel([position({ underlying_price: "7612.5" })]);
    fireEvent.change(screen.getByLabelText("XYZ reference price"), { target: { value: "7000" } });
    rerender(<PayoffPanel rows={[position({ underlying_price: "7650" })]} loading={false} error={false} light={false} />);
    expect(screen.getByLabelText("XYZ reference price")).toHaveValue(7000);
    expect(screen.getByText(/Modelling 7,000.00 · broker mark/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("XYZ reference price"), { target: { value: "" } });
    expect(screen.getByLabelText("XYZ reference price")).toHaveValue(null);
    expect(screen.getByText("USD:XYZ reference").parentElement).toHaveTextContent("7,650.00");
  });
  it("prefers a held stock mark over the option-implied underlying price", () => {
    panel([position({ sec_type: "STK", average_cost: "80", market_price: "100" }), position({ con_id: 2, underlying_price: "7612.5" })]);
    expect(screen.getByLabelText("XYZ reference price")).toHaveAttribute("placeholder", "100.00");
  });
  it("stays manual when the broker sends no underlying mark", () => {
    panel([position()]);
    expect(screen.getByLabelText("XYZ reference price")).toHaveValue(null);
    expect(screen.getByLabelText("XYZ reference price")).toHaveAttribute("placeholder", "Enter a price");
    expect(screen.getByText(/No broker mark — enter a price/)).toBeInTheDocument();
  });
  it("keeps the model inputs collapsed until they are asked for", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    stubRealized();
    render(<PayoffPanel rows={[position({ underlying_price: "7612.5" })]} loading={false} error={false} light={false} />, { wrapper: wrapper() });
    expect(screen.queryByRole("combobox", { name: "Risk currency" })).toBeNull();
    expect(document.getElementById("risk-inputs")).toHaveAttribute("hidden");
    fireEvent.click(screen.getByText("Model inputs"));
    expect(document.getElementById("risk-inputs")).not.toHaveAttribute("hidden");
    expect(screen.getByLabelText("Volatility (%)")).toBeVisible();
    expect(screen.getByRole("table")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Hide inputs"));
    expect(document.getElementById("risk-inputs")).toHaveAttribute("hidden");
  });
  it("shows an empty state for a flat desk", () => {
    panel([position({ quantity: "0" })]);
    expect(screen.getByText("No open positions to model.")).toBeInTheDocument();
  });
  it("keeps the zoomed window and the chart instance across a position refresh", async () => {
    const stock = position({ sec_type: "STK", average_cost: "80", market_price: "100" });
    const { rerender } = panel([stock], { accountId: "A" });
    await screen.findByRole("img");
    await waitFor(() => expect(charts).toHaveLength(1));
    const chart = charts[0];
    const zoom = () => (chart.option.dataZoom as { start: number; end: number }[])[1];
    expect(zoom()).toMatchObject({ start: 0, end: 100 });
    for (const bar of chart.option.dataZoom as { start: number; end: number }[]) Object.assign(bar, { start: 30, end: 70 });
    rerender(<PayoffPanel rows={[{ ...stock, market_price: "110" }]} accountId="A" loading={false} error={false} light={false} />);
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(2));
    expect(charts).toHaveLength(1);
    expect(chart.disposed).toBe(false);
    expect(zoom()).toMatchObject({ start: 30, end: 70 });
  });
  it("draws the zoom slider clear of the legend", async () => {
    panel([position({ sec_type: "STK", average_cost: "80", market_price: "100" })]);
    await screen.findByRole("img");
    await waitFor(() => expect(charts).toHaveLength(1));
    const option = charts[0].option as { legend: { top: number }; grid: { top: number; bottom: number }; dataZoom: { type: string; bottom?: number; height?: number }[] };
    const slider = option.dataZoom.find(bar => bar.type === "slider")!;
    expect(option.legend.top).toBeLessThan(option.grid.top);
    expect(slider.bottom! + slider.height!).toBeLessThan(option.grid.bottom);
  });
  it("shows the 1/3/5/10 percent RMS levels across the columns, by account ID", () => {
    panel([
      position({ account_id: "A", sec_type: "STK", average_cost: "80", market_price: "100" }),
      position({ account_id: "B", con_id: 2, sec_type: "STK", average_cost: "90", market_price: "100" }),
    ]);
    const table = screen.getByRole("table", { name: /RMS by account ID/ });
    expect(table).toHaveTextContent("A terminal");
    expect(table).toHaveTextContent("B terminal");
    for (const level of ["-10%", "-5%", "-3%", "-1%", "+1%", "+3%", "+5%", "+10%"])
      expect(screen.getByRole("columnheader", { name: level })).toBeInTheDocument();
    for (const gone of ["-4%", "-2%", "+2%", "+4%"])
      expect(screen.queryByRole("columnheader", { name: gone })).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(6);
  });

  it("adds booked P&L from closed legs back into the curve and shows it apart", async () => {
    panel(
      [position({ sec_type: "STK", average_cost: "80", market_price: "100" })],
      {},
      [{ realized_pnl: "-1265.36", commission: "1.73", currency: "USD", account_id: "A" }],
    );
    const table = await screen.findByRole("table", { name: /RMS by account ID/ });
    await waitFor(() => expect(table).toHaveTextContent("Booked P&L (closed legs)"));
    expect(table).toHaveTextContent("Open legs terminal");
    expect(screen.getAllByText("-1,265.36").length).toBeGreaterThanOrEqual(1);
    const open = Number(screen.getByRole("row", { name: /Open legs terminal/ }).querySelectorAll("td")[3].textContent!.replace(/,/g, ""));
    const total = Number(screen.getByRole("row", { name: /Desk total terminal/ }).querySelectorAll("td")[3].textContent!.replace(/,/g, ""));
    expect(open).toBeGreaterThan(0);
    expect(total).toBeCloseTo(open - 1265.36, 2);
  });

  it("seeds implied volatility from the broker's own option marks", () => {
    panel([position({ strike: "7650", underlying_price: "7650", market_price: "45", expiry: futureExpiry(4), average_cost: "4500" })]);
    const label = screen.getByText(/XYZ IV /).textContent!;
    const seeded = Number(label.match(/([\d.]+)%/)![1]);
    expect(seeded).toBeGreaterThan(5);
    expect(seeded).toBeLessThan(60);
    expect(seeded).not.toBe(30);
    expect(screen.getByText("From broker option marks")).toBeInTheDocument();
  });

  it("hands the volatility to the slider once it is dragged", () => {
    panel([position({ strike: "7650", underlying_price: "7650", market_price: "45", expiry: futureExpiry(4), average_cost: "4500" })]);
    const slider = screen.getByLabelText("XYZ implied volatility");
    fireEvent.change(slider, { target: { value: "80" } });
    expect(screen.getByText(/XYZ IV 80.0%/)).toBeInTheDocument();
    expect(screen.getByText(/Manual · market/)).toBeInTheDocument();
  });

  it("models one expiry at a time when the book spans several", () => {
    panel([
      position({ con_id: 1, expiry: futureExpiry(4), strike: "7650", underlying_price: "7650" }),
      position({ con_id: 2, expiry: futureExpiry(11), strike: "7700", underlying_price: "7650" }),
    ]);
    expect(screen.getByText(/2 included legs/)).toBeInTheDocument();
    const filter = screen.getByLabelText("Expiry");
    fireEvent.change(filter, { target: { value: futureExpiry(4) } });
    expect(screen.getByText(/1 included legs/)).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "" } });
    expect(screen.getByText(/2 included legs/)).toBeInTheDocument();
  });

  it("asks for booked P&L by live cycle rather than by the open legs", async () => {
    panel([position({ sec_type: "STK", average_cost: "80", market_price: "100" })]);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const url = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls[0][0];
    expect(url).toContain("active_on=");
    expect(url).not.toContain("expiries=");
  });

  it("splits the hover readout across the line, the axis and the curves", async () => {
    panel([position({ strike: "7650", underlying_price: "7650", market_price: "45", expiry: futureExpiry(4), average_cost: "4500" })]);
    await waitFor(() => expect(charts).toHaveLength(1));
    const option = charts[0].option as {
      tooltip: { formatter: (s: { axisValue: number }[]) => string; position: (p: number[], a: unknown, b: unknown, c: unknown, s: { contentSize: number[]; viewSize: number[] }) => number[] };
      axisPointer: { label: { formatter: (a: { value: number }) => string } };
      series: { emphasis?: { label: { position: string; formatter: (a: { value: [number, number] }) => string } } }[];
    };

    expect(option.tooltip.formatter([{ axisValue: 7803 }])).toContain("7,803.00");
    expect(option.tooltip.formatter([{ axisValue: 7803 }])).toContain("%");
    const at = (x: number) =>
      option.tooltip.position([x, 250], null, null, null, { contentSize: [120, 30], viewSize: [800, 420] });
    expect(at(400)).toEqual([340, 6]);
    expect(at(10)).toEqual([4, 6]);
    expect(at(790)).toEqual([676, 6]);

    const odds = option.axisPointer.label.formatter({ value: 7803 });
    expect(odds).toContain("◄");
    expect(odds).toContain("►");
    expect(odds).toMatch(/%/);

    const labelled = option.series.filter(s => s.emphasis);
    expect(labelled).toHaveLength(2);
    expect(labelled[0].emphasis!.label.formatter({ value: [7803, -129.45] })).toBe("-129.45");
    expect(labelled[0].emphasis!.label.position).toBe("top");
    expect(labelled[1].emphasis!.label.position).toBe("bottom");
  });

  it("keeps every readout in its own band, with nothing stacked on anything", async () => {
    panel([position({ strike: "7650", underlying_price: "7650", market_price: "45", expiry: futureExpiry(4), average_cost: "4500" })]);
    await waitFor(() => expect(charts).toHaveLength(1));
    const option = charts[0].option as {
      legend: { top: number };
      grid: { top: number; bottom: number };
      xAxis: { name?: string };
      series: { markLine?: { label: { position: string } } }[];
    };

    const HOVER_BOTTOM = 6 + 32;
    expect(option.legend.top).toBeGreaterThanOrEqual(HOVER_BOTTOM);
    expect(option.grid.top).toBeGreaterThan(option.legend.top);

    expect(option.xAxis.name).toBeUndefined();
    expect(option.grid.bottom).toBeGreaterThanOrEqual(88);

    const marked = option.series.find(s => s.markLine);
    expect(marked!.markLine!.label.position).toBe("insideStartTop");
  });

  it("carries closed legs by default, and drops them on request", async () => {
    panel(
      [position({ sec_type: "STK", average_cost: "80", market_price: "100" })],
      {},
      [{ realized_pnl: "-1265.36", commission: "1.73", currency: "USD", account_id: "A" }],
    );
    const table = await screen.findByRole("table", { name: /RMS by account ID/ });
    await waitFor(() => expect(table).toHaveTextContent("Booked P&L (closed legs)"));
    const total = () => screen.getByRole("row", { name: /Desk total terminal/ }).querySelectorAll("td")[3].textContent!;
    const withClosed = Number(total().replace(/,/g, ""));

    fireEvent.click(screen.getByLabelText(/Include closed legs/));
    await waitFor(() => expect(table).not.toHaveTextContent("Booked P&L (closed legs)"));
    const withoutClosed = Number(total().replace(/,/g, ""));
    expect(withoutClosed).toBeCloseTo(withClosed + 1265.36, 2);
    expect(table).not.toHaveTextContent("includes booked P&L from closed legs");
    expect(screen.getByText(/of P&L booked on closed legs this cycle is excluded/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Include closed legs/));
    await waitFor(() => expect(table).toHaveTextContent("Booked P&L (closed legs)"));
  });

  it("offers no closed-leg switch when nothing was booked", async () => {
    panel([position({ sec_type: "STK", average_cost: "80", market_price: "100" })]);
    await screen.findByRole("table", { name: /RMS by account ID/ });
    expect(screen.queryByLabelText(/Include closed legs/)).toBeNull();
  });

  it("keeps a series switched off in the legend across a price refresh", async () => {
    const first = position({ strike: "7650", underlying_price: "7650", market_price: "45", expiry: futureExpiry(4), average_cost: "4500" });
    const { rerender } = panel([first]);
    await waitFor(() => expect(charts).toHaveLength(1));
    const chart = charts[0];

    chart.option.legend = [{ selected: { Today: false, "At expiry": true } }];

    rerender(<PayoffPanel rows={[{ ...first, underlying_price: "7680" }]} loading={false} error={false} light={false} />);

    await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(2));
    const legend = chart.option.legend as unknown as { selected?: Record<string, boolean> };
    expect(legend.selected).toEqual({ Today: false, "At expiry": true });
  });

  it("keeps a series switched off when the price feed redraws the chart", async () => {
    const { rerender } = panel([position({ sec_type: "STK", average_cost: "80", market_price: "100" })], { accountId: "A" });
    await waitFor(() => expect(charts).toHaveLength(1));
    const chart = charts[0];

    chart.option.legend = [{ ...(chart.option.legend as object), selected: { Probability: false } }];

    rerender(<PayoffPanel rows={[position({ sec_type: "STK", average_cost: "80", market_price: "101" })]} accountId="A" loading={false} error={false} light={false} />);
    await waitFor(() => expect(chart.setOption).toHaveBeenCalledTimes(2));

    const legend = chart.option.legend as { selected?: Record<string, boolean> };
    expect(legend.selected).toEqual({ Probability: false });
  });

  it("names its series stably, so a legend toggle survives a slider drag", async () => {
    panel([position({ strike: "7650", underlying_price: "7650", market_price: "45", expiry: futureExpiry(4), average_cost: "4500" })]);
    await waitFor(() => expect(charts).toHaveLength(1));
    const names = (charts[0].option.series as { name: string }[]).map(s => s.name);
    expect(names).toEqual(["Probability", "At expiry", "Pre-expiry estimate"]);
    for (const name of names) expect(name).not.toMatch(/\d/);
  });

  it("registers the echarts components its option actually relies on", async () => {
    const echarts = await import("echarts/core");
    const used = (echarts.use as unknown as { mock: { calls: [unknown[]][] } }).mock.calls.flat(2);
    const components = await import("echarts/components");
    expect(used).toContain(components.AxisPointerComponent);
    expect(used).toContain(components.VisualMapComponent);
  });

  it("puts the odds of finishing either side of the cursor under the axis", async () => {
    panel([position({ strike: "7650", underlying_price: "7650", market_price: "45", expiry: futureExpiry(4), average_cost: "4500" })]);
    await waitFor(() => expect(charts).toHaveLength(1));
    const option = charts[0].option as {
      xAxis: { axisPointer?: { label: { formatter: (a: { value: number }) => string } } };
    };
    const label = option.xAxis.axisPointer!.label.formatter({ value: 7900 });
    expect(label).toMatch(/◄ \d/);
    expect(label).toMatch(/\d.*% ►/);
    const [below, above] = label.replace(/[◄►\s]/g, "").split("%").filter(Boolean).map(Number);
    expect(below).toBeGreaterThan(above);
    expect(below + above).toBeCloseTo(100, 0);
  });

  it("leaves commissions out of booked P&L until the box is ticked", async () => {
    panel(
      [position({ sec_type: "STK", average_cost: "80", market_price: "100" })],
      {},
      [{ realized_pnl: "-1000", commission: "25", currency: "USD", account_id: "A" }],
    );
    await screen.findByText(/Booked P&L from closed legs/);
    const booked = () => screen.getByText(/Booked P&L from closed legs/).parentElement!.textContent!;
    expect(booked()).toContain("-1,000.00");
    fireEvent.click(screen.getByLabelText("Include commissions"));
    await waitFor(() => expect(booked()).toContain("-1,025.00"));
  });
});
