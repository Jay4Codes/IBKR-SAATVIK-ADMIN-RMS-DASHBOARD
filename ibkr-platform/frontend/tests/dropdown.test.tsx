import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dropdown } from "@/components/dropdown";

describe("dropdown", () => {
  const open = () => document.querySelector("details")!.open;

  it("closes when the click lands outside it", () => {
    render(
      <div>
        <Dropdown label="Accounts" value="All 2"><p>menu</p></Dropdown>
        <button type="button">elsewhere</button>
      </div>,
    );
    const details = document.querySelector("details")!;
    details.open = true;
    expect(open()).toBe(true);

    // A native <details> handles the keyboard and Escape but not this.
    fireEvent.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(open()).toBe(false);
  });

  it("stays open while the click is inside it", () => {
    render(<Dropdown label="Accounts" value="All 2"><button type="button">U1</button></Dropdown>);
    const details = document.querySelector("details")!;
    details.open = true;
    fireEvent.click(screen.getByRole("button", { name: "U1" }));
    expect(open()).toBe(true);
  });

  it("shows what is selected without being opened", () => {
    render(<Dropdown label="Accounts" value="1 of 2"><p>menu</p></Dropdown>);
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(open()).toBe(false);
  });
});
