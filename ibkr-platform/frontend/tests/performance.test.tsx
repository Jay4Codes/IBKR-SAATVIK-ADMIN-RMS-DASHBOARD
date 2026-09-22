import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerformancePanel } from "@/components/performance";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("echarts/core", () => ({ use: vi.fn(), init: () => ({ setOption: vi.fn(), getOption: () => ({}), dispose: vi.fn(), resize: vi.fn() }) }));
vi.mock("echarts/charts", () => ({ LineChart: {} }));
vi.mock("echarts/components", () => ({ GridComponent: {}, TooltipComponent: {}, LegendComponent: {}, MarkLineComponent: {}, DataZoomInsideComponent: {}, DataZoomSliderComponent: {}, AxisPointerComponent: {}, VisualMapComponent: {} }));
vi.mock("echarts/renderers", () => ({ SVGRenderer: {} }));

function point(account: string, date: string, value: string, currency = "USD") {
  return { account_id: account, report_date: date, taken_at: `${date}T23:00:00Z`, currency, net_liquidation: value, source: "snapshot" };
}

function panel(props: Partial<React.ComponentProps<typeof PerformancePanel>> = {}) {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PerformancePanel accounts={["U1", "U2"]} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => apiMock.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("portfolio performance", () => {
  it("plots the combined line and reports the change over the range", async () => {
    apiMock.mockResolvedValue({
      accounts: ["U1", "U2"],
      series: [point("U1", "2026-09-01", "100"), point("U2", "2026-09-01", "50"), point("U1", "2026-09-02", "120"), point("U2", "2026-09-02", "55")],
      combined: [
        { report_date: "2026-09-01", accounts: 2, net_liquidation: "150", currencies: ["USD"] },
        { report_date: "2026-09-02", accounts: 2, net_liquidation: "175", currencies: ["USD"] },
      ],
    });
    panel();
    expect(await screen.findByRole("img")).toBeInTheDocument();
    expect(screen.getByText("25.00")).toBeInTheDocument();
    expect(screen.getByText("16.67%")).toBeInTheDocument();
  });

  it("asks the API only for the accounts still ticked", async () => {
    apiMock.mockResolvedValue({ accounts: ["U1", "U2"], series: [point("U1", "2026-09-01", "100")], combined: [] });
    panel();
    await screen.findByRole("img");
    fireEvent.click(screen.getByRole("checkbox", { name: "U2" }));
    await waitFor(() => {
      expect(apiMock.mock.calls.at(-1)?.[0]).toContain("accounts=U1");
    });
    expect(apiMock.mock.calls.at(-1)?.[0]).not.toContain("U2");
  });

  it("offers select-all and clear on the account picker", async () => {
    apiMock.mockResolvedValue({ accounts: ["U1", "U2"], series: [point("U1", "2026-09-01", "100")], combined: [] });
    panel();
    await screen.findByRole("img");

    fireEvent.click(screen.getByRole("button", { name: "Clear accounts" }));
    expect(screen.getByText("0 of 2 accounts")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/No accounts selected/);
    expect(screen.queryByRole("img")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Select all accounts" }));
    expect(screen.getByText("2 of 2 accounts")).toBeInTheDocument();
    await screen.findByRole("img");
  });

  it("narrows the window when a shorter range is picked", async () => {
    apiMock.mockResolvedValue({ accounts: ["U1"], series: [point("U1", "2026-09-01", "100")], combined: [] });
    panel();
    await screen.findByRole("img");
    fireEvent.click(screen.getByRole("tab", { name: "1M" }));
    await waitFor(() => expect(apiMock.mock.calls.at(-1)?.[0]).toMatch(/since=\d{4}-\d{2}-\d{2}/));
    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    await waitFor(() => expect(apiMock.mock.calls.at(-1)?.[0]).not.toContain("since="));
  });

  it("explains an empty history rather than drawing an empty chart", async () => {
    apiMock.mockResolvedValue({ accounts: ["U1", "U2"], series: [], combined: [] });
    panel();
    expect(await screen.findByText(/No history recorded yet/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("warns when the accounts do not share a currency", async () => {
    apiMock.mockResolvedValue({
      accounts: ["U1", "U2"],
      series: [point("U1", "2026-09-01", "100", "USD"), point("U2", "2026-09-01", "50", "INR")],
      combined: [{ report_date: "2026-09-01", accounts: 2, net_liquidation: "150", currencies: ["INR", "USD"] }],
    });
    panel();
    expect(await screen.findByRole("note")).toHaveTextContent(/nothing here converts FX/);
  });

  it("asks a single account's own endpoint and hides the picker", async () => {
    apiMock.mockResolvedValue([point("U1", "2026-09-01", "100")]);
    panel({ accountId: "U1" });
    await screen.findByRole("img");
    expect(apiMock.mock.calls[0][0]).toMatch(/^\/accounts\/U1\/history/);
    expect(screen.queryByRole("group", { name: /Accounts in this view/ })).not.toBeInTheDocument();
  });
});
