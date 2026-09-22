import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PnlCards } from "@/components/pnl-cards";
import { CommissionSummary, RealizedSummary } from "@/lib/types";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

function leg(fields: Partial<RealizedSummary["legs"][number]> = {}): RealizedSummary["legs"][number] {
  return {
    execution_id: "e1",
    symbol: "SPXW  260918P07480000",
    underlying: "SPX",
    currency: "USD",
    expiry: "20260918",
    account_id: "DU1",
    side: "SLD",
    quantity: "1",
    price: "11.83",
    realized_pnl: "-1265.36",
    commission: "1.73",
    executed_at: "2026-09-11T19:17:22Z",
    ...fields,
  };
}

const realized: RealizedSummary = {
  total: "-865.36",
  commission: "4.48",
  count: 2,
  by_account: [
    { account_id: "DU1", realized_pnl: "-1265.36" },
    { account_id: "DU2", realized_pnl: "400.00" },
  ],
  legs: [
    leg(),
    leg({
      execution_id: "e2",
      account_id: "DU2",
      realized_pnl: "400.00",
      commission: "1.00",
      symbol: "SPXW  260918C07750000",
    }),
    leg({
      execution_id: "e3",
      account_id: "DU1",
      realized_pnl: "0.0",
      commission: "1.75",
      side: "BOT",
    }),
  ],
};

const commissions: CommissionSummary = {
  total: "4.48",
  count: 3,
  by_day: [],
  by_account: [
    { account_id: "DU1", commission: "3.48" },
    { account_id: "DU2", commission: "1.00" },
  ],
  fills: [
    { execution_id: "e1", account_id: "DU1", commission: "1.73" },
    { execution_id: "e2", account_id: "DU2", commission: "1.00" },
    { execution_id: "e3", account_id: "DU1", commission: "1.75" },
  ],
};

async function panel(accountId?: string) {
  apiMock.mockImplementation(async (path: string) =>
    path.startsWith("/realized") ? realized : commissions,
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <PnlCards accountId={accountId} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.queryByText("Loading P&L…")).not.toBeInTheDocument());
  return view;
}

function card(label: string) {
  const heading = screen.getAllByText(label).find(node => node.tagName === "LABEL");
  if (!heading) throw new Error(`No summary card labelled ${label}`);
  return heading.closest("div")!;
}

describe("P&L cards", () => {
  it("totals booked P&L and commissions across accounts and fills", async () => {
    await panel();
    expect(within(card("Booked P&L")).getByText("-865.36").className).toMatch(/negative/);
    expect(within(card("Commissions")).getByText("-4.48").className).toMatch(/negative/);
    expect(within(card("Net of commission")).getByText("-869.84").className).toMatch(/negative/);
    expect(within(card("Closing fills")).getByText("2")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "By account" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "By execution ID" })).toBeInTheDocument();
  });

  it("narrows the cards when an account is unchecked", async () => {
    await panel();
    fireEvent.click(screen.getByRole("checkbox", { name: "DU2" }));
    expect(within(card("Booked P&L")).getByText("-1,265.36")).toBeInTheDocument();
    expect(within(card("Commissions")).getByText("-3.48")).toBeInTheDocument();
    expect(within(card("Closing fills")).getByText("1")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "By account" })).toBeNull();
    expect(screen.getByRole("table", { name: "By execution ID" })).not.toHaveTextContent("DU2");
  });

  it("narrows the cards when an execution ID is unchecked", async () => {
    await panel();
    fireEvent.click(screen.getByRole("checkbox", { name: "e2" }));
    expect(within(card("Booked P&L")).getByText("-1,265.36")).toBeInTheDocument();
    expect(within(card("Commissions")).getByText("-3.48")).toBeInTheDocument();
    expect(within(card("Closing fills")).getByText("1")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "By execution ID" })).not.toHaveTextContent("e2");
  });

  it("restores every fill from Select all and zeros the view from Clear", async () => {
    await panel();
    fireEvent.click(screen.getByRole("button", { name: "Clear execution IDs" }));
    expect(within(card("Booked P&L")).getByText("0.00")).toBeInTheDocument();
    expect(within(card("Closing fills")).getByText("0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select all execution IDs" }));
    expect(within(card("Closing fills")).getByText("2")).toBeInTheDocument();
    expect(within(card("Commissions")).getByText("-4.48")).toBeInTheDocument();
  });

  it("hides the account picker on a single-account page", async () => {
    await panel("DU1");
    expect(screen.queryByText("Accounts")).toBeNull();
    expect(screen.queryByRole("table", { name: "By account" })).toBeNull();
    expect(within(card("Booked P&L")).getByText("-1,265.36")).toBeInTheDocument();
  });
});
