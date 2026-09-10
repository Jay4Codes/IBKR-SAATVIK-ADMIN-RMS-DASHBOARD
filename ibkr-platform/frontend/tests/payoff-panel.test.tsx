import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PayoffPanel } from "@/components/payoff-panel";
import { Position } from "@/lib/types";

vi.mock("echarts/core", () => ({ use: vi.fn(), init: () => ({ setOption: vi.fn(), dispose: vi.fn(), resize: vi.fn() }) }));
vi.mock("echarts/charts", () => ({ LineChart: {} }));
vi.mock("echarts/components", () => ({ GridComponent: {}, TooltipComponent: {}, LegendComponent: {}, MarkLineComponent: {} }));
vi.mock("echarts/renderers", () => ({ SVGRenderer: {} }));
afterEach(() => vi.unstubAllGlobals());

function position(fields: Partial<Position> = {}): Position {
  return { account_id: "A", con_id: 1, symbol: "XYZ", local_symbol: "", sec_type: "OPT", currency: "USD", expiry: "20991231", strike: "100", right: "C", multiplier: "100", quantity: "1", average_cost: "500", market_price: "5", market_value: "500", unrealized_pnl: "0", ...fields };
}
function panel(rows: Position[], props: Partial<React.ComponentProps<typeof PayoffPanel>> = {}) {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  return render(<PayoffPanel rows={rows} loading={false} error={false} light={false} {...props} />);
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
    expect(screen.getByRole("table")).toHaveAccessibleName("Scenario P&L (USD)");
    fireEvent.change(screen.getByLabelText("Volatility (%)"), { target: { value: "" } });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
  it("separates currencies and labels account scope", async () => {
    panel([position({ sec_type: "STK", average_cost: "80", market_price: "100" }), position({ sec_type: "STK", currency: "EUR", con_id: 2, average_cost: "90", market_price: "100" })], { accountId: "A" });
    expect(screen.getByRole("heading")).toHaveTextContent("Account payoff");
    expect(screen.getByRole("table")).toHaveAccessibleName("Scenario P&L (EUR)");
    fireEvent.change(screen.getByLabelText("Risk currency"), { target: { value: "USD" } });
    expect(screen.getByRole("table")).toHaveAccessibleName("Scenario P&L (USD)");
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
    const stock = position({ sec_type: "STK", average_cost: "80", market_price: "100" });
    const { rerender } = panel([stock], { accountId: "A" });
    expect(screen.getByLabelText("Reference price")).toHaveValue(100);
    rerender(<PayoffPanel rows={[{ ...stock, market_price: "110" }]} accountId="A" loading={false} error={false} light={false} />);
    expect(screen.getByLabelText("Reference price")).toHaveValue(110);
    expect(screen.getAllByText("30.00")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Reference price"), { target: { value: "120" } });
    rerender(<PayoffPanel rows={[{ ...stock, market_price: "115" }]} accountId="A" loading={false} error={false} light={false} />);
    expect(screen.getByLabelText("Reference price")).toHaveValue(120);
    expect(screen.getAllByText("40.00")).toHaveLength(2);
  });
  it("prefills the reference price from the broker's underlying mark", () => {
    const { rerender } = panel([position({ underlying_price: "7612.5" })]);
    expect(screen.getByLabelText("Reference price")).toHaveValue(7612.5);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Live broker mark")).toBeInTheDocument();
    rerender(<PayoffPanel rows={[position({ underlying_price: "7650" })]} loading={false} error={false} light={false} />);
    expect(screen.getByLabelText("Reference price")).toHaveValue(7650);
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
  it("shows an empty state for a flat desk", () => {
    panel([position({ quantity: "0" })]);
    expect(screen.getByText("No open positions to model.")).toBeInTheDocument();
  });
});
