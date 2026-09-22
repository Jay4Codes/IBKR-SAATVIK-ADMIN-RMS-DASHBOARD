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
  TrendingUp,
  ListChecks,
  LogOut,
  Menu,
  Moon,
  Plug,
  Receipt,
  UserRound,
  Bell,
  Sun,
  Users,
  Wallet,
  Waves,
  X,
} from "lucide-react";
import { api, apiPatch } from "@/lib/api";
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
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "./searchable-select";
import { AlertBell } from "./alert-bell";
import { BalancePanel } from "./balance-panel";
import { PnlCards } from "./pnl-cards";
import { AlertsPanel } from "./alerts-panel";
import { PayoffPanel } from "./payoff-panel";
import { DayPnlPanel } from "./day-pnl";
import { SkewPanel } from "./skew-panel";
import { CommissionsPanel } from "./commissions-panel";
import { PerformancePanel } from "./performance";
import { TimezonePicker, useZone } from "./timezone";
import { formatClock } from "@/lib/timezone";
import { CLOSING_SOON, countdown, marketState } from "@/lib/market";
import { BrandMark } from "./brand";
import { Connections } from "./connections";
import { Members } from "./members";
import { TenantsAdmin } from "./tenants-admin";
import { TenantSwitcher } from "./tenant-switcher";

type View =
  | "Overview"
  | "Accounts"
  | "Positions"
  | "RMS"
  | "Skew"
  | "Orders"
  | "Executions"
  | "Connections"
  | "Members"
  | "Tenants"
  | "Performance"
  | "Profile";

type NavItem = {
  view: View;
  icon: typeof LayoutGrid;
  admin?: boolean;
  platform?: boolean;
};

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Monitor",
    items: [
      { view: "RMS", icon: Activity },
      { view: "Overview", icon: LayoutGrid },
      { view: "Accounts", icon: Wallet },
      { view: "Positions", icon: LineChart },
      { view: "Skew", icon: Waves },
      { view: "Orders", icon: ListChecks },
      { view: "Executions", icon: Receipt },
      { view: "Performance", icon: TrendingUp },
    ],
  },
  {
    group: "Administration",
    items: [
      { view: "Connections", icon: Plug, admin: true },
      { view: "Members", icon: Users, admin: true },
      { view: "Tenants", icon: Building2, platform: true },
    ],
  },

  {
    group: "Account",
    items: [{ view: "Profile", icon: UserRound }],
  },
];

const VIEWS = NAV.flatMap((section) => section.items.map((item) => item.view));

export function visibleNav(isAdmin: boolean, isPlatformAdmin: boolean) {
  return NAV.map((section) => ({
    group: section.group,
    items: section.items.filter(
      (item) => (!item.admin || isAdmin) && (!item.platform || isPlatformAdmin),
    ),
  })).filter((section) => section.items.length > 0);
}

const ACCOUNT_TABS = ["RMS", "Summary", "Positions", "Skew", "Performance", "Orders", "Executions"] as const;

const PROFILE_TABS = ["Account", "Alerts"] as const;

const PROFILE_TAB_ICONS = { Account: UserRound, Alerts: Bell } as const;
type ProfileTab = (typeof PROFILE_TABS)[number];
type AccountTab = (typeof ACCOUNT_TABS)[number];

const TAB_ICONS: Record<AccountTab, typeof LayoutGrid> = {
  Summary: LayoutGrid,
  Positions: LineChart,
  RMS: Activity,
  Skew: Waves,
  Performance: TrendingUp,
  Orders: ListChecks,
  Executions: Receipt,
};

const ADMIN_VIEWS: View[] = ["Connections", "Members", "Tenants"];

const PLATFORM_VIEWS: View[] = [...ADMIN_VIEWS, "Profile"];
export default function Dashboard({
  accountId,
  diagnostics = false,
  initialView = "RMS",
}: {
  accountId?: string;
  diagnostics?: boolean;
  initialView?: string;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            staleTime: Infinity,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
          },
        },
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
    VIEWS.includes(initialView as View) ? (initialView as View) : "RMS",
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
  const view = !isAdmin && ADMIN_VIEWS.includes(requestedView) ? "RMS" : requestedView;
  const showView = (next: View) => {
    setView(next);
    if (typeof window !== "undefined")
      window.history.replaceState(
        window.history.state,
        "",
        next === "RMS" ? "/dashboard" : `/dashboard?view=${encodeURIComponent(next)}`,
      );
  };
  const zone = useZone();
  const [tabs, setTabs] = useState<Record<string, AccountTab>>({});
  const [profileTab, setProfileTab] = useState<ProfileTab>("Account");
  const tab: AccountTab = (accountId && tabs[accountId]) || "RMS";
  const setTab = (next: AccountTab) =>
    accountId && setTabs(previous => ({ ...previous, [accountId]: next }));
  const shows = (name: string) => (accountId ? tab === name : view === name);
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
  const currencies = [
    ...new Set(selected.map((a) => a.currency).filter((c) => c && c !== "BASE")),
  ];
  const ALL = "All accounts";
  const activeCurrency =
    currency === ALL || currencies.includes(currency) ? currency : currencies[0];
  const aggregating = activeCurrency === ALL;
  const monetary = aggregating
    ? selected
    : selected.filter((a) => a.currency === activeCurrency);
  const mixed = aggregating && currencies.length > 1;
  const currencyLabel = aggregating ? (mixed ? "MIXED" : (currencies[0] ?? "")) : activeCurrency;
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
          {clock > 0 && (() => {
            const market = marketState(clock);
            const urgent = market.openNow && market.until <= CLOSING_SOON;
            return (
              <span
                className={`market-clock ${market.openNow ? "open" : "shut"} ${urgent ? "urgent" : ""}`}
                title={`Cboe index options · ${market.label} session · ${
                  market.openNow ? "closes" : "opens"
                } ${market.atLabel} ET`}
              >
                <span className="market-dot" aria-hidden="true" />
                {market.label}
                <b>
                  {market.openNow ? "closes in " : "opens in "}
                  {countdown(market.until)}
                </b>
              </span>
            );
          })()}
          <time>{clock ? formatClock(clock, zone) : "--:--:--"}</time>
          <TimezonePicker />
          <span className="badge">{user.data?.role ?? "SESSION"}</span>
          <AlertBell />
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
      {menuOpen && (
        <button
          type="button"
          className="nav-backdrop"
          aria-label="Close navigation"
          tabIndex={-1}
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside
        id="workspace-nav"
        className={`sidebar ${menuOpen ? "open" : ""}`}
      >
        {visibleNav(isAdmin, isPlatformAdmin).map((section) => {
          const items = section.items;
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
                        router.push(item.view === "RMS" ? "/dashboard" : `/dashboard?view=${item.view}`);
                      } else showView(item.view);
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
                  : view === "Profile"
                    ? "SESSION"
                    : ADMIN_VIEWS.includes(view)
                      ? "ADMINISTRATION"
                      : "MONITOR"}
            </p>
            <h1>{title}</h1>
          </div>
          <div className="heading-actions">
            {activeCurrency && currencies.length > 1 && !PLATFORM_VIEWS.includes(view) && (
              <SearchableSelect
                label="Reporting currency"
                value={activeCurrency}
                options={[ALL, ...currencies]}
                onChange={setCurrency}
              />
            )}
            {!PLATFORM_VIEWS.includes(view) && (
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
            {!PLATFORM_VIEWS.includes(view) && (
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
                    <label>Total net liquidation · {currencyLabel}</label>
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
                    <label>Available funds · {currencyLabel}</label>
                    <strong>{money(sum("available_funds"))}</strong>
                    <small>Broker reported</small>
                  </div>
                  <div>
                    <label>Margin blocked · {currencyLabel}</label>
                    <strong>{money(sum("initial_margin"))}</strong>
                    <small>Initial margin requirement</small>
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
                {mixed && (
                  <p role="note" className="risk-warning">
                    Aggregating {currencies.join(", ")} without FX conversion —
                    these totals add different currencies together and are a
                    count, not a valuation. Pick a single currency for a figure
                    you can bank on.
                  </p>
                )}
                {!accountId && <DayPnlPanel accounts={ids} />}
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

            {!accountId && (view === "Overview" || view === "Accounts") && selected.length === 1 && (
              <BalancePanel
                account={selected[0]}
                canRename={isAdmin}
                onRename={async (label) => {
                  await apiPatch(`/accounts/${selected[0].account_id}`, { label });
                  await client.invalidateQueries({ queryKey: ["accounts"] });
                }}
              />
            )}
            {!accountId && (view === "Overview" || view === "Accounts") && selected.length > 1 && (
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
            {accountId && !!selected.length && (
              <div className="tabs" role="tablist" aria-label="Account sections">
                {ACCOUNT_TABS.map((name) => {
                  const Icon = TAB_ICONS[name];
                  return (
                  <button
                    key={name}
                    type="button"
                    role="tab"
                    id={`tab-${name}`}
                    aria-selected={tab === name}
                    aria-controls="account-panel"
                    className={tab === name ? "active" : ""}
                    onClick={() => setTab(name)}
                  >
                    <Icon size={14} aria-hidden="true" />
                    {name === "RMS" ? "Payoff & risk" : name}
                  </button>
                  );
                })}
              </div>
            )}
            <div
              id="account-panel"
              {...(accountId
                ? { role: "tabpanel", "aria-labelledby": `tab-${tab}`, tabIndex: -1 }
                : {})}
            >
            {shows("Summary") && selected[0] && (
              <section className="panel">
                <h2>Account summary</h2>
                <div className="summary-grid">
                  {(
                    [
                      ["cash", "Cash"],
                      ["buying_power", "Buying power"],
                      ["available_funds", "Available funds"],
                      ["initial_margin", "Margin blocked"],
                      ["maintenance_margin", "Maintenance margin"],
                      ["gross_position_value", "Gross position value"],
                      ["realized_pnl", "Realized P&L"],
                      ["unrealized_pnl", "Unrealized P&L"],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key}>
                      <label>{label}</label>
                      <strong>{money(selected[0][key])}</strong>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {shows("Summary") && accountId && <DayPnlPanel accountId={accountId} accounts={ids} />}
            {shows("Positions") && (
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
            {shows("RMS") && (
              <PayoffPanel
                key={accountId ?? "desk"}
                rows={positions.flatMap((p) => p.data ?? [])}
                accounts={selected}
                accountId={accountId}
                loading={accounts.isPending || positions.some((p) => p.isPending)}
                error={accounts.isError || positions.some((p) => p.isError)}
                light={light}
              />
            )}
            {shows("Skew") && (
              <SkewPanel
                rows={positions.flatMap((p) => p.data ?? [])}
                loading={accounts.isPending || positions.some((p) => p.isPending)}
                error={accounts.isError || positions.some((p) => p.isError)}
              />
            )}

            {shows("Performance") && <PnlCards accountId={accountId} />}
            {shows("Performance") && (
              <PerformancePanel
                key={accountId ?? "desk"}
                accountId={accountId}
                accounts={ids}
                isAdmin={isAdmin || ["OWNER", "ADMIN"].includes(user.data.tenant?.role ?? "")}
              />
            )}
            {shows("Orders") && (
              <section className="panel">
                <h2>Open orders</h2>
                <OrdersTable rows={orders.flatMap((p) => p.data ?? [])} />
              </section>
            )}
            {shows("Executions") && (
              <section className="panel">
                <h2>Recent executions</h2>
                <ExecutionsTable
                  rows={executions.flatMap((p) => p.data ?? [])}
                />
                <p className="footnote">
                  Gross rate is the broker execution price before commission.
                  Commission is reported separately when available.
                </p>
              </section>
            )}
            {shows("Performance") && <CommissionsPanel accountId={accountId} />}
            </div>
            {view === "Profile" && !accountId && (
              <>
                <div className="tabs" role="tablist" aria-label="Profile sections">
                  {PROFILE_TABS.map((name) => (
                    <button
                      key={name}
                      type="button"
                      role="tab"
                      id={`profile-tab-${name}`}
                      aria-selected={profileTab === name}
                      aria-controls="profile-panel"
                      className={profileTab === name ? "active" : ""}
                      onClick={() => setProfileTab(name)}
                    >
                      {(() => {
                        const Icon = PROFILE_TAB_ICONS[name];
                        return <Icon size={14} aria-hidden="true" />;
                      })()}
                      {name}
                    </button>
                  ))}
                </div>
                <div
                  id="profile-panel"
                  role="tabpanel"
                  aria-labelledby={`profile-tab-${profileTab}`}
                  tabIndex={-1}
                >
                {profileTab === "Alerts" && <AlertsPanel />}
                {profileTab === "Account" && <section className="panel">
                  <h2>
                    Signed in as
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
                </section>}
                {profileTab === "Account" && user.data.tenants.length > 1 && (
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
                {profileTab === "Account" && <section className="panel">
                  <h2>Session</h2>
                  <div className="panel-body">
                    <p className="muted">
                      Signing out clears this browser&apos;s session and any cached
                      broker data with it.
                    </p>
                    <div className="panel-actions">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          await api("/auth/logout", {});
                          client.clear();
                          router.replace("/login");
                        }}
                      >
                        <LogOut size={14} aria-hidden="true" /> Sign out
                      </Button>
                    </div>
                  </div>
                </section>}
                {profileTab === "Account" && isAdmin && (
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
                          onClick={() => showView("Connections")}
                        >
                          Broker connections →
                        </button>
                        <button
                          type="button"
                          className="account-link"
                          onClick={() => showView("Members")}
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
                </div>
              </>
            )}
          </>
        )}
        <footer>
          SATTVIC WEALTH · RMS <span>{zone} timestamps · Decimal precision</span>
        </footer>
      </main>
    </div>
  );
}
