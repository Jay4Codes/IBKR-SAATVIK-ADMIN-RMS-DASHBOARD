import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SearchableMultiSelect } from "@/components/searchable-multi-select";
import { useSelection } from "@/components/selection";

function Box({
  options,
  searchFrom,
  describe,
}: {
  options: string[];
  searchFrom?: number;
  describe?: (value: string) => string;
}) {
  const selection = useSelection(options);
  return (
    <SearchableMultiSelect
      label="Accounts"
      noun="accounts"
      selection={selection}
      searchFrom={searchFrom}
      describe={describe}
    />
  );
}

describe("searchable multi-select", () => {
  it("lets the user pick a subset and restore everything", () => {
    render(<Box options={["U1", "U2", "U3"]} />);
    expect(screen.getByText("All 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "U2" }));
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select all accounts" }));
    expect(screen.getByText("All 3")).toBeInTheDocument();
  });

  it("clears the whole set from the unselect-all control", () => {
    render(<Box options={["U1", "U2"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear accounts" }));
    expect(screen.getByText("None")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "U1" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "U2" })).not.toBeChecked();
  });

  it("filters a long option list as you type", () => {
    const many = Array.from({ length: 8 }, (_, i) => `DU${i + 1}`);
    render(<Box options={many} describe={value => value === "DU12" ? "never" : `${value} desk`} />);
    fireEvent.click(screen.getByText("All 8"));
    fireEvent.change(screen.getByLabelText("Filter Accounts"), { target: { value: "DU1" } });
    expect(screen.getByRole("checkbox", { name: "DU1" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "DU2" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter Accounts"), { target: { value: "zzz" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });
});
