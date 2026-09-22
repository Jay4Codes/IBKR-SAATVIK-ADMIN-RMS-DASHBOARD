import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionsTable } from "@/components/tables";
import { TimezonePicker } from "@/components/timezone";
import { STORAGE_KEY } from "@/lib/timezone";
import { Execution } from "@/lib/types";

const fill = {
  execution_id: "x1",
  account_id: "U1",
  symbol: "SPX",
  side: "BOT",
  quantity: "1",
  price: "24.45",
  commission: "1.63",
  exchange: "CBOE",
  order_id: 0,
  executed_at: "2026-09-09T23:30:00Z",
} as unknown as Execution;

function page() {
  return render(
    <>
      <TimezonePicker />
      <ExecutionsTable rows={[fill]} />
    </>,
  );
}

afterEach(() => localStorage.clear());

describe("switching the display timezone", () => {
  it("re-renders every timestamp on the page at the chosen desk's clock", () => {
    page();

    const pick = (zone: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Display timezone" }));
      fireEvent.click(screen.getByRole("option", { name: zone }));
    };
    expect(screen.getByRole("button", { name: "Display timezone" })).toHaveTextContent("ET");
    expect(screen.getByText(/7:30:00.PM/)).toBeInTheDocument();
    pick("IST");
    expect(screen.getByText(/5:00:00.AM/)).toBeInTheDocument();
    expect(screen.queryByText(/7:30:00.PM/)).not.toBeInTheDocument();
    pick("UTC");
    expect(screen.getByText(/11:30:00.PM/)).toBeInTheDocument();
  });
  it("remembers the choice for the next visit", () => {
    const { unmount } = page();
    fireEvent.click(screen.getByRole("button", { name: "Display timezone" }));
    fireEvent.click(screen.getByRole("option", { name: "CT" }));
    expect(localStorage.getItem(STORAGE_KEY)).toBe("CT");
    unmount();
    page();
    expect(screen.getByRole("button", { name: "Display timezone" })).toHaveTextContent("CT");
  });
  it("ignores a stored value that is not one of the four", () => {
    localStorage.setItem(STORAGE_KEY, "Mars/Olympus");
    page();
    expect(screen.getByRole("button", { name: "Display timezone" })).toHaveTextContent("ET");
  });
});
