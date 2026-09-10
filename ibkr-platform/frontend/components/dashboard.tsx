"use client";
import {
  QueryClient,
  QueryClientProvider,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Decimal from "decimal.js";
import {
  Activity,
  ArrowUpRight,
  Building2,
  ChevronRight,
  LayoutGrid,
  LineChart,
  ListChecks,
  LogOut,
  Menu,
  Moon,
  Plug,
  Receipt,
  Settings2,
  Sun,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { connectLive } from "@/lib/live";
import {
  Account,
  Execution,
  Gateway,
  Order,
  Position,
  User,
} from "@/lib/types";
import {
  AccountsTable,
  Amount,
  ExecutionsTable,
  money,
  OrdersTable,
  PositionsTable,
} from "./tables";
import { GatewayStatus } from "./gateway-status";
import { Diagnostics } from "./diagnostics";
import { AllocationChart } from "./allocation-chart";
import { PayoffPanel } from "./payoff-panel";
import { BrandMark } from "./brand";
import { Connections } from "./connections";
import { Members } from "./members";
import { TenantsAdmin } from "./tenants-admin";
import { TenantSwitcher } from "./tenant-switcher";

type View =
  | "Overview"
  | "Accounts"
  | "Positions"
  | "Orders"
  | "Executions"
  | "Connections"
  | "Members"
  | "Tenants"
  | "Settings";

type NavItem = {
  view: View;
  icon: typeof LayoutGrid;
  /** Tenant administrators only. */
  admin?: boolean;
  /** Platform administrators only. */
  platform?: boolean;
};

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Monitor",
    items: [
      { view: "Overview", icon: LayoutGrid },
      { view: "Accounts", icon: Wallet },
      { view: "Positions", icon: LineChart },
      { view: "Orders", icon: ListChecks },
      { view: "Executions", icon: Receipt },
    ],
  },
  {
    group: "Administration",
    items: [
      { view: "Connections", icon: Plug, admin: true },
      { view: "Members", icon: Users, admin: true },
      { view: "Tenants", icon: Building2, platform: true },
      { view: "Settings", icon: Settings2 },
    ],
  },
];

const VIEWS = NAV.flatMap((section) => section.items.map((item) => item.view));

/** Views that manage the platform rather than watch a broker session. */
const ADMIN_VIEWS: View[] = ["Connections", "Members", "Tenants", "Settings"];
export default function Dashboard({
  accountId,
  diagnostics = false,
  initialView = "Overview",
}: {
  accountId?: string;
  diagnostics?: boolean;
  initialView?: string;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchInterval: 15000 } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <Terminal
        accountId={accountId}
        diagnostics={diagnostics}
        initialView={initialView}
      />
    </QueryClientProvider>
  );
}
function Terminal({
  accountId,
  diagnostics,
  initialView,
}: {
  accountId?: string;
  diagnostics: boolean;
  initialView: string;
}) {
  const router = useRouter(),
    client = useQueryClient();
  const [requestedView, setView] = useState<View>(
    VIEWS.includes(initialView as View) ? (initialView as View) : "Overview",
  );
  const [clock, setClock] = useState(0),
    [connected, setConnected] = useState(false),
    [light, setLight] = useState(false),
    [menuOpen, setMenuOpen] = useState(false);
  const [currency, setCurrency] = useState("");
  const user = useQuery({
    queryKey: ["me"],
    queryFn: () => api<User>("/auth/me"),
  });
  const gateway = useQuery({
    queryKey: ["gateway"],
    queryFn: () => api<Gateway>("/gateway"),
    enabled: !!user.data,
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/accounts"),
    enabled: !!user.data,
  });
  const selected =
    accounts.data?.filter((a) => !accountId || a.account_id === accountId) ??
    [];
  const ids = selected.map((a) => a.account_id);
  const positions = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["positions", id],
      queryFn: () => api<Position[]>(`/accounts/${id}/positions`),
    })),
  });
  const orders = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["orders", id],
      queryFn: () => api<Order[]>(`/accounts/${id}/orders`),
    })),
  });
  const executions = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["executions", id],
      queryFn: () => api<Execution[]>(`/accounts/${id}/executions`),
    })),
  });
  const isAdmin = !!user.data?.is_super_admin;
  const view = !isAdmin && ADMIN_VIEWS.includes(requestedView) ? "Overview" : requestedView;
  const isPlatformAdmin = !!user.data?.is_super_admin;
  const allowed = isAdmin ? "*" : (accounts.data?.map((account) => account.account_id).join(",") ?? "");
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!allowed) return;
    return connectLive(client, allowed.split(","), setConnected);
  }, [allowed, client]);
  const currencies = [...new Set(selected.map((a) => a.currency))];
  const activeCurrency = currencies.includes(currency)
    ? currency
    : currencies[0];
  const monetary = selected.filter((a) => a.currency === activeCurrency);
  const sum = (field: keyof Account) =>
    monetary.length && monetary.every((a) => a[field] != null)
      ? monetary
          .reduce((n, a) => n.plus(String(a[field])), new Decimal(0))
          .toString()
      : null;
  const cushions = monetary
    .filter(
      (a) =>
        a.net_liquidation &&
        a.excess_liquidity &&
        new Decimal(a.net_liquidation).gt(0),
    )
    .map((a) =>
      new Decimal(a.excess_liquidity!).div(a.net_liquidation!).mul(100),
    );
  const errors = [
    user.error,
    gateway.error,
    accounts.error,
    ...positions.map((p) => p.error),
    ...orders.map((p) => p.error),
    ...executions.map((p) => p.error),
  ].filter(Boolean);
  const title = diagnostics ? "IBKR diagnostics" : (accountId ?? view);
  return (
    <div className={`terminal ${light ? "light" : ""}`}>
      <header className="topbar">
        <button
          type="button"
          className="nav-toggle"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={menuOpen}
          aria-controls="workspace-nav"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
        <Link href="/dashboard" className="brand" aria-label="Sattvic RMS">
          <BrandMark priority />
        </Link>
        <div className="top-right">
          <TenantSwitcher user={user.data} />
          <span
            className={`live-dot ${connected ? "positive" : "negative"}`}
            title={
              connected
                ? "Streaming live broker events"
                : "Reconnecting; REST snapshots still refresh"
            }
          >
            ● {connected ? "LIVE" : "OFFLINE"}
          </span>
          <time>
            {clock ? new Date(clock).toISOString().slice(11, 19) : "--:--:--"}{" "}
            UTC
          </time>
          <span className="badge">{user.data?.role ?? "SESSION"}</span>
          <button
            type="button"
            aria-label={light ? "Switch to dark theme" : "Switch to light theme"}
            title={light ? "Dark theme" : "Light theme"}
            onClick={() => setLight(!light)}
          >
            {light ? <Moon size={16} /> : <Sun size={16} />}
          </button>
          <button
            type="button"
            aria-label="Sign out"
            title={user.data?.email}
            onClick={async () => {
              await api("/auth/logout", {});
              client.clear();
              router.replace("/login");
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>
      <aside
        id="workspace-nav"
        className={`sidebar ${menuOpen ? "open" : ""}`}
      >
        {NAV.map((section) => {
          if (section.group !== "Monitor" && !isAdmin) return null;
          const items = section.items.filter(
            (item) =>
              (!item.admin || isAdmin) && (!item.platform || isPlatformAdmin),
          );
          if (!items.length) return null;
          return (
            <div className="nav-group" key={section.group}>
              <p>{section.group}</p>
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    type="button"
                    className={
                      !diagnostics && !accountId && view === item.view
                        ? "active"
                        : ""
                    }
                    key={item.view}
                    aria-current={
                      !diagnostics && !accountId && view === item.view
                        ? "page"
                        : undefined
                    }
                    onClick={() => {
                      setMenuOpen(false);
                      if (accountId || diagnostics) {
                        router.push(`/dashboard?view=${item.view}`);
                      } else setView(item.view);
                    }}
                  >
                    <Icon size={15} aria-hidden="true" />
                    <span className="nav-label">{item.view}</span>
                    <ChevronRight size={13} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          );
        })}
        {isAdmin && (
          <div className="nav-group">
            <p>Internal</p>
            <Link
              href="/admin/ibkr-diagnostics"
              className={diagnostics ? "active" : ""}
              onClick={() => setMenuOpen(false)}
            >
              <Activity size={15} aria-hidden="true" />
              <span className="nav-label">Diagnostics</span>
              <ChevronRight size={13} aria-hidden="true" />
            </Link>
          </div>
        )}
      </aside>
      <main className="workspace">
        {!connected && (
          <div role="alert" className="disconnect">
            LIVE DATA DISCONNECTED{" "}
            <span>
              Reconnecting automatically · REST snapshots refresh every 15s
            </span>
          </div>
        )}
        <div className="page-heading">
          <div className="page-heading-text">
            <p>
              {user.data?.tenant?.name ?? "OPERATIONS"} /{" "}
              {accountId
                ? "ACCOUNT"
                : diagnostics
                  ? "INTERNAL"
                  : ADMIN_VIEWS.includes(view)
                    ? "ADMINISTRATION"
                    : "MONITOR"}
            </p>
            <h1>{title}</h1>
          </div>
          <div className="heading-actions">
            {activeCurrency && !ADMIN_VIEWS.includes(view) && (
              <select
                aria-label="Reporting currency"
                value={activeCurrency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {currencies.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            )}
            {!ADMIN_VIEWS.includes(view) && (
              <span className="badge">
                {selected.length} {selected.length === 1 ? "ACCOUNT" : "ACCOUNTS"}
              </span>
            )}
          </div>
        </div>
        {!!errors.length && (
          <div role="alert" className="disconnect">
            {errors[0]?.message}
          </div>
        )}
        {!user.data && !errors.length && <p>Loading session…</p>}
        {user.data &&
          diagnostics &&
          (isAdmin ? (
            <Diagnostics clock={clock} />
          ) : (
            <p role="alert">Administrator access required.</p>
          ))}
        {user.data && !diagnostics && (
          <>
            {!ADMIN_VIEWS.includes(view) && (
              <GatewayStatus
                gateway={gateway.data}
                clock={clock}
                isAdmin={isAdmin}
                canControl={isAdmin || ["OWNER", "ADMIN"].includes(user.data.tenant?.role ?? "")}
                onChanged={() => gateway.refetch()}
              />
            )}
            {view === "Connections" && !accountId && (
              isAdmin ? (
                <Connections />
              ) : (
                <p role="alert">Tenant administrator access required.</p>
              )
            )}
            {view === "Members" && !accountId && (
              isAdmin ? (
                <Members user={user.data} />
              ) : (
                <p role="alert">Tenant administrator access required.</p>
              )
            )}
            {view === "Tenants" && !accountId && (
              isPlatformAdmin ? (
                <TenantsAdmin />
              ) : (
                <p role="alert">Platform administrator access required.</p>
              )
            )}
            {(view === "Overview" || !!accountId) && (
              <>
                <div className="kpis">
                  <div>
                    <label>Total net liquidation · {activeCurrency}</label>
                    <strong>{money(sum("net_liquidation"))}</strong>
                    <small>Accessible accounts, selected currency</small>
                  </div>
                  <div>
                    <label>Day P&L</label>
                    <strong>
                      <Amount value={sum("day_pnl")} />
                    </strong>
                    <small>Broker daily P&L</small>
                  </div>
                  <div>
                    <label>Open positions</label>
                    <strong>
                      {selected.reduce((n, a) => n + a.open_positions, 0)}
                    </strong>
                    <small>Across accessible accounts</small>
                  </div>
                  <div>
                    <label>Open orders</label>
                    <strong>
                      {selected.reduce((n, a) => n + a.open_orders, 0)}
                    </strong>
                    <small>Visible to API session</small>
                  </div>
                  <div>
                    <label>Available funds · {activeCurrency}</label>
                    <strong>{money(sum("available_funds"))}</strong>
                    <small>Broker reported</small>
                  </div>
                  <div>
                    <label>Lowest margin cushion</label>
                    <strong>
                      {cushions.length === monetary.length && cushions.length
                        ? `${Decimal.min(...cushions).toFixed(2)}%`
                        : "—"}
                    </strong>
                    <small>Excess liquidity / net liquidation</small>
                  </div>
                </div>
                {!accountId && (
                  <section className="panel">
                    <h2>
                      Capital allocation{" "}
                      <span>{activeCurrency} · current snapshot</span>
                    </h2>
                    <AllocationChart accounts={monetary} light={light} />
                  </section>
                )}
              </>
            )}
            {!accountId && (view === "Overview" || view === "Accounts") && (
              <section className="panel">
                <h2>
                  Accounts <ArrowUpRight size={16} />
                </h2>
                <AccountsTable
                  rows={selected}
                  onRow={(a) => router.push(`/accounts/${a.account_id}`)}
                />
              </section>
            )}
            {accountId && !selected.length && !accounts.isLoading && (
              <p role="alert">Account unavailable or access denied.</p>
            )}
            {accountId && selected[0] && (
              <section className="panel">
                <h2>Account summary</h2>
                <div className="summary-grid">
                  {(
                    [
                      "cash",
                      "buying_power",
                      "initial_margin",
                      "maintenance_margin",
                      "gross_position_value",
                      "realized_pnl",
                      "unrealized_pnl",
                    ] as const
                  ).map((key) => (
                    <div key={key}>
                      <label>{key.replaceAll("_", " ")}</label>
                      <strong>{money(selected[0][key])}</strong>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {(accountId || view === "Positions") && (
              <section className="panel">
                <h2>Positions</h2>
                <PositionsTable rows={positions.flatMap((p) => p.data ?? [])} />
                <p className="footnote">
                  ¹ Average cost is the broker value; derivative costs include
                  the contract multiplier. Missing marks indicate unavailable
                  broker valuation.
                </p>
              </section>
            )}
            {(accountId || view === "Overview" || view === "Positions") && (
              <PayoffPanel
                key={accountId ?? "desk"}
                rows={positions.flatMap((p) => p.data ?? [])}
                accountId={accountId}
                loading={accounts.isPending || positions.some((p) => p.isPending)}
                error={accounts.isError || positions.some((p) => p.isError)}
                light={light}
              />
            )}
            {(accountId || view === "Orders") && (
              <section className="panel">
                <h2>Open orders</h2>
                <OrdersTable rows={orders.flatMap((p) => p.data ?? [])} />
              </section>
            )}
            {(accountId || view === "Executions") && (
              <section className="panel">
                <h2>Recent executions</h2>
                <ExecutionsTable
                  rows={executions.flatMap((p) => p.data ?? [])}
                />
              </section>
            )}
            {view === "Settings" && !accountId && (
              <>
                <section className="panel">
                  <h2>
                    Session
                    <span>{user.data.email}</span>
                  </h2>
                  <div className="summary-grid">
                    <div>
                      <label>Organisation</label>
                      <strong>{user.data.tenant?.name ?? "—"}</strong>
                      <small>{user.data.tenant?.slug ?? "no tenant"}</small>
                    </div>
                    <div>
                      <label>Role</label>
                      <strong>{user.data.tenant?.role ?? user.data.role}</strong>
                      <small>
                        {user.data.is_super_admin
                          ? "Platform administrator"
                          : "Within this organisation"}
                      </small>
                    </div>
                    <div>
                      <label>Accessible accounts</label>
                      <strong>
                        {isAdmin ? selected.length : user.data.accounts.length}
                      </strong>
                      <small>
                        {isAdmin ? "All in this organisation" : "Explicitly granted"}
                      </small>
                    </div>
                    <div>
                      <label>Live stream</label>
                      <strong className={connected ? "positive" : "negative"}>
                        {connected ? "CONNECTED" : "OFFLINE"}
                      </strong>
                      <small>Per-organisation event stream</small>
                    </div>
                  </div>
                </section>
                {user.data.tenants.length > 1 && (
                  <section className="panel">
                    <h2>
                      Your organisations
                      <span>{user.data.tenants.length} with access</span>
                    </h2>
                    <div className="summary-grid">
                      {user.data.tenants.map((tenant) => (
                        <div key={tenant.tenant_id}>
                          <label>{tenant.slug}</label>
                          <strong>{tenant.name}</strong>
                          <small>{tenant.role.toLowerCase()}</small>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                {isAdmin && (
                  <section className="panel">
                    <h2>Administration</h2>
                    <div className="panel-body">
                      <p className="muted">
                        Broker connections, members, and diagnostics for{" "}
                        {user.data.tenant?.name ?? "this organisation"}.
                      </p>
                      <div className="panel-actions">
                        <button
                          type="button"
                          className="account-link"
                          onClick={() => setView("Connections")}
                        >
                          Broker connections →
                        </button>
                        <button
                          type="button"
                          className="account-link"
                          onClick={() => setView("Members")}
                        >
                          Members →
                        </button>
                        <Link href="/admin/ibkr-diagnostics" className="account-link">
                          IBKR diagnostics →
                        </Link>
                      </div>
                    </div>
                  </section>
                )}
              </>
            )}
          </>
        )}
        <footer>
          SATTVIC WEALTH · RMS <span>UTC timestamps · Decimal precision</span>
        </footer>
      </main>
    </div>
  );
}
