import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayStatus } from "@/components/gateway-status";
import { Gateway } from "@/lib/types";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

const gateway = (overrides: Partial<Gateway> = {}): Gateway => ({
  status: "DISCONNECTED",
  trading_mode: "live",
  host: "127.0.0.1",
  port: 4001,
  client_id: 17,
  process: "inactive",
  api_port_open: false,
  gateway_username: "apibot",
  last_heartbeat: null,
  connected_at: null,
  reconnect_attempts: 0,
  ...overrides,
});

describe("gateway process and credentials", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue({});
  });

  it("hides every operator control from non-admins", () => {
    render(<GatewayStatus gateway={gateway()} clock={Date.now()} />);
    for (const label of ["Start gateway", "Disconnect", "Configure"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
    fireEvent.click(screen.getByText("Details"));
    expect(screen.queryByText(/apibot/)).toBeNull();
    expect(screen.queryByText("Gateway process")).toBeNull();
  });

  it("collapses the connection facts until they are asked for", () => {
    render(<GatewayStatus gateway={gateway()} clock={Date.now()} isAdmin />);
    const toggle = screen.getByText("Details");
    for (const row of ["Gateway process", "Login / mode", "API port", "Worker link", "Heartbeat"]) {
      expect(screen.queryByText(row)).toBeNull();
    }
    expect(toggle.closest("button")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByText("API port")).toBeTruthy();
    expect(screen.getByText(/apibot · live/)).toBeTruthy();
    expect(screen.getByText("Hide details").closest("button")).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByText("Hide details"));
    expect(screen.queryByText("API port")).toBeNull();
  });

  it("lets a non-admin reach the facts too, minus the admin-only rows", () => {
    render(<GatewayStatus gateway={gateway()} clock={Date.now()} />);
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText("API port")).toBeTruthy();
    expect(screen.queryByText("Gateway process")).toBeNull();
  });

  it("shows process state and configured login to admins", () => {
    render(<GatewayStatus gateway={gateway()} clock={Date.now()} isAdmin />);
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText("Gateway process")).toBeTruthy();
    expect(screen.getByText("stopped")).toBeTruthy();
    expect(screen.getByText(/apibot · live/)).toBeTruthy();
  });

  it("reports when no IBKR login is configured", () => {
    render(
      <GatewayStatus
        gateway={gateway({ gateway_username: null })}
        clock={Date.now()}
        isAdmin
      />,
    );
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText(/not configured/)).toBeTruthy();
  });

  it("offers exactly one primary action, not a row of them", () => {
    render(<GatewayStatus gateway={gateway()} clock={Date.now()} isAdmin />);

    expect(screen.getByText("Start gateway")).toBeTruthy();
    for (const absent of ["Restart", "Reconnect", "Disconnect", "Stop"]) {
      expect(screen.queryByText(absent)).toBeNull();
    }
  });

  it("sends the start action from the primary button", async () => {
    render(<GatewayStatus gateway={gateway()} clock={Date.now()} isAdmin />);
    fireEvent.click(screen.getByText("Start gateway"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/gateway/process", {
        action: "start",
        force: false,
      }),
    );
  });

  it("offers Disconnect only while the process is running", () => {
    const { rerender } = render(
      <GatewayStatus gateway={gateway()} clock={Date.now()} isAdmin />,
    );
    expect(screen.queryByText("Disconnect")).toBeNull();
    rerender(
      <GatewayStatus
        gateway={gateway({ process: "active", login_phase: "connecting" })}
        clock={Date.now()}
        isAdmin
      />,
    );
    expect(screen.getByText("Disconnect")).toBeTruthy();
  });

  it("stops the gateway from Disconnect", async () => {
    render(
      <GatewayStatus
        gateway={gateway({ process: "active", login_phase: "connecting" })}
        clock={Date.now()}
        isAdmin
      />,
    );
    fireEvent.click(screen.getByText("Disconnect"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/gateway/process", {
        action: "stop",
        force: false,
      }),
    );
  });

  it("keeps both forms behind one Configure toggle", async () => {
    render(<GatewayStatus gateway={gateway()} clock={Date.now()} isAdmin />);
    expect(screen.queryByLabelText(/IBKR password/)).toBeNull();
    fireEvent.click(screen.getByText("Configure"));
    expect(screen.getByLabelText(/IBKR password/)).toBeTruthy();
    expect(screen.getByText("Save and reconnect")).toBeTruthy();
    fireEvent.click(screen.getByText("Close"));
    expect(screen.queryByLabelText(/IBKR password/)).toBeNull();
  });

  it("submits IBKR credentials and clears the password field", async () => {
    render(<GatewayStatus gateway={gateway()} clock={Date.now()} isAdmin />);
    fireEvent.click(screen.getByText("Configure"));
    fireEvent.change(screen.getByLabelText(/IBKR password/), {
      target: { value: "top-secret" },
    });
    fireEvent.click(screen.getByText("Save login"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/gateway/credentials", {
        username: "apibot",
        password: "top-secret",
        mode: "live",
        port: 4001,
      }),
    );

    await waitFor(() => expect(screen.queryByText("Save login")).toBeNull());
  });

  it("masks the password input", () => {
    render(<GatewayStatus gateway={gateway()} clock={Date.now()} isAdmin />);
    fireEvent.click(screen.getByText("Configure"));
    expect(screen.getByLabelText(/IBKR password/).getAttribute("type")).toBe(
      "password",
    );
  });

  it("keeps the form open and reports the error when saving fails", async () => {
    apiMock.mockRejectedValue(new Error("Could not write the configuration"));
    render(<GatewayStatus gateway={gateway()} clock={Date.now()} isAdmin />);
    fireEvent.click(screen.getByText("Configure"));
    fireEvent.change(screen.getByLabelText(/IBKR password/), {
      target: { value: "top-secret" },
    });
    fireEvent.click(screen.getByText("Save login"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Could not write the configuration",
      ),
    );
    expect(screen.getByText("Save login")).toBeTruthy();
  });

  it("surfaces a failed process command", async () => {
    apiMock.mockRejectedValue(new Error("IB Gateway start failed"));
    render(<GatewayStatus gateway={gateway()} clock={Date.now()} isAdmin />);
    fireEvent.click(screen.getByText("Start gateway"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "IB Gateway start failed",
      ),
    );
  });
});

it("lets a tenant gateway operator disconnect without configuration access", async () => {
  apiMock.mockResolvedValue({});
  render(<GatewayStatus gateway={gateway({process: "active", api_port_open: true, status: "CONNECTED", last_heartbeat: new Date().toISOString()})} clock={Date.now()} canControl />);
  expect(screen.queryByText("Configure")).toBeNull();
  fireEvent.click(screen.getByText("Disconnect"));
  await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/gateway/process", {action: "stop", force: false}));
});
