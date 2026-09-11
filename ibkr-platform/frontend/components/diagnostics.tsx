"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useZone } from "./timezone";
import { formatDateTime } from "@/lib/timezone";
import { Gateway, LiveEvent } from "@/lib/types";
import { GatewayStatus } from "./gateway-status";

const EVENT_KINDS = [
  { key: "account", label: "Last account event" },
  { key: "position", label: "Last position event" },
  { key: "order", label: "Last order event" },
  { key: "execution", label: "Last execution" },
];

type Diagnostics = {
  gateway: Gateway;
  last_events: Record<string, Record<string, string>>;
  events: LiveEvent[];
  visibility_tests: Record<string, unknown>[];
};
export function Diagnostics({ clock }: { clock: number }) {
  const zone = useZone();
  const query = useQuery({
    queryKey: ["diagnostics"],
    queryFn: () => api<Diagnostics>("/admin/diagnostics"),
    refetchInterval: 3000,
  });
  const [result, setResult] = useState("");
  const [start, setStart] = useState("");
  if (query.error) return <p role="alert">{query.error.message}</p>;
  if (!query.data) return <p>Loading diagnostics…</p>;
  const data = query.data;
  return (
    <>
      <GatewayStatus gateway={data.gateway} clock={clock} />
      <section className="panel">
        <h2>Subscription health</h2>
        <div className="kpis">
          {Object.entries(data.gateway.subscriptions ?? {}).map(
            ([key, value]) => (
              <div key={key}>
                <label>{key}</label>
                <strong
                  className={value === "ACTIVE" ? "positive" : "negative"}
                >
                  {value}
                </strong>
              </div>
            ),
          )}
        </div>
        <div className="table-scroll">
          <table className="responsive-table">
            <thead>
              <tr>
                <th>Account</th>
                {EVENT_KINDS.map((kind) => (
                  <th key={kind.key}>{kind.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.last_events).map(([account, events]) => (
                <tr key={account}>
                  <td data-label="Account">{account}</td>
                  {EVENT_KINDS.map((kind) => (
                    <td key={kind.key} data-label={kind.label}>
                      {events[kind.key] ?? "Not received"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!Object.keys(data.last_events).length && (
            <div className="empty">No accounts reporting events</div>
          )}
        </div>
      </section>
      <section className="panel">
        <h2>External username visibility</h2>
        <p className="muted">
          Begin a test, then create and execute an order from the second
          username in TWS. Enter its broker permanent order ID and execution ID.
          Evidence only covers the identifiers supplied; it does not certify
          every username or order.
        </p>
        <button
          className="control"
          onClick={() => setStart(new Date().toISOString())}
        >
          Begin observation window
        </button>
        <span className="muted"> {start || "Not started"}</span>
        <form
          className="diagnostic-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            try {
              const response = await api("/admin/diagnostics/visibility", {
                account_id: form.get("account"),
                perm_id: Number(form.get("perm")),
                execution_id: form.get("execution") || null,
                expected_working_perm_ids: String(form.get("working") || "")
                  .split(",")
                  .filter(Boolean)
                  .map(Number),
                started_at: start,
              });
              setResult(JSON.stringify(response, null, 2));
              void query.refetch();
            } catch (error) {
              setResult(String(error));
            }
          }}
        >
          <label>
            Account
            <select name="account" required>
              {Object.keys(data.last_events).map((account) => (
                <option key={account}>{account}</option>
              ))}
            </select>
          </label>
          <label>
            External permId
            <input name="perm" type="number" min="1" required />
          </label>
          <label>
            Execution ID
            <input name="execution" />
          </label>
          <label>
            All working permIds (comma separated)
            <input name="working" />
          </label>
          <button
            className="control"
            disabled={!start || !Object.keys(data.last_events).length}
          >
            Check visibility
          </button>
        </form>
        {result && <pre>{result}</pre>}
        <details>
          <summary>
            Previous visibility checks · {data.visibility_tests.length}
          </summary>
          <pre>{JSON.stringify(data.visibility_tests, null, 2)}</pre>
        </details>
      </section>
      <section className="panel">
        <h2>Event log · latest 100</h2>
        <div className="event-log">
          {data.events.map((event) => (
            <details key={event.event_id}>
              <summary>
                <time>{formatDateTime(event.timestamp, zone)}</time> <b>{event.event_type}</b>{" "}
                {event.account_id}
              </summary>
              <pre>{JSON.stringify(event.data, null, 2)}</pre>
            </details>
          ))}
        </div>
      </section>
    </>
  );
}
