import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
vi.mock("echarts/components", () => ({ GridComponent: {}, TooltipComponent: {}, LegendComponent: {}, MarkLineComponent: {}, DataZoomInsideComponent: {}, DataZoomSliderComponent: {} }));
vi.mock("echarts/renderers", () => ({ SVGRenderer: {} }));
afterEach(() => { vi.unstubAllGlobals(); charts.length = 0; });

function position(fields: Partial<Position> = {}): Position {
  return { account_id: "A", con_id: 1, symbol: "XYZ", local_symbol: "", sec_type: "OPT", currency: "USD", expiry: "20991231", strike: "100", right: "C", multiplier: "100", quantity: "1", average_cost: "500", market_price: "5", market_value: "500", unrealized_pnl: "0", ...fields };
}
function panel(rows: Position[], props: Partial<React.ComponentProps<typeof PayoffPanel>> = {}) {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const view = render(<PayoffPanel rows={rows} loading={false} error={false} light={false} {...props} />);
  // The model inputs are collapsed by default; open them so the assertions below
  // exercise what a reader who opened them would see.
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
    expect(screen.getByLabelText("Reference price")).toHaveValue(null);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reference price"), { target: { value: "100" } });
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
    expect(screen.getByLabelText("Reference price")).toHaveValue(100);
    rerender(<PayoffPanel rows={[{ ...stock, market_price: "110", unrealized_pnl: "30" }]} accountId="A" loading={false} error={false} light={false} />);
    expect(screen.getByLabelText("Reference price")).toHaveValue(110);
    expect(screen.getAllByText("31.10")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Reference price"), { target: { value: "120" } });
    rerender(<PayoffPanel rows={[{ ...stock, market_price: "115", unrealized_pnl: "35" }]} accountId="A" loading={false} error={false} light={false} />);
    expect(screen.getByLabelText("Reference price")).toHaveValue(120);
    expect(screen.getAllByText("34.00").length).toBeGreaterThanOrEqual(2);
  });
  it("prefills the reference price from the broker's underlying mark", () => {
    const { rerender } = panel([position({ underlying_price: "7612.5" })]);
    expect(screen.getByLabelText("Reference price")).toHaveValue(7612.5);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Live broker mark")).toBeInTheDocument();
    rerender(<PayoffPanel rows={[position({ underlying_price: "7650" })]} loading={false} error={false} light={false} />);
    expect(screen.getByLabelText("Reference price")).toHaveValue(7650);
  });
  it("recalculates both the RMS table and graph when the live reference moves", async () => {
    const first = position({ underlying_price: "100" });
    const { rerender } = panel([first]);
    await waitFor(() => expect(charts).toHaveLength(1));
    const chart = charts[0];
    const beforeRow = screen.getByRole("row", { name: /^\+1%/ }).textContent;
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
    expect(screen.getByLabelText("Reference price")).toHaveValue(110);
    expect(screen.getByText("USD:XYZ reference").parentElement).toHaveTextContent("110.00");
    const updatedRow = screen.getByRole("row", { name: /^\+1%/ });
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
    expect(screen.getByLabelText("Reference price")).toHaveValue(7583.88);
    expect(screen.getByText("Stored last underlying price — not live")).toBeInTheDocument();
  });
  it("keeps a typed reference price and hands the field back when it is cleared", () => {
    const { rerender } = panel([position({ underlying_price: "7612.5" })]);
    fireEvent.change(screen.getByLabelText("Reference price"), { target: { value: "7000" } });
    rerender(<PayoffPanel rows={[position({ underlying_price: "7650" })]} loading={false} error={false} light={false} />);
    expect(screen.getByLabelText("Reference price")).toHaveValue(7000);
    expect(screen.getByText(/Manual override; broker mark/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reference price"), { target: { value: "" } });
    expect(screen.getByLabelText("Reference price")).toHaveValue(7650);
  });
  it("prefers a held stock mark over the option-implied underlying price", () => {
    panel([position({ sec_type: "STK", average_cost: "80", market_price: "100" }), position({ con_id: 2, underlying_price: "7612.5" })]);
    expect(screen.getByLabelText("Reference price")).toHaveValue(100);
  });
  it("stays manual when the broker sends no underlying mark", () => {
    panel([position()]);
    expect(screen.getByLabelText("Reference price")).toHaveValue(null);
    expect(screen.getByText(/No broker mark available/)).toBeInTheDocument();
  });
  it("keeps the model inputs collapsed until they are asked for", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    render(<PayoffPanel rows={[position({ underlying_price: "7612.5" })]} loading={false} error={false} light={false} />);
    expect(screen.queryByRole("combobox", { name: "Risk currency" })).toBeNull();
    expect(document.getElementById("risk-inputs")).toHaveAttribute("hidden");
    fireEvent.click(screen.getByText("Model inputs"));
    expect(document.getElementById("risk-inputs")).not.toHaveAttribute("hidden");
    expect(screen.getByLabelText("Reference price")).toBeVisible();
    // The curve and the scenario table stay put either way.
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
    // echarts writes the user's window back onto the option; a refetch must not undo it.
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
  it("shows exact plus and minus one-to-five-percent RMS levels by account ID", () => {
    panel([
      position({ account_id: "A", sec_type: "STK", average_cost: "80", market_price: "100" }),
      position({ account_id: "B", con_id: 2, sec_type: "STK", average_cost: "90", market_price: "100" }),
    ]);
    const table = screen.getByRole("table", { name: /RMS by account ID/ });
    expect(table).toHaveTextContent("A terminal");
    expect(table).toHaveTextContent("B terminal");
    for (const level of ["-5%", "-4%", "-3%", "-2%", "-1%", "+1%", "+2%", "+3%", "+4%", "+5%"])
      expect(table).toHaveTextContent(level);
    expect(screen.getAllByRole("row")).toHaveLength(11);
  });
});
