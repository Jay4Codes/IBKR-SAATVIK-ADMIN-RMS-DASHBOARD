"use client";
import { useState } from "react";
import { Gateway } from "@/lib/types";
import { api } from "@/lib/api";
import { ChevronDown, ChevronUp, Info, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  effectivePhase,
  isAwaitingTwoFactor,
  phaseLabel,
  phaseTone,
  twoFactorRemaining,
} from "@/lib/two-factor";

const LIVE_STATES = new Set(["CONNECTED", "DEGRADED"]);
type Interrupt = "stop" | "restart";

type Action = {
  label: string;
  title: string;
  tone: "go" | "danger" | "idle";
  run?: () => void;
};

export function GatewayStatus({
  gateway,
  clock,
  isAdmin = false,
  canControl = isAdmin,
  onChanged,
}: {
  gateway?: Gateway;
  clock: number;
  isAdmin?: boolean;
  canControl?: boolean;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [confirming, setConfirming] = useState<Interrupt | null>(null);
  // Collapsed by default: the head already carries the state anyone glances at,
  // and the rows below it spell out the login, host and port on a shared screen.
  const [facts, setFacts] = useState(false);

  const remaining = twoFactorRemaining(gateway, clock);
  const awaitingTwoFactor = isAwaitingTwoFactor(gateway, remaining);
  const phase = effectivePhase(gateway, remaining);
  const expired = phase === "two_factor_expired";

  const ago = gateway?.last_heartbeat
    ? Math.max(
        0,
        Math.floor((clock - Date.parse(gateway.last_heartbeat)) / 1000),
      )
    : null;
  const status =
    gateway?.status === "CONNECTED" && (ago === null || ago > 35)
      ? "DEGRADED"
      : (gateway?.status ?? "DISCONNECTED");
  const processRunning = gateway?.process === "active";
  const portOpen = gateway?.api_port_open === true;
  const linked = LIVE_STATES.has(status);

  const fullyOnline = status === "CONNECTED" && (portOpen || !canControl);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setNotice(null);
    setConfirming(null);
    try {
      await action();
      setNotice(done);
      onChanged?.();
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Command failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function process(action: Interrupt | "start", force = false) {
    return run(() => api("/gateway/process", { action, force }), {
      start: "Gateway starting. Approve two-factor on IBKR Mobile.",
      restart: "Gateway restarting. Approve two-factor on IBKR Mobile.",
      stop: "Gateway stopped.",
    }[action]);
  }

  function interrupt(action: Interrupt) {
    if (awaitingTwoFactor) {
      setNotice(null);
      setConfirming(action);
      return;
    }
    void process(action);
  }

  function primary(): Action {
    if (fullyOnline)
      return {
        label: "Connected",
        title: "Gateway is logged in and the worker is streaming",
        tone: "go",
      };
    if (awaitingTwoFactor)
      return {
        label: `Await 2FA · ${remaining}s`,
        title: "Approve the sign-in request in IBKR Mobile",
        tone: "idle",
      };
    if (!processRunning)
      return {
        label: "Start gateway",
        title: "Start IB Gateway and begin the IBKR login",
        tone: "go",
        run: () => void process("start"),
      };
    if (expired || phase === "auth_failed" || phase === "connecting_stale")
      return {
        label: "Restart gateway",
        title: "Restart the login — it timed out, failed, or stalled",
        tone: "danger",
        run: () => interrupt("restart"),
      };
    if (portOpen)
      return {
        label: "Reconnect",
        title: "Reconnect the worker to the gateway API",
        tone: "go",
        run: () => void run(() => api("/gateway/reconnect", {}), "Reconnect requested."),
      };
    return {
      label: "Waiting for gateway…",
      title: "Gateway is logging in — the API port opens when it completes",
      tone: "idle",
    };
  }

  const action = primary();
  const statusText = fullyOnline
    ? "Online"
    : canControl && phase
      ? phaseLabel(phase, remaining)
      : status;
  const tone = fullyOnline
    ? "positive"
    : canControl && phase
      ? phaseTone(phase)
      : linked
        ? "positive"
        : "negative";

  return (
    <div className="gateway">
      <div className="gw-head">
        <span className={`gw-dot ${tone}`} aria-hidden="true" />
        <strong>IB Gateway</strong>
        <span className={`badge ${tone}`}>{statusText}</span>
        <span className="gateway-actions">
          {canControl && (
            <>
            {processRunning && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                title="Stop the gateway process and close its API port"
                onClick={() => interrupt("stop")}
              >
                Disconnect
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              disabled={busy || !action.run}
              title={action.title}
              className={`gw-primary ${action.tone}`}
              onClick={() => action.run?.()}
            >
              {busy ? "Working…" : action.label}
            </Button>
            {isAdmin && <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-expanded={configuring}
              title="IBKR login and connection target"
              onClick={() => {
                setConfiguring(!configuring);
                setNotice(null);
              }}
            >
              <Settings2 size={14} aria-hidden="true" />
              {configuring ? "Close" : "Configure"}
            </Button>}
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={facts}
            aria-controls="gw-facts"
            title="Process, login, port, worker link and heartbeat"
            onClick={() => setFacts(!facts)}
          >
            <Info size={14} aria-hidden="true" />
            {facts ? "Hide details" : "Details"}
            {facts ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
          </Button>
        </span>
      </div>

      {facts && <dl className="gw-facts" id="gw-facts">
        {isAdmin && (
          <div>
            <dt>Gateway process</dt>
            <dd className={processRunning ? "positive" : "negative"}>
              {processRunning ? "running" : "stopped"}
            </dd>
          </div>
        )}
        {isAdmin && (
          <div>
            <dt>Login / mode</dt>
            <dd>
              {gateway?.gateway_username ?? "not configured"} ·{" "}
              {gateway?.trading_mode ?? "—"}
            </dd>
          </div>
        )}
        <div>
          <dt>API port</dt>
          <dd>
            {gateway?.host ?? "—"}:{gateway?.port ?? "—"}
            {isAdmin && (
              <span className={portOpen ? "positive" : "negative"}>
                {" "}
                ({portOpen ? "open" : "closed"})
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Worker link</dt>
          <dd className={linked ? "positive" : "negative"}>
            {status.toLowerCase()}
            <span className="muted"> · client {gateway?.client_id ?? "—"}</span>
          </dd>
        </div>
        <div>
          <dt>Heartbeat</dt>
          <dd>
            {ago === null ? "—" : `${ago}s ago`}
            <span className="muted">
              {" "}
              · {gateway?.reconnect_attempts ?? 0} reconnects
            </span>
          </dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>
            {gateway?.connected_at
              ? `${Math.max(0, Math.floor((clock - Date.parse(gateway.connected_at)) / 60000))}m`
              : "—"}
          </dd>
        </div>
      </dl>}

      {canControl && awaitingTwoFactor && (
        <div className="two-factor" role="alert">
          <div className="two-factor-head">
            <strong>Approve the sign-in request in IBKR Mobile</strong>
            <span className="two-factor-clock">{remaining}s</span>
          </div>
          <div
            className="two-factor-bar"
            role="progressbar"
            aria-label="Time left to approve the two-factor request"
            aria-valuenow={remaining ?? 0}
            aria-valuemin={0}
            aria-valuemax={gateway?.two_factor_timeout_seconds ?? 0}
          >
            <span
              style={{
                width: `${Math.min(100, (((gateway?.two_factor_timeout_seconds ?? 0) - (remaining ?? 0)) / (gateway?.two_factor_timeout_seconds || 1)) * 100)}%`,
              }}
            />
          </div>
          <p className="muted">
            The API port opens on its own once you approve — nothing further is
            needed here.
            {(gateway?.two_factor_attempts ?? 0) > 1 &&
              ` Attempt ${gateway?.two_factor_attempts} this session: the Gateway is retrying the login.`}
          </p>
        </div>
      )}

      {canControl && expired && (

        <p className="negative">
          Two-factor request timed out — restart the Gateway, then approve the
          push promptly.
        </p>
      )}
      {canControl && !awaitingTwoFactor && !expired && gateway?.login_message && (
        <p className="muted">{gateway.login_message}</p>
      )}
      {gateway?.last_error && <p className="negative">{gateway.last_error}</p>}
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}

      {canControl && confirming && (
        <div className="two-factor expired" role="alert">
          <div className="two-factor-head">
            <strong>
              Cancel the pending two-factor request to {confirming} the Gateway?
            </strong>
          </div>
          <p className="muted">
            A sign-in request is still open with {remaining}s left. Continuing
            cancels it, and the next login sends a new push.
          </p>
          <span className="gateway-actions">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => process(confirming, true)}
            >
              Cancel it and {confirming}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setConfirming(null)}
            >
              Keep waiting
            </Button>
          </span>
        </div>
      )}

      {isAdmin && configuring && (
        <div className="gw-config">
          <form
            className="gateway-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              run(
                () =>
                  api("/gateway/credentials", {
                    username: String(data.get("username") ?? "").trim(),
                    password: String(data.get("password") ?? ""),
                    mode: String(data.get("mode") ?? "live"),
                    port: Number(data.get("gwport")),
                  }),
                "IBKR login saved. Restart the Gateway to apply it.",
              ).then((okResult) => {
                if (okResult) {
                  form.reset();
                  setConfiguring(false);
                }
              });
            }}
          >
            <label>
              IBKR username
              <input
                name="username"
                required
                autoComplete="off"
                defaultValue={gateway?.gateway_username ?? ""}
              />
            </label>
            <label>
              IBKR password
              <input
                name="password"
                type="password"
                required
                autoComplete="new-password"
              />
            </label>
            <label>
              Trading mode
              <select name="mode" defaultValue={gateway?.trading_mode ?? ""}>
                <option value="live">live</option>
                <option value="paper">paper</option>
              </select>
            </label>
            <label>
              Gateway API port
              <input
                name="gwport"
                type="number"
                required
                min={1}
                max={65535}
                defaultValue={gateway?.port ?? ""}
              />
            </label>
            <Button type="submit" size="sm" disabled={busy}>
              Save login
            </Button>
            <p className="muted form-note">
              Written only to the Gateway config on the server. Never stored in
              the database and never readable back through this dashboard.
            </p>
          </form>

          <form
            className="gateway-form"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              run(
                () =>
                  api("/gateway/target", {
                    host: String(data.get("host") ?? "").trim(),
                    port: Number(data.get("port")),
                    client_id: Number(data.get("client_id")),
                  }),
                "Target saved. Reconnecting…",
              ).then((okResult) => okResult && setConfiguring(false));
            }}
          >
            <label>
              Host
              <input name="host" required defaultValue={gateway?.host ?? ""} />
            </label>
            <label>
              Port
              <input
                name="port"
                type="number"
                required
                min={1}
                max={65535}
                defaultValue={gateway?.port ?? ""}
              />
            </label>
            <label>
              Client ID
              <input
                name="client_id"
                type="number"
                required
                min={1}
                defaultValue={gateway?.client_id ?? ""}
              />
            </label>
            <Button type="submit" size="sm" disabled={busy}>
              Save and reconnect
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
