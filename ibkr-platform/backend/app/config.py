from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    mongodb_uri: str = "mongodb://localhost:27017"
    mongodb_database: str = "ibkr_phase1"
    redis_url: str = "redis://localhost:6379/0"
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

    bootstrap_tenant_slug: str = "saatvik"
    bootstrap_tenant_name: str = "Saatvik"

    gateway_instance_root: str = "/opt/ibc/instances"
    gateway_instance_unit: str = "ibkr-gateway@{instance}.service"
    gateway_template_config: str = "/opt/ibc/config.ini"
    gateway_log_root: str = "/var/log/ibc"
    gateway_port_range_start: int = 4100
    gateway_port_range_end: int = 4199
    gateway_provisioning_enabled: bool = True

    snaptrade_client_id: str = ""
    snaptrade_consumer_key: str = ""
    snaptrade_base_url: str = "https://api.snaptrade.com/api/v1"
    snaptrade_redirect_uri: str = ""
    snaptrade_poll_seconds: float = 60
    massive_api_key: str = ""
    massive_rest_url: str = "https://api.massive.com"
    massive_underlyings: str = ""
    massive_refresh_seconds: float = 15
    massive_idle_seconds: float = 60
    massive_archive_directory: str = "/var/lib/ibkr-rms/market-data"
    massive_session_timezone: str = "America/New_York"
    massive_session_open: str = "09:30"
    massive_session_close: str = "16:00"

    snapshot_seconds: float = 300
    snapshot_retention_days: int = 1095
    ibkr_flex_token: str = ""
    ibkr_flex_query_id: str = ""

    secret_key: str = ""

    @property
    def massive_symbols(self) -> list[str]:
        return [s.strip().upper() for s in self.massive_underlyings.split(",") if s.strip()]

    @property
    def origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


settings = Settings()
