import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayStatus } from "@/components/gateway-status";
import { Gateway } from "@/lib/types";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

const NOW = Date.parse("2026-09-09T10:00:00Z");

const gateway = (overrides: Partial<Gateway> = {}): Gateway => ({
  status: "DISCONNECTED",
  trading_mode: "live",
  host: "127.0.0.1",
  port: 4001,
  client_id: 17,
  process: "active",
  gateway_username: "apibot",
  api_port_open: false,
  last_heartbeat: null,
  connected_at: null,
  reconnect_attempts: 0,
  ...overrides,
});

const pending = (secondsAgo: number, extra: Partial<Gateway> = {}) =>
  gateway({
    login_phase: "two_factor",
    login_message: "Approve the sign-in request in IBKR Mobile",
    two_factor_started_at: new Date(NOW - secondsAgo * 1000).toISOString(),
    two_factor_timeout_seconds: 180,
    two_factor_remaining_seconds: 180 - secondsAgo,
    two_factor_attempts: 1,
    ...extra,
  });

describe("two-factor login progress", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue({});
  });

  it("hides login progress from non-admins", () => {
    render(<GatewayStatus gateway={pending(40)} clock={NOW} />);
    expect(screen.queryByText(/Approve the sign-in request/)).toBeNull();
    expect(screen.queryByText(/Two-factor/)).toBeNull();
  });

  it("tells the admin to approve the push and shows the time left", () => {
    render(<GatewayStatus gateway={pending(40)} clock={NOW} isAdmin />);
    expect(screen.getByText(/Approve the sign-in request/)).toBeTruthy();
    expect(screen.getByText("140s")).toBeTruthy();
    expect(screen.getByText(/Two-factor · 140s/)).toBeTruthy();
  });

  it("counts down with the dashboard clock, not the 15s poll", () => {
    const push = pending(40);
    const { rerender } = render(
      <GatewayStatus gateway={push} clock={NOW} isAdmin />,
    );
    expect(screen.getByText("140s")).toBeTruthy();

    rerender(<GatewayStatus gateway={push} clock={NOW + 5000} isAdmin />);
    expect(screen.getByText("135s")).toBeTruthy();
  });

  it("uses the server's count until the dashboard clock starts", () => {
    render(<GatewayStatus gateway={pending(40)} clock={0} isAdmin />);
    expect(screen.getByText(/Two-factor · 140s/)).toBeTruthy();
  });

  it("counts down from the server instant, not the browser's clock offset", () => {

    const offset = pending(40, {
      two_factor_started_at: "2026-09-09T15:29:20+05:30",
    });
    render(<GatewayStatus gateway={offset} clock={NOW} isAdmin />);
    expect(screen.getByText("140s")).toBeTruthy();
  });

  it("falls back to the server's count when the start instant is unusable", () => {
    const broken = pending(40, { two_factor_started_at: "not-a-timestamp" });
    render(<GatewayStatus gateway={broken} clock={NOW} isAdmin />);
    expect(screen.getByText(/Two-factor · 140s/)).toBeTruthy();
  });

  it("reports a retrying login so a loop is visible", () => {
    render(
      <GatewayStatus
        gateway={pending(40, { two_factor_attempts: 3 })}
        clock={NOW}
        isAdmin
      />,
    );
    expect(screen.getByText(/Attempt 3 this session/)).toBeTruthy();
  });

  it("exposes the countdown as a progress bar for assistive tech", () => {
    render(<GatewayStatus gateway={pending(40)} clock={NOW} isAdmin />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("140");
    expect(bar.getAttribute("aria-valuemax")).toBe("180");
  });

  it("disables the primary action while a push is outstanding", () => {
    render(<GatewayStatus gateway={pending(40)} clock={NOW} isAdmin />);

    const button = screen.getByText(/Await 2FA/) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByText("Restart gateway")).toBeNull();
    expect(screen.queryByText("Reconnect")).toBeNull();
  });

  it("asks before disconnecting out from under an outstanding push", async () => {
    render(<GatewayStatus gateway={pending(40)} clock={NOW} isAdmin />);
    fireEvent.click(screen.getByText("Disconnect"));
    expect(apiMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Cancel the pending two-factor request/)).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel it and stop"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/gateway/process", {
        action: "stop",
        force: true,
      }),
    );
  });

  it("lets the operator keep waiting instead of cancelling the push", () => {
    render(<GatewayStatus gateway={pending(40)} clock={NOW} isAdmin />);
    fireEvent.click(screen.getByText("Disconnect"));
    fireEvent.click(screen.getByText("Keep waiting"));
    expect(apiMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Cancel the pending two-factor request/)).toBeNull();
  });

  it("disconnects without a prompt once no push is outstanding", async () => {
    render(
      <GatewayStatus
        gateway={gateway({ process: "active", login_phase: "connecting" })}
        clock={NOW}
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

  it("offers the restart that recovers an expired request", async () => {
    render(
      <GatewayStatus
        gateway={gateway({
          process: "active",
          login_phase: "two_factor_expired",
          login_message: "Two-factor request timed out — restart the Gateway",
          two_factor_remaining_seconds: 0,
        })}
        clock={NOW}
        isAdmin
      />,
    );
    expect(screen.getByText(/Two-factor expired/)).toBeTruthy();

    fireEvent.click(screen.getByText("Restart gateway"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/gateway/process", {
        action: "restart",
        force: false,
      }),
    );
  });

  it("surfaces the API's refusal when the guard is bypassed elsewhere", async () => {
    apiMock.mockRejectedValue(
      new Error("A two-factor request is still open with 140s left."),
    );
    render(
      <GatewayStatus
        gateway={gateway({ process: "active", login_phase: "connecting_stale" })}
        clock={NOW}
        isAdmin
      />,
    );
    fireEvent.click(screen.getByText("Restart gateway"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "A two-factor request is still open",
      ),
    );
  });

  it("expires the banner locally rather than waiting for the next poll", () => {
    const push = pending(179);
    const { rerender } = render(
      <GatewayStatus gateway={push} clock={NOW} isAdmin />,
    );
    expect(screen.getByText("1s")).toBeTruthy();
    rerender(<GatewayStatus gateway={push} clock={NOW + 2000} isAdmin />);

    expect(screen.getByText(/Two-factor request timed out/)).toBeTruthy();
    expect(screen.queryByText(/Approve the sign-in request/)).toBeNull();
    expect(screen.getByText(/Two-factor expired/)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("stops guarding once the countdown has run out", async () => {
    render(<GatewayStatus gateway={pending(179)} clock={NOW + 2000} isAdmin />);
    fireEvent.click(screen.getByText("Restart gateway"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/gateway/process", {
        action: "restart",
        force: false,
      }),
    );
  });

  it("shows a stuck login without a countdown", () => {
    render(
      <GatewayStatus
        gateway={gateway({
          login_phase: "connecting_stale",
          login_message: "Stuck connecting to IBKR for 200s",
        })}
        clock={NOW}
        isAdmin
      />,
    );
    expect(screen.getByText(/Stuck connecting to IBKR for 200s/)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("says nothing extra once the Gateway is logged in", () => {
    render(
      <GatewayStatus
        gateway={gateway({
          login_phase: "logged_in",
          login_message: null,
          api_port_open: true,
        })}
        clock={NOW}
        isAdmin
      />,
    );
    expect(screen.getByText("Logged in")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/Approve the sign-in/)).toBeNull();
  });

});
