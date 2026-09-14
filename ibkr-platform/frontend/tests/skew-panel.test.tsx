import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkewPanel } from "@/components/skew-panel";
import { Position } from "@/lib/types";

const options = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("echarts/core", () => ({
  use: vi.fn(),
  init: () => ({
    setOption: (o: Record<string, unknown>) => options.push(o),
    getOption: () => ({}),
    dispose: vi.fn(),
    resize: vi.fn(),
  }),
}));
vi.mock("echarts/charts", () => ({ LineChart: {} }));
vi.mock("echarts/components", () => ({ GridComponent: {}, TooltipComponent: {}, LegendComponent: {}, MarkLineComponent: {}, DataZoomInsideComponent: {}, DataZoomSliderComponent: {}, AxisPointerComponent: {}, VisualMapComponent: {} }));
vi.mock("echarts/renderers", () => ({ SVGRenderer: {} }));
afterEach(() => { vi.unstubAllGlobals(); options.length = 0; });

function spxOption(fields: Partial<Position> = {}): Position {
  return {
    account_id: "A", con_id: 1, symbol: "SPX", local_symbol: "", sec_type: "OPT", currency: "USD",
    expiry: "20991219", strike: "6700", right: "P", multiplier: "100", quantity: "1", average_cost: "5000",
    market_price: "60", market_value: "6000", unrealized_pnl: "0", underlying_price: "6750", ...fields,
  };
}

function panel(rows: Position[]) {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  return render(<SkewPanel rows={rows} loading={false} error={false} />);
}

describe("SPX skew — own book", () => {
  it("derives strike/IV points from held SPX options and plots the first two expiries", async () => {
    panel([
      spxOption({ con_id: 1, strike: "6700", right: "P", market_price: "60" }),
      spxOption({ con_id: 2, strike: "6800", right: "C", expiry: "20991219", market_price: "80" }),
      spxOption({ con_id: 3, strike: "6750", right: "P", expiry: "20991226", market_price: "70" }),
    ]);
    await screen.findByRole("img");
    await waitFor(() => expect(options.length).toBeGreaterThan(0));
    const option = options.at(-1) as { series: { name: string; data: [number, number, string][] }[] };
    expect(option.series.map(s => s.name)).toEqual(["2099-12-19", "2099-12-26"]);
    expect(option.series[0].data.map(d => d[0])).toEqual([6700, 6800]);
    expect(option.series[1].data.map(d => d[0])).toEqual([6750]);
  });

  it("ignores other underlyings, closed legs and non-option positions", () => {
    panel([
      spxOption({ symbol: "SPY" }),
      spxOption({ con_id: 2, quantity: "0" }),
      { account_id: "A", con_id: 3, symbol: "SPX", local_symbol: "", sec_type: "STK", currency: "USD", expiry: "", strike: null, right: "", multiplier: null, quantity: "1", average_cost: "6000", market_price: "6750", market_value: "6750", unrealized_pnl: "0" },
    ]);
    expect(screen.getByText("No open SPX option positions to derive a skew from.")).toBeInTheDocument();
  });

  it("lets the reader pick a different expiry", async () => {
    panel([
      spxOption({ con_id: 1, expiry: "20991219", strike: "6700", market_price: "60" }),
      spxOption({ con_id: 2, expiry: "20991226", strike: "6750", market_price: "70" }),
    ]);
    await screen.findByRole("img");
    fireEvent.click(screen.getByLabelText("First expiry"));
    fireEvent.click(screen.getByRole("option", { name: "2099-12-26" }));
    await waitFor(() => {
      const option = options.at(-1) as { series: { name: string }[] };
      expect(option.series[0].name).toBe("2099-12-26");
    });
  });

  it("shows the loading and error states", () => {
    const { rerender } = render(<SkewPanel rows={[]} loading error={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading positions");
    rerender(<SkewPanel rows={[]} loading={false} error />);
    expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded");
  });
});
