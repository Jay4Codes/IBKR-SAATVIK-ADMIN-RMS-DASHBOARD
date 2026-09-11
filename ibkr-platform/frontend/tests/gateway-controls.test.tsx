import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayStatus } from "@/components/gateway-status";
import { Gateway } from "@/lib/types";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

const gateway = (overrides: Partial<Gateway> = {}): Gateway => ({
  status: "FAILED",
  trading_mode: "live",
  host: "127.0.0.1",
  port: 4002,
  client_id: 17,
  process: "active",
  api_port_open: false,
  last_heartbeat: null,
  connected_at: null,
  reconnect_attempts: 4,
  last_error: "Connect call failed",
  ...overrides,
});

describe("gateway controls", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue({});
  });

  it("hides operator controls from non-admins", () => {
    render(<GatewayStatus gateway={gateway()} clock={Date.now()} />);
    expect(screen.queryByText("Reconnect")).toBeNull();
    expect(screen.queryByText("Configure")).toBeNull();
    expect(screen.queryByText("Disconnect")).toBeNull();
  });

  it("shows the current connection target", () => {
    render(<GatewayStatus gateway={gateway()} clock={Date.now()} isAdmin />);
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText(/127\.0\.0\.1:4002/)).toBeTruthy();
    expect(screen.getByText(/client 17/)).toBeTruthy();
  });

  it("offers Reconnect once the API port is open but the worker is not linked", async () => {
    const onChanged = vi.fn();
    render(
      <GatewayStatus
        gateway={gateway({ api_port_open: true, login_phase: "logged_in" })}
        clock={Date.now()}
        isAdmin
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByText("Reconnect"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/gateway/reconnect", {}),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.getByRole("status").textContent).toContain(
      "Reconnect requested",
    );
  });

  it("offers a restart, not a reconnect, when the login is stuck", async () => {
    render(
      <GatewayStatus
        gateway={gateway({ login_phase: "connecting_stale" })}
        clock={Date.now()}
        isAdmin
      />,
    );
    expect(screen.queryByText("Reconnect")).toBeNull();
    fireEvent.click(screen.getByText("Restart gateway"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/gateway/process", {
        action: "restart",
        force: false,
      }),
    );
  });

  it("surfaces a failed command instead of silently succeeding", async () => {
    apiMock.mockRejectedValue(new Error("A command was just issued"));
    render(
      <GatewayStatus
        gateway={gateway({ api_port_open: true, login_phase: "logged_in" })}
        clock={Date.now()}
        isAdmin
      />,
    );
    fireEvent.click(screen.getByText("Reconnect"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "A command was just issued",
      ),
    );
  });

  it("submits an edited connection target from Configure", async () => {
    render(<GatewayStatus gateway={gateway()} clock={Date.now()} isAdmin />);
    fireEvent.click(screen.getByText("Configure"));
    fireEvent.change(screen.getByDisplayValue("127.0.0.1"), {
      target: { value: "gw.internal" },
    });
    const ports = screen.getAllByDisplayValue("4002");
    fireEvent.change(ports[ports.length - 1], { target: { value: "4001" } });
    fireEvent.click(screen.getByText("Save and reconnect"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/gateway/target", {
        host: "gw.internal",
        port: 4001,
        client_id: 17,
      }),
    );
  });

  it("does not call a stale heartbeat online", () => {
    render(
      <GatewayStatus
        gateway={gateway({
          status: "CONNECTED",
          api_port_open: true,
          last_heartbeat: "2026-09-08T12:00:00Z",
        })}
        clock={Date.parse("2026-09-08T12:02:00Z")}
        isAdmin
      />,
    );
    fireEvent.click(screen.getByText("Details"));
    expect(screen.queryByText("Online")).toBeNull();
    expect(screen.getByText(/degraded/)).toBeTruthy();
  });

  it("reports a healthy link as Online with no action to take", () => {
    render(
      <GatewayStatus
        gateway={gateway({
          status: "CONNECTED",
          api_port_open: true,
          login_phase: "logged_in",
          last_error: undefined,
          last_heartbeat: "2026-09-08T12:00:00Z",
        })}
        clock={Date.parse("2026-09-08T12:00:05Z")}
        isAdmin
      />,
    );
    expect(screen.getByText("Online")).toBeTruthy();
    expect(
      (screen.getByText("Connected") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
