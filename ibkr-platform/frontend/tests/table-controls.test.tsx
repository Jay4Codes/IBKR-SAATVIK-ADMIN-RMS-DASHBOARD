import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExecutionsTable, netRate, PositionsTable } from "@/components/tables";
import { SearchableSelect } from "@/components/searchable-select";
import { Execution, Position } from "@/lib/types";

function position(fields: Partial<Position> = {}): Position {
  return {
    account_id: "U1", con_id: 1, symbol: "SPX", local_symbol: "", sec_type: "OPT",
    currency: "USD", expiry: "20260918", strike: "7500", right: "P", multiplier: "100",
    quantity: "1", average_cost: "2446.63", market_price: "35.20", market_value: "3520.00",
    unrealized_pnl: "1073.37", ...fields,
  } as Position;
}

const book = [
  position({ con_id: 1, right: "P", quantity: "1" }),
  position({ con_id: 2, right: "C", quantity: "-2", account_id: "U2" }),
  position({ con_id: 3, sec_type: "STK", right: "", expiry: "", quantity: "10" }),
];

const rowCount = () => within(screen.getByRole("table")).getAllByRole("row").length - 1;

describe("positions filters", () => {
  it("narrows the table by a chosen facet and restores it with All", () => {
    render(<PositionsTable rows={book} />);
    expect(rowCount()).toBe(3);
    fireEvent.click(screen.getByLabelText("Right"));
    fireEvent.click(screen.getByRole("option", { name: "Call" }));
    expect(rowCount()).toBe(1);
    fireEvent.click(screen.getByLabelText("Right"));
    fireEvent.click(screen.getByRole("option", { name: "All" }));
    expect(rowCount()).toBe(3);
  });
  it("combines two facets rather than replacing the first", () => {
    render(<PositionsTable rows={book} />);
    fireEvent.click(screen.getByLabelText("Type"));
    fireEvent.click(screen.getByRole("option", { name: "OPT" }));
    expect(rowCount()).toBe(2);
    fireEvent.click(screen.getByLabelText("Account"));
    fireEvent.click(screen.getByRole("option", { name: "U2" }));
    expect(rowCount()).toBe(1);
  });
  it("offers only the values actually present in the rows", () => {
    render(<PositionsTable rows={book} />);
    fireEvent.click(screen.getByLabelText("Side"));
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["All", "Long", "Short"]);
  });
});

describe("column headings", () => {
  it("advertises sorting on every column, not just the sorted one", () => {
    render(<PositionsTable rows={book} />);
    const headers = screen.getAllByRole("columnheader");
    expect(headers.length).toBeGreaterThan(3);
    for (const header of headers) {
      expect(within(header).getByTitle(/^Sort by /)).toBeTruthy();
    }
    expect(headers.filter((h) => h.getAttribute("aria-sort") !== "none")).toHaveLength(1);
  });
  it("gives every column a grab handle for resizing", () => {
    render(<PositionsTable rows={book} />);
    const grips = screen.getAllByRole("separator");
    expect(grips).toHaveLength(screen.getAllByRole("columnheader").length);
    expect(grips[0]).toHaveAttribute("aria-label", expect.stringMatching(/^Resize /));
  });
  it("widens a column from the keyboard and resets it on double-click", () => {
    render(<PositionsTable rows={book} />);
    const table = screen.getByRole("table");
    const grip = screen.getAllByRole("separator")[0];
    expect(table.className).not.toMatch(/sized/);
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    expect(table.className).toMatch(/sized/);
    const col = table.querySelector("col");
    expect(col?.style.width).toBeTruthy();
    fireEvent.doubleClick(grip);
    expect(table.querySelector("col")?.style.width).toBeFalsy();
  });
});

describe("searchable dropdown", () => {
  const many = Array.from({ length: 12 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
  it("filters a long option list as you type", () => {
    render(<SearchableSelect label="Expiry" value={many[0]} options={many} onChange={() => {}} />);
    fireEvent.click(screen.getByLabelText("Expiry"));
    expect(screen.getAllByRole("option")).toHaveLength(12);
    fireEvent.change(screen.getByLabelText("Filter Expiry"), { target: { value: "-1" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "2026-09-10", "2026-09-11", "2026-09-12",
    ]);
    fireEvent.change(screen.getByLabelText("Filter Expiry"), { target: { value: "zzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matches")).toBeTruthy();
  });
  it("leaves out the filter box when the list is short enough to read", () => {
    render(<SearchableSelect label="Right" value="Call" options={["Call", "Put"]} onChange={() => {}} />);
    fireEvent.click(screen.getByLabelText("Right"));
    expect(screen.queryByLabelText("Filter Right")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });
  it("selects with the keyboard", () => {
    const chosen: string[] = [];
    render(<SearchableSelect label="Right" value="Call" options={["Call", "Put"]} onChange={(v) => chosen.push(v)} />);
    const trigger = screen.getByLabelText("Right");
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(chosen).toEqual(["Put"]);
  });
});

describe("traded rate commissions", () => {
  function execution(fields: Partial<Execution> = {}): Execution {
    return {
      account_id: "U1", execution_id: "e1", symbol: "SPXW  260918P07480000",
      side: "BOT", quantity: "1", price: "11.83", commission: "1.73",
      multiplier: "100", exchange: "CBOE", order_id: 1,
      executed_at: "2026-09-11T19:17:22Z", ...fields,
    };
  }

  it("spreads a whole-fill commission across the units traded", () => {
    expect(Number(netRate(execution()))).toBeCloseTo(11.8473, 4);
    expect(Number(netRate(execution({ side: "SLD" })))).toBeCloseTo(11.8127, 4);
  });

  it("leaves the rate alone when there is nothing to spread", () => {
    expect(netRate(execution({ commission: null }))).toBeNull();
    expect(netRate(execution({ quantity: "0" }))).toBeNull();
  });

  it("shows the gross rate until commissions are asked for", () => {
    render(<ExecutionsTable rows={[execution()]} />);
    expect(screen.getByText("Traded rate (gross)")).toBeInTheDocument();
    expect(screen.getByText("11.83")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Include commissions in traded rate"));
    expect(screen.getByText("Traded rate (net)")).toBeInTheDocument();
    expect(screen.getByText("11.85")).toBeInTheDocument();
  });
});
