"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Link2,
  Plug,
  Power,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { api, apiDelete } from "@/lib/api";
import { Connection, Provider, SnapTradeAuthorization } from "@/lib/types";
import { Button } from "./ui/button";

const PROVIDERS: { value: Provider; label: string; blurb: string }[] = [
  {
    value: "ibkr_gateway",
    label: "IB Gateway",
    blurb:
      "We provision a dedicated IB Gateway on this host — its own config, its own API port, its own service. You supply the client's IBKR API login.",
  },
  {
    value: "snaptrade",
    label: "SnapTrade",
    blurb:
      "The client authorises their brokerage on SnapTrade's hosted screens. No IBKR password ever reaches this platform, and there is no gateway to run.",
  },
];

const STATUS_TONE: Record<string, string> = {
  ENABLED: "positive",
  DISABLED: "muted",
  DRAFT: "warn",
};

function statusTone(state?: string) {
  if (!state) return "muted";
  if (state === "CONNECTED") return "positive";
  if (["DISCONNECTED", "FAILED"].includes(state)) return "negative";
  return "warn";
}

export function Connections() {
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: () => api<Connection[]>("/connections"),
    refetchInterval: 10000,
  });

  function refresh(message: string) {
    setNotice(message);
    setError(null);
    void client.invalidateQueries({ queryKey: ["connections"] });
    void client.invalidateQueries({ queryKey: ["gateway"] });
  }

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Connection>("/connections", body),
    onSuccess: (created) => {
      setAdding(false);
      refresh(
        created.provider === "ibkr_gateway"
          ? `Provisioned on port ${created.api_port}. Add the IBKR login, then enable it.`
          : "Registered with SnapTrade. Send the client their connection link.",
      );
    },
    onError: (problem: Error) => setError(problem.message),
  });

  if (connections.error)
    return <p role="alert">{connections.error.message}</p>;

  const rows = connections.data ?? [];

  return (
    <>
      <section className="panel">
        <h2>
          Broker connections
          <span>
            {rows.length} registered · one broker session each
          </span>
        </h2>
        <div className="panel-body">
          <p className="muted">
            Each connection is one tenant&rsquo;s link to one broker session. A
            gateway connection runs its own IB Gateway on this host, on its own
            port, under its own service — so two clients never share a login.
          </p>
          <div className="panel-actions">
            <Button
              type="button"
              size="sm"
              variant={adding ? "outline" : "default"}
              onClick={() => {
                setAdding(!adding);
                setError(null);
                setNotice(null);
              }}
              aria-expanded={adding}
            >
              {!adding && <Plug size={14} aria-hidden="true" />}
              {adding ? "Cancel" : "Add connection"}
            </Button>
          </div>
          {notice && (
            <p role="status" className="notice positive">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="notice negative">
              {error}
            </p>
          )}
        </div>
        {adding && (
          <AddConnection
            pending={create.isPending}
            onSubmit={(body) => create.mutate(body)}
          />
        )}
      </section>

      {!rows.length && !connections.isLoading && (
        <section className="panel">
          <div className="empty">
            No broker connection yet. Add one to start monitoring this
            tenant&rsquo;s accounts.
          </div>
        </section>
      )}

      {rows.map((connection) => (
        <ConnectionCard
          key={connection.id}
          connection={connection}
          onChanged={refresh}
          onError={setError}
        />
      ))}
    </>
  );
}

function AddConnection({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [provider, setProvider] = useState<Provider>("ibkr_gateway");
  const chosen = PROVIDERS.find((p) => p.value === provider)!;
  return (
    <form
      className="stacked-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onSubmit({
          name: String(data.get("name") ?? "").trim(),
          provider,
          trading_mode: String(data.get("trading_mode") ?? "paper"),
          account_filter: String(data.get("account_filter") ?? "").trim(),
          read_only_login: data.get("read_only_login") === "on",
          second_factor_device: String(data.get("second_factor_device") ?? "").trim(),
        });
      }}
    >
      <fieldset className="provider-choice">
        <legend>Provider</legend>
        {PROVIDERS.map((option) => (
          <label key={option.value} className={provider === option.value ? "selected" : ""}>
            <input
              type="radio"
              name="provider"
              value={option.value}
              checked={provider === option.value}
              onChange={() => setProvider(option.value)}
            />
            <span>
              <strong>{option.label}</strong>
              <small>{option.blurb}</small>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="field-row">
        <label>
          Connection name
          <input name="name" required maxLength={60} placeholder="Client production" />
        </label>
        {provider === "ibkr_gateway" && (
          <>
            <label>
              Trading mode
              <select name="trading_mode" defaultValue="paper">
                <option value="paper">paper</option>
                <option value="live">live</option>
              </select>
            </label>
            <label>
              Account filter
              <input name="account_filter" placeholder="all accounts" maxLength={32} />
            </label>
            <label>
              Second-factor device
              <input name="second_factor_device" placeholder="IB Key" maxLength={64} />
            </label>
          </>
        )}
      </div>

      {provider === "ibkr_gateway" && (
        <label className="checkbox">
          <input type="checkbox" name="read_only_login" defaultChecked />
          <span>
            Read-only login
            <small>
              Skips IBKR&rsquo;s second factor entirely, so the gateway starts
              unattended. This platform never places orders, so read-only costs
              nothing. Clear it and every start waits on a push notification.
            </small>
          </span>
        </label>
      )}

      <div className="form-footer">
        <Button type="submit" disabled={pending}>
          {pending ? "Provisioning…" : `Create ${chosen.label} connection`}
        </Button>
        <p className="muted">
          {provider === "ibkr_gateway"
            ? "A free API port and client id are allocated automatically. The IBKR password is added separately and is written only to the gateway's config file on this host."
            : "A SnapTrade user is registered for this connection. Its secret is encrypted before it is stored and is never readable through this dashboard."}
        </p>
      </div>
    </form>
  );
}

function ConnectionCard({
  connection,
  onChanged,
  onError,
}: {
  connection: Connection;
  onChanged: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showCredentials, setShowCredentials] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [authorizations, setAuthorizations] = useState<SnapTradeAuthorization[] | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const gateway = connection.provider === "ibkr_gateway";

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await action();
      onChanged(done);
      return true;
    } catch (problem) {
      onError(problem instanceof Error ? problem.message : "Command failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const live = connection.state?.status;

  return (
    <section className="panel">
      <h2>
        <span className="panel-title">
          {gateway ? <Server size={15} aria-hidden="true" /> : <Link2 size={15} aria-hidden="true" />}
          {connection.name}
          <span className={`badge ${STATUS_TONE[connection.status] ?? ""}`}>
            {connection.status}
          </span>
          {connection.status === "ENABLED" && (
            <span className={`badge ${statusTone(live)}`}>{live ?? "—"}</span>
          )}
          {!connection.managed && (
            <span className="badge" title="Adopted from an existing install; its files are left alone">
              ADOPTED
            </span>
          )}
        </span>
      </h2>

      <dl className="facts">
        <div>
          <dt>Provider</dt>
          <dd>{gateway ? "IB Gateway" : "SnapTrade"}</dd>
        </div>
        {gateway ? (
          <>
            <div>
              <dt>API endpoint</dt>
              <dd>
                {connection.host}:{connection.api_port}
                <span className="muted"> · client {connection.client_id}</span>
              </dd>
            </div>
            <div>
              <dt>IBKR login</dt>
              <dd>
                {connection.ibkr_username ?? "not configured"}
                <span className="muted"> · {connection.trading_mode}</span>
              </dd>
            </div>
            <div>
              <dt>Service unit</dt>
              <dd>{connection.service_unit ?? "—"}</dd>
            </div>
            <div>
              <dt>Accounts</dt>
              <dd>{connection.account_filter || "all visible"}</dd>
            </div>
          </>
        ) : (
          <>
            <div>
              <dt>SnapTrade user</dt>
              <dd>{connection.snaptrade_user_id ?? "—"}</dd>
            </div>
            <div>
              <dt>Brokerage linked</dt>
              <dd className={connection.snaptrade_authorized ? "positive" : "warn"}>
                {connection.snaptrade_authorized ? "yes" : "awaiting the client"}
              </dd>
            </div>
          </>
        )}
      </dl>

      <div className="panel-body">
        <div className="panel-actions">
          {connection.status !== "ENABLED" ? (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api(`/connections/${connection.id}`, { status: "ENABLED" }),
                  "Connection enabled. The worker picks it up within ten seconds.",
                )
              }
            >
              <Power size={14} aria-hidden="true" /> Enable
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api(`/connections/${connection.id}`, { status: "DISABLED" }),
                  "Connection disabled. Its broker session stops; nothing is deleted.",
                )
              }
            >
              <Power size={14} aria-hidden="true" /> Disable
            </Button>
          )}

          {gateway && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api(`/connections/${connection.id}/process`, { action: "start" }),
                    "Gateway starting.",
                  )
                }
              >
                Start gateway
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api(`/connections/${connection.id}/reconnect`, {}),
                    "Reconnect requested.",
                  )
                }
              >
                <RefreshCw size={14} aria-hidden="true" /> Reconnect
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={showCredentials}
                onClick={() => setShowCredentials(!showCredentials)}
              >
                {showCredentials ? "Close login" : "IBKR login"}
              </Button>
            </>
          )}

          {!gateway && (
            <>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ url: string }>(
                      `/connections/${connection.id}/snaptrade/link`,
                      {},
                    );
                    setLink(result.url);
                  }, "Connection link generated. It is single use.")
                }
              >
                <ExternalLink size={14} aria-hidden="true" /> Get connection link
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await api<{
                      authorizations: SnapTradeAuthorization[];
                    }>(`/connections/${connection.id}/snaptrade/status`);
                    setAuthorizations(result.authorizations);
                  }, "Authorisations refreshed.")
                }
              >
                Check authorisations
              </Button>
            </>
          )}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="danger-text"
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 size={14} aria-hidden="true" /> Remove
          </Button>
        </div>

        {link && (
          <p className="notice">
            Send this single-use link to the client:{" "}
            <a href={link} target="_blank" rel="noopener noreferrer">
              {link}
            </a>
          </p>
        )}

        {authorizations && (
          <ul className="plain-list">
            {authorizations.length ? (
              authorizations.map((row) => (
                <li key={row.id}>
                  {row.brokerage ?? "Unknown brokerage"}{" "}
                  <span className={row.disabled ? "negative" : "positive"}>
                    {row.disabled ? "disabled" : "active"}
                  </span>
                </li>
              ))
            ) : (
              <li className="muted">
                No brokerage linked yet — the client has not finished the
                connection flow.
              </li>
            )}
          </ul>
        )}

        {connection.state?.last_error && (
          <p className="notice negative">{connection.state.last_error}</p>
        )}

        {confirmingDelete && (
          <div className="confirm" role="alert">
            <strong>Remove &ldquo;{connection.name}&rdquo;?</strong>
            <p className="muted">
              {connection.managed
                ? "Its gateway is stopped and its config, launcher, and settings directory are deleted from this host. Durable order and fill history in MongoDB is kept."
                : "This connection was adopted from an existing install, so its config file and service are left exactly where they are. Only the registration is removed."}
            </p>
            <div className="panel-actions">
              <Button
                type="button"
                size="sm"
                className="gw-primary danger"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => apiDelete(`/connections/${connection.id}`),
                    "Connection removed.",
                  )
                }
              >
                Remove it
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmingDelete(false)}
              >
                Keep it
              </Button>
            </div>
          </div>
        )}
      </div>

      {gateway && showCredentials && (
        <form
          className="stacked-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            void run(
              () =>
                api(`/connections/${connection.id}/credentials`, {
                  username: String(data.get("username") ?? "").trim(),
                  password: String(data.get("password") ?? ""),
                  mode: String(data.get("mode") ?? "paper"),
                  port: Number(data.get("port")),
                }),
              "IBKR login saved. Restart the gateway to apply it.",
            ).then((okResult) => {
              if (okResult) {
                form.reset();
                setShowCredentials(false);
              }
            });
          }}
        >
          <div className="field-row">
            <label>
              IBKR username
              <input
                name="username"
                required
                autoComplete="off"
                defaultValue={connection.ibkr_username ?? ""}
              />
            </label>
            <label>
              IBKR password
              <input name="password" type="password" required autoComplete="new-password" />
            </label>
            <label>
              Trading mode
              <select name="mode" defaultValue={connection.trading_mode}>
                <option value="paper">paper</option>
                <option value="live">live</option>
              </select>
            </label>
            <label>
              API port
              <input
                name="port"
                type="number"
                required
                min={1}
                max={65535}
                defaultValue={connection.api_port}
              />
            </label>
          </div>
          <div className="form-footer">
            <Button type="submit" size="sm" disabled={busy}>
              Save login
            </Button>
            <p className="muted">
              Written only to this connection&rsquo;s gateway config on the
              server, at 0600. Never stored in the database and never readable
              back through this dashboard.
            </p>
          </div>
        </form>
      )}
    </section>
  );
}
