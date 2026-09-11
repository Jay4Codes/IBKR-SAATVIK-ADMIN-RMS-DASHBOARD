import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GatewayStatus } from "@/components/gateway-status";
import { AccountsTable, ExecutionsTable, PositionsTable, money } from "@/components/tables";
import { Account, Execution, Position } from "@/lib/types";

const account = (id: string, nlv: string) =>
  ({
    account_id: id,
    currency: "USD",
    net_liquidation: nlv,
    day_pnl: "-12.25",
    unrealized_pnl: "30",
    available_funds: "400",
    excess_liquidity: "200",
    open_positions: 2,
    open_orders: 1,
    updated_at: new Date().toISOString(),
  }) as Account;
describe("gateway", () => {
  it("shows connected state and heartbeat age", () => {
    render(
      <GatewayStatus
        clock={Date.parse("2026-09-08T12:00:02Z")}
        gateway={{
          status: "CONNECTED",
          last_heartbeat: "2026-09-08T12:00:00Z",
          connected_at: "2026-09-08T11:00:00Z",
          reconnect_attempts: 2,
        }}
      />,
    );
    expect(screen.getByText("Online")).toBeInTheDocument();
    // The facts grid is collapsed until asked for.
    expect(screen.queryByText(/2s ago/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText(/2s ago/)).toBeInTheDocument();
  });
  it("marks stale connected workers as degraded", () => {
    render(
      <GatewayStatus
        clock={Date.parse("2026-09-08T12:02:00Z")}
        gateway={{
          status: "CONNECTED",
          last_heartbeat: "2026-09-08T12:00:00Z",
          connected_at: null,
          reconnect_attempts: 0,
        }}
      />,
    );
    expect(screen.getByText("DEGRADED")).toBeInTheDocument();
  });
});
describe("tables", () => {
  it("filters accounts and opens a row", () => {
    const open = vi.fn();
    render(
      <AccountsTable
        rows={[account("DU1", "1000"), account("DU2", "2000")]}
        onRow={open}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search table"), {
      target: { value: "DU2" },
    });
    expect(screen.queryByText("DU1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("DU2"));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: "DU2" }),
    );
  });
  it("sorts monetary values numerically", () => {
    render(
      <AccountsTable
        rows={[account("DU1", "1000"), account("DU2", "20")]}
        onRow={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Net liquidation" }));
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("DU2");
  });
  it("renders an option label with expiry strike and right", () => {
    const row = {
      account_id: "DU1",
      con_id: 123,
      symbol: "SPX",
      local_symbol: "",
      sec_type: "OPT",
      currency: "USD",
      expiry: "20260918",
      strike: "6000",
      right: "C",
      quantity: "2",
      average_cost: "1200",
      market_price: null,
      market_value: null,
      unrealized_pnl: "-20",
    } as Position;
    render(<PositionsTable rows={[row]} />);
    expect(screen.getByText("SPX 2026-09-18 6000 C")).toBeInTheDocument();
    expect(screen.getByText("-20.00")).toHaveClass("negative");
  });
  it("preserves decimal precision and missing values", () => {
    expect(money("9007199254740993.25")).toBe("9,007,199,254,740,993.25");
    expect(money(null)).toBe("—");
  });
  it("shows the traded rate gross and commission separately", () => {
    const row = {
      account_id: "DU1",
      execution_id: "fill-1",
      symbol: "AAPL",
      side: "BOT",
      quantity: "2",
      price: "200.125",
      commission: "0.35",
      exchange: "NASDAQ",
      order_id: 7,
      executed_at: "2026-09-10T10:00:00Z",
    } as Execution;
    render(<ExecutionsTable rows={[row]} />);
    expect(screen.getByRole("columnheader", { name: /Traded rate.*gross/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Commission/ })).toBeInTheDocument();
    expect(screen.getByText("200.13")).toBeInTheDocument();
    expect(screen.getByText("0.35")).toBeInTheDocument();
  });
});
