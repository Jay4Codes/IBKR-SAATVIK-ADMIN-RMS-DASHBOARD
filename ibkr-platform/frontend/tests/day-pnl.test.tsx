import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DayPnlPanel } from "@/components/day-pnl";
import { setZone } from "@/components/timezone";
import { STORAGE_KEY } from "@/lib/timezone";

const apiMock = vi.hoisted(() => vi.fn());
const options = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@/lib/api", () => ({ api: apiMock }));
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

function tick(account: string, stamp: string, pnl: string | null) {
  return {
    account_id: account, report_date: "2026-09-10", taken_at: `2026-09-10T${stamp}:00+00:00`,
    currency: "USD", net_liquidation: "5000", day_pnl: pnl, source: "snapshot",
  };
}

function panel(props: Partial<React.ComponentProps<typeof DayPnlPanel>> = {}) {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DayPnlPanel accounts={["U1", "U2"]} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiMock.mockReset();
  options.length = 0;
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("day P&L", () => {
  it("labels the axis and points in the chosen timezone", async () => {
    apiMock.mockResolvedValue({
      date: "2026-09-10", accounts: ["U1"],
      series: [tick("U1", "13:35", "10"), tick("U1", "13:40", "25")],
      combined: [
        { taken_at: "2026-09-10T13:35:00+00:00", accounts: 1, day_pnl: "10" },
        { taken_at: "2026-09-10T13:40:00+00:00", accounts: 1, day_pnl: "25" },
      ],
    });
    panel({ accountId: "U1" });
    await screen.findByRole("img");
    await waitFor(() => expect(options.length).toBeGreaterThan(0));
    const option = options.at(-1) as { xAxis: { name: string; data: string[] }; yAxis: { name: string } };
    expect(option.xAxis.name).toBe("Time (ET)");
    expect(option.xAxis.data[0]).toMatch(/9:35:00.AM/);
    expect(option.yAxis.name).toBe("Day P&L (USD)");
  });

  it("redraws in the newly chosen zone", async () => {
    apiMock.mockResolvedValue({
      date: "2026-09-10", accounts: ["U1"],
      series: [tick("U1", "13:35", "10"), tick("U1", "13:40", "25")],
      combined: [],
    });
    panel({ accountId: "U1" });
    await screen.findByRole("img");
    await waitFor(() => expect(options.length).toBeGreaterThan(0));
    setZone("IST");
    await waitFor(() => {
      const option = options.at(-1) as { xAxis: { name: string; data: string[] } };
      expect(option.xAxis.name).toBe("Time (IST)");
      expect(option.xAxis.data[0]).toMatch(/7:05:00.PM/);
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBe("IST");
  });

  it("shows the latest figure in the heading, coloured by sign", async () => {
    apiMock.mockResolvedValue({
      date: "2026-09-10", accounts: ["U1"],
      series: [tick("U1", "13:35", "10"), tick("U1", "13:40", "-42.5")],
      combined: [],
    });
    panel({ accountId: "U1" });
    const latest = await screen.findByText(/-42\.50/);
    expect(latest).toHaveClass("negative");
  });

  it("asks only for the accounts still ticked", async () => {
    apiMock.mockResolvedValue({ date: "2026-09-10", accounts: ["U1", "U2"], series: [], combined: [] });
    panel();
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("checkbox", { name: "U2" }));
    await waitFor(() => expect(apiMock.mock.calls.at(-1)?.[0]).toContain("accounts=U1&"));
  });

  it("waits for a second point rather than drawing a single dot", async () => {
    apiMock.mockResolvedValue({
      date: "2026-09-10", accounts: ["U1"], series: [tick("U1", "13:35", "10")], combined: [],
    });
    panel({ accountId: "U1" });
    expect(await screen.findByText(/Not enough points yet/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("leaves a gap where the broker never valued the account", async () => {
    apiMock.mockResolvedValue({
      date: "2026-09-10", accounts: ["U1"],
      series: [tick("U1", "13:35", "10"), tick("U1", "13:40", null), tick("U1", "13:45", "30")],
      combined: [],
    });
    panel({ accountId: "U1" });
    await screen.findByRole("img");
    await waitFor(() => expect(options.length).toBeGreaterThan(0));
    const option = options.at(-1) as { series: { data: (number | null)[] }[] };
    expect(option.series[0].data).toEqual([10, null, 30]);
  });
});
