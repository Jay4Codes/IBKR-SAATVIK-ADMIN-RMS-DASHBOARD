import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PayoffPanel } from "@/components/payoff-panel";
import { Position } from "@/lib/types";
import { expiryDate } from "@/lib/payoff";

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
afterEach(() => {
  vi.unstubAllGlobals();
  charts.length = 0;
  localStorage.removeItem("rms.levels.custom");
  localStorage.removeItem("rms.levels.price");
  localStorage.removeItem("rms.columns.order");
});

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

  it("does not put removable chips on the default 1/3/5/10 percent levels", () => {
    localStorage.removeItem("rms.levels.custom");
    localStorage.removeItem("rms.levels.price");
    panel([position({ sec_type: "STK", average_cost: "80", market_price: "100" })]);
    expect(screen.queryByRole("group", { name: "Scenario columns" })).toBeNull();
    for (const level of ["±1%", "±3%", "±5%", "±10%"]) {
      expect(screen.queryByRole("button", { name: `Remove the ${level} scenario column` })).toBeNull();
    }

    fireEvent.change(screen.getByLabelText("Add a custom scenario level, in percent"), { target: { value: "7" } });
    const add = screen.getByLabelText("Add a custom scenario level, in percent")
      .closest("label")!
      .querySelector("button")!;
    fireEvent.click(add);
    expect(screen.getByRole("button", { name: "Remove the ±7% scenario column" })).toBeInTheDocument();
    for (const level of ["±1%", "±3%", "±5%", "±10%"]) {
      expect(screen.queryByRole("button", { name: `Remove the ${level} scenario column` })).toBeNull();
    }

    fireEvent.change(screen.getByLabelText("Add a scenario level at an absolute price"), { target: { value: "7600" } });
    const addPrice = screen.getByLabelText("Add a scenario level at an absolute price")
      .closest("label")!
      .querySelector("button")!;
    fireEvent.click(addPrice);
    expect(screen.getByRole("button", { name: "Remove the 7,600 scenario column" })).toBeInTheDocument();
    for (const level of ["±1%", "±3%", "±5%", "±10%"]) {
      expect(screen.queryByRole("button", { name: `Remove the ${level} scenario column` })).toBeNull();
    }
  });

  it("adds booked P&L from closed legs back into the curve and shows it apart", async () => {
    panel(
      [position({ sec_type: "STK", average_cost: "80", market_price: "100" })],
      {},
      [{ realized_pnl: "-1265.36", commission: "1.73", currency: "USD", account_id: "A" }],
    );
    const table = await screen.findByRole("table", { name: /RMS by account ID/ });
    await waitFor(() => expect(table).toHaveTextContent("Booked P&L (closed legs)"));
    expect(table).toHaveTextContent("Open legs, as broker reports");
    expect(screen.getAllByText("-1,265.36").length).toBeGreaterThanOrEqual(1);
    const open = Number(screen.getByRole("row", { name: /Open legs, as broker reports/ }).querySelectorAll("td")[3].textContent!.replace(/,/g, ""));
    const total = Number(screen.getByRole("row", { name: /Desk total terminal/ }).querySelectorAll("td")[3].textContent!.replace(/,/g, ""));
    expect(open).toBeGreaterThan(0);
    expect(total).toBeCloseTo(open - 1265.36, 2);
  });

  it("moves a column when its arrow is clicked, and remembers the order", async () => {
    localStorage.removeItem("rms.columns.order");
    const { unmount } = panel([
      position({ account_id: "A", sec_type: "STK", average_cost: "80", market_price: "100" }),
    ]);
    const table = screen.getByRole("table", { name: /RMS by account ID/ });
    const headerOrder = () =>
      [...table.querySelectorAll("thead th")].slice(1).map(th => th.getAttribute("aria-label"));
    expect(headerOrder()).toEqual(["-10%", "-5%", "-3%", "-1%", "+1%", "+3%", "+5%", "+10%"]);

    // Capture the underlying level shown under each heading before moving —
    // the values are position-dependent, not hardcoded, so the row cells can
    // be checked to have moved along with their header rather than stayed put.
    const level = screen.getByRole("row", { name: /Scenario underlying level/ });
    const before = [...level.querySelectorAll("td")].map(td => td.textContent);

    // Move -10% one step right, past -5%.
    fireEvent.click(screen.getByRole("button", { name: "Move -10% right" }));
    expect(headerOrder()).toEqual(["-5%", "-10%", "-3%", "-1%", "+1%", "+3%", "+5%", "+10%"]);
    // The row cells follow the header: the two swapped levels traded places,
    // not just their labels.
    const after = [...level.querySelectorAll("td")].map(td => td.textContent);
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
    expect(after.slice(2)).toEqual(before.slice(2));

    // A leading column has nowhere left to go.
    expect(screen.getByRole("button", { name: "Move -5% left" })).toBeDisabled();

    unmount();

    // The order survives a remount, the same way the levels themselves do.
    panel([position({ account_id: "A", sec_type: "STK", average_cost: "80", market_price: "100" })]);
    expect(headerOrder()).toEqual(["-5%", "-10%", "-3%", "-1%", "+1%", "+3%", "+5%", "+10%"]);
    localStorage.removeItem("rms.columns.order");
  });

  it("chooses which accounts get a row, from a menu beside the grid", async () => {
    panel([
      position({ account_id: "U1", con_id: 1, sec_type: "STK", average_cost: "80", market_price: "100" }),
      position({ account_id: "U2", con_id: 2, sec_type: "STK", average_cost: "90", market_price: "100" }),
    ]);
    await screen.findByRole("table", { name: /RMS by account ID/ });
    const rowFor = (id: string) => screen.queryByRole("row", { name: new RegExp(`^${id} terminal`) });
    expect(rowFor("U1")).toBeInTheDocument();
    expect(rowFor("U2")).toBeInTheDocument();

    // The summary says what is shown without having to open it.
    expect(screen.getByText("All 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "U2" }));
    expect(rowFor("U2")).toBeNull();
    expect(rowFor("U1")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();

    // "Show all" puts it back, and the desk total never depended on the choice.
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(rowFor("U2")).toBeInTheDocument();
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

  it("lets a book spanning several cycles be modelled a cycle at a time", () => {
    const near = futureExpiry(4);
    const far = futureExpiry(11);
    panel([
      position({ con_id: 1, expiry: near, strike: "7650", underlying_price: "7650" }),
      position({ con_id: 2, expiry: far, strike: "7700", underlying_price: "7650" }),
    ]);
    // Both cycles on to begin with: every live expiry is modelled.
    expect(screen.getByText("All 2")).toBeInTheDocument();
    expect(screen.getByText(/2 included legs/)).toBeInTheDocument();

    // Deselecting one leaves the other, rather than selecting only the one
    // clicked — the bug a naive toggle has when nothing is stored yet.
    fireEvent.click(screen.getByRole("checkbox", { name: expiryDate(far) }));
    expect(screen.getByText(/1 included legs/)).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show all cycles" }));
    expect(screen.getByText(/2 included legs/)).toBeInTheDocument();
  });

  it("names the single cycle outright when there is only one", async () => {
    const only = futureExpiry(9);
    panel([position({ con_id: 1, expiry: only, strike: "7650", underlying_price: "7650" })]);
    // "All 1" would be a strange thing to tell someone holding one expiry, so
    // the summary names the cycle itself.
    const summary = document.querySelector(".expiry-picker summary")!;
    expect(summary.textContent).toContain(expiryDate(only));
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

  it("gives visualMap pieces finite bounds so the line renderer does not crash", async () => {
    panel([position({ strike: "7650", underlying_price: "7650", market_price: "45", expiry: futureExpiry(4), average_cost: "4500" })]);
    await waitFor(() => expect(charts).toHaveLength(1));
    const option = charts[0].option as { visualMap: { pieces: { gt?: number; lte?: number }[] } };
    expect(option.visualMap.pieces).toHaveLength(2);
    for (const piece of option.visualMap.pieces) {
      expect(Number.isFinite(piece.gt)).toBe(true);
      expect(Number.isFinite(piece.lte)).toBe(true);
    }
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

  it("adds back the commission IBKR buried in average cost", async () => {
    /* The finding that prompted this: IBKR's average_cost already contains the
       commission, moved against the trader. Verified on the live book to four
       decimals — a long's cost is price + commission, a short's is price −
       commission. So a payoff built from average cost is already net, and the
       dashboard read 11.04 worse than a tool pricing off the premium alone.
       Unticked means gross, which means adding it back. */
    panel(
      [position({ sec_type: "STK", average_cost: "80", market_price: "100" })],
      {},
      [
        { realized_pnl: "0.0", commission: "5.00", currency: "USD", account_id: "A" },
        { realized_pnl: "0.0", commission: "6.04", currency: "USD", account_id: "A" },
      ],
    );
    await screen.findByRole("table", { name: /RMS by account ID/ });
    const total = () => Number(
      screen.getByRole("row", { name: /Desk total terminal/ }).querySelectorAll("td")[3].textContent!.replace(/,/g, ""),
    );
    const says = (re: RegExp) => re.test(document.body.textContent ?? "");
    // Default is gross: the 11.04 the broker took out is put back. Waited for,
    // because reading before the realized data lands measures the raw curve.
    await waitFor(() => expect(says(/added back/)).toBe(true));
    const grossShown = total();
    // The adjustment is labelled for what it is. Nothing has been closed, so
    // there is no booked P&L row to confuse it with.
    const row = (name: RegExp) => screen.queryByRole("row", { name });
    expect(row(/Commissions added back/)).toBeInTheDocument();
    expect(row(/Booked P&L \(closed legs\)/)).toBeNull();

    fireEvent.click(screen.getByLabelText("Include commissions"));
    // Ticked is what the broker actually charged, which is 11.04 worse.
    await waitFor(() => expect(total()).toBeCloseTo(grossShown - 11.04, 2));
    expect(says(/Net of commissions/)).toBe(true);
  });

  it("does not add back a closing fill's commission twice", async () => {
    // A closing fill's commission is already inside the realized P&L the broker
    // reports for it; adding it back as well would overstate the gross figure.
    panel(
      [position({ sec_type: "STK", average_cost: "80", market_price: "100" })],
      {},
      [
        { realized_pnl: "-100.00", commission: "4.00", currency: "USD", account_id: "A" },
        { realized_pnl: "0.0", commission: "3.00", currency: "USD", account_id: "A" },
      ],
    );
    await screen.findByRole("table", { name: /RMS by account ID/ });
    // Only the opening fill's 3.00 is described as added back.
    await waitFor(() =>
      expect(document.body.textContent ?? "").toMatch(/3\.00 USD IBKR embedded/),
    );
    expect(document.body.textContent ?? "").not.toMatch(/7\.00 USD IBKR embedded/);
    // Both adjustments present, each under its own name.
    expect(screen.getByRole("row", { name: /Booked P&L \(closed legs\)/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Commissions added back/ })).toBeInTheDocument();
  });

  it("leaves a closing fill's commission where the broker already put it", async () => {
    /* IBKR reports realized P&L for a closing fill with its commission already
       accounted for, so there is nothing for the toggle to add or remove: the
       box changes what is *embedded in average cost*, which only open legs have. */
    panel(
      [position({ sec_type: "STK", average_cost: "80", market_price: "100" })],
      {},
      [{ realized_pnl: "-1000", commission: "25", currency: "USD", account_id: "A" }],
    );
    await screen.findByText(/Booked P&L from closed legs/);
    const booked = () => screen.getByText(/Booked P&L from closed legs/).parentElement!.textContent!;
    expect(booked()).toContain("-1,000.00");
    fireEvent.click(screen.getByLabelText("Include commissions"));
    await waitFor(() => expect(booked()).toContain("-1,000.00"));
  });
});
