export type Money = string | null;
export type Account = {
  account_id: string;
  currency: string;
  net_liquidation: Money;
  cash: Money;
  buying_power: Money;
  available_funds: Money;
  excess_liquidity: Money;
  initial_margin: Money;
  maintenance_margin: Money;
  gross_position_value: Money;
  realized_pnl: Money;
  unrealized_pnl: Money;
  day_pnl: Money;
  updated_at: string;
  open_positions: number;
  open_orders: number;
};
export type Gateway = {
  status: string;
  /** Null until the tenant has registered a broker connection. */
  connection_id?: string | null;
  connection_name?: string;
  provider?: Provider;
  configured?: boolean;
  /** False for a gateway adopted from a pre-tenancy install. */
  managed?: boolean;
  service_unit?: string;
  /** A read-only login skips IBKR's second factor, so no push is coming. */
  read_only_login?: boolean;
  host?: string;
  port?: number;
  client_id?: number;
  process?: string;
  gateway_username?: string | null;
  trading_mode?: string;
  api_port_open?: boolean;

  login_phase?: string;
  login_message?: string | null;
  two_factor_started_at?: string | null;
  two_factor_timeout_seconds?: number | null;
  two_factor_remaining_seconds?: number | null;
  two_factor_attempts?: number;
  connected_at: string | null;
  last_heartbeat: string | null;
  reconnect_attempts: number;
  last_error?: string;
  subscriptions?: Record<string, string>;
};
export type Position = {
  account_id: string;
  con_id: number;
  symbol: string;
  local_symbol: string;
  sec_type: string;
  currency: string;
  expiry: string;
  strike: Money;
  right: string;
  multiplier: Money;
  quantity: string;
  average_cost: string;
  market_price: Money;
  market_value: Money;
  unrealized_pnl: Money;
  underlying_price?: Money;
  /** Which feed produced `underlying_price`: a Massive loader name, or "ib_und_price". */
  underlying_source?: string;
};
export type Order = {
  account_id: string;
  order_id: number;
  perm_id: number;
  client_id: number;
  symbol: string;
  side: string;
  order_type: string;
  quantity: string;
  filled_quantity: string;
  remaining_quantity: string;
  limit_price: Money;
  status: string;
  updated_at: string;
};
export type Execution = {
  account_id: string;
  execution_id: string;
  symbol: string;
  side: string;
  quantity: string;
  price: string;
  commission?: Money;
  realized_pnl?: Money;
  exchange: string;
  order_id: number;
  executed_at: string;
};
export type User = {
  id: string;
  email: string;
  /** Effective role inside the active tenant, collapsed for the dashboard. */
  role: "ADMIN" | "TRADER";
  is_super_admin: boolean;
  accounts: string[];
  tenant: Tenant | null;
  tenants: Tenant[];
  /** True when a super admin is acting inside a tenant they do not belong to. */
  impersonating: boolean;
};
export type LiveEvent = {
  event_id?: string;
  event_type: string;
  account_id: string;
  timestamp: string;
  data: Record<string, unknown>;
};

export type TenantRole = "OWNER" | "ADMIN" | "TRADER" | "VIEWER";

export type Tenant = {
  tenant_id: string;
  slug: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED";
  role: TenantRole;
  accounts: string[];
  /** False when a super admin is listing a tenant they do not belong to. */
  member?: boolean;
};

export type TenantSummary = {
  tenant_id: string;
  slug: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED";
  created_at?: string;
  members: number;
  connections: number;
  accounts: number;
};

export type Member = {
  user_id: string;
  email: string;
  role: TenantRole;
  accounts: string[];
  is_super_admin: boolean;
};

export type Provider = "ibkr_gateway" | "snaptrade";

export type Connection = {
  id: string;
  tenant_id: string;
  name: string;
  provider: Provider;
  status: "DRAFT" | "ENABLED" | "DISABLED";
  /** False for a gateway adopted from a pre-tenancy install; its files are left alone. */
  managed: boolean;
  host: string;
  api_port: number;
  client_id: number;
  trading_mode: string;
  ibkr_username: string | null;
  account_filter: string;
  service_unit: string | null;
  ibc_config_path: string | null;
  snaptrade_user_id: string | null;
  snaptrade_authorized: boolean;
  state?: Gateway;
};

export type SnapTradeAuthorization = {
  id: string;
  brokerage: string | null;
  disabled: boolean;
};

/** One account's net liquidation on one report date. */
export type HistoryPoint = {
  account_id: string;
  report_date: string;
  taken_at: string;
  currency: string;
  net_liquidation: string;
  cash?: string | null;
  realized_pnl?: string | null;
  unrealized_pnl?: string | null;
  /** "snapshot" when this platform recorded it, "flex" when the broker did. */
  source: string;
};

export type HistoryResponse = {
  accounts: string[];
  series: HistoryPoint[];
  combined: { report_date: string; accounts: number; net_liquidation: string; currencies: string[] }[];
};

export type IntradayResponse = {
  date: string;
  accounts: string[];
  series: (HistoryPoint & { day_pnl: string | null })[];
  combined: { taken_at: string; accounts: number; day_pnl: string }[];
};
