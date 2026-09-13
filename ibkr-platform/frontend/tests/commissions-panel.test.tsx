import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommissionsPanel } from "@/components/commissions-panel";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

function panel(accountId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CommissionsPanel accountId={accountId} />
    </QueryClientProvider>,
  );
}

describe("commission spend", () => {
  it("asks the desk-wide endpoint and shows the total plus a per-account breakdown", async () => {
    apiMock.mockResolvedValue({
      total: "125.50",
      count: 42,
      by_day: [
        { date: "2026-09-01", commission: "50.00" },
        { date: "2026-09-02", commission: "75.50" },
      ],
      by_account: [
        { account_id: "DU1", commission: "100.00" },
        { account_id: "DU2", commission: "25.50" },
      ],
    });
    panel();
    expect(await screen.findByText("125.50")).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith("/commissions");
    expect(screen.getByText("42 executions with a reported commission")).toBeInTheDocument();
    expect(screen.getByText("DU1")).toBeInTheDocument();
    expect(screen.getByText("100.00")).toBeInTheDocument();
  });

  it("scopes to one account and hides the per-account breakdown", async () => {
    apiMock.mockResolvedValue({
      total: "10.00",
      count: 1,
      by_day: [{ date: "2026-09-01", commission: "3.00" }],
      by_account: [{ account_id: "DU1", commission: "10.00" }],
    });
    panel("DU1");
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/accounts/DU1/commissions"));
    expect(await screen.findByText("10.00")).toBeInTheDocument();
    expect(screen.queryByText("DU1")).not.toBeInTheDocument();
  });

  it("reports a load failure", async () => {
    apiMock.mockRejectedValue(new Error("nope"));
    panel();
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/);
  });
});
