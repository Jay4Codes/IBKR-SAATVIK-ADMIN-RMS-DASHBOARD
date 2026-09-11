from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    mongodb_uri: str = "mongodb://localhost:27017"
    mongodb_database: str = "ibkr_phase1"
    redis_url: str = "redis://localhost:6379/0"

    # Defaults for the bootstrap tenant's adopted connection. Per-connection
    # values in `broker_connections` take precedence everywhere; these only seed
    # the migration that adopts a pre-tenancy single-gateway installation.
    ibkr_host: str = "127.0.0.1"
    ibkr_port: int = 4001
    ibkr_client_id: int = 17
    ibkr_account: str = ""
    ibc_config_path: str = "/opt/ibc/config.ini"
    gateway_service: str = "ibkr-gateway.service"
    ibc_log_directory: str = "/opt/ibc/logs"
    gateway_launcher_log: str = ""

    connection_timeout: float = 15
    heartbeat_seconds: float = 10
    cors_origins: str = "http://localhost:3000,https://sattvic-rms.ekalonsolutions.com"
    cookie_secure: bool = False
    session_seconds: int = 28800

    two_factor_timeout_seconds: int = 180
    two_factor_grace_seconds: int = 30
    gateway_connect_stale_seconds: int = 90
    gateway_login_poll_seconds: float = 5

    # Bootstrap tenant. The pre-tenancy installation's data is migrated onto it.
    bootstrap_tenant_slug: str = "saatvik"
    bootstrap_tenant_name: str = "Saatvik"

    # Automated IB Gateway provisioning. Each managed connection gets its own
    # IBC directory, its own API port, and its own systemd instance.
    gateway_instance_root: str = "/opt/ibc/instances"
    gateway_instance_unit: str = "ibkr-gateway@{instance}.service"
    gateway_template_config: str = "/opt/ibc/config.ini"
    gateway_log_root: str = "/var/log/ibc"
    gateway_port_range_start: int = 4100
    gateway_port_range_end: int = 4199
    gateway_provisioning_enabled: bool = True

    # SnapTrade. Left blank until the operator supplies partner credentials;
    # the provider stays unavailable rather than half-configured.
    snaptrade_client_id: str = ""
    snaptrade_consumer_key: str = ""
    snaptrade_base_url: str = "https://api.snaptrade.com/api/v1"
    snaptrade_redirect_uri: str = ""
    snaptrade_poll_seconds: float = 60

    # Massive (Polygon-compatible) market data, the same vendor and REST host the
    # US-Trading-Infra project uses. Supplies the underlying reference price the
    # payoff panel models from. Blank key leaves the feed off entirely and the
    # panel falls back to the `undPrice` IB computes off an option's model tick.
    # Massive has priority for configured symbols; an unavailable vendor quote
    # falls back to the option-model `undPrice` supplied by IB.
    massive_api_key: str = ""
    massive_rest_url: str = "https://api.massive.com"
    #: Comma-separated underlyings to poll, e.g. "SPX,NDX". US-listed, so USD.
    massive_underlyings: str = ""
    massive_refresh_seconds: float = 15
    #: Backoff once a whole cycle returns nothing — a closed market, or no entitlement.
    massive_idle_seconds: float = 60
    massive_archive_directory: str = "/var/lib/ibkr-rms/market-data"
    massive_session_timezone: str = "America/New_York"
    massive_session_open: str = "09:30"
    massive_session_close: str = "16:00"

    # Account history. Snapshots are what this platform records from the moment
    # it is switched on; Flex backfills the broker's own daily net liquidation
    # from before that. Blank Flex settings simply leave the curve starting at
    # the first snapshot.
    snapshot_seconds: float = 300
    #: Snapshots older than this are dropped by the sweeper. Zero keeps them all.
    snapshot_retention_days: int = 1095
    ibkr_flex_token: str = ""
    ibkr_flex_query_id: str = ""

    # Encrypts broker secrets held in MongoDB (SnapTrade user secrets). IBKR
    # passwords are never stored in the database at all — they go straight to
    # the IBC config file on disk.
    secret_key: str = ""

    @property
    def massive_symbols(self) -> list[str]:
        return [s.strip().upper() for s in self.massive_underlyings.split(",") if s.strip()]

    @property
    def origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


settings = Settings()
