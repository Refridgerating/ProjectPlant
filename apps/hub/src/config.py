from pathlib import Path
from typing import List

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    # Load apps/hub/.env and accept env keys in any case
    _env_file = Path(__file__).resolve().parent.parent / ".env"
    model_config = SettingsConfigDict(env_file=str(_env_file), extra="ignore", case_sensitive=False)

    # use lowercase field names (pydantic best practice)
    app_name: str = "ProjectPlant Hub"
    app_version: str = "0.1.0"
    debug: bool = True
    cors_origins: List[str] = Field(default_factory=lambda: ["*"])
    port: int = 8000

    # Access token auth
    auth_jwt_secret: str = Field(
        default="change-me-in-production",
        description="HMAC secret used to sign API access tokens.",
    )
    auth_jwt_algorithm: str = Field(default="HS256")
    auth_jwt_issuer: str = Field(default="projectplant-hub")
    auth_jwt_audience: str = Field(default="projectplant-clients")
    auth_access_token_ttl_seconds: int = Field(default=3600, ge=60, le=86400)

    # Google sign-in
    google_oauth_enabled: bool = Field(
        default=False,
        description="Enable Google ID token sign-in endpoint.",
    )
    google_oauth_client_ids: List[str] = Field(
        default_factory=list,
        description="Accepted Google OAuth Web Client IDs for ID token verification.",
    )
    google_oauth_hosted_domain: str | None = Field(
        default=None,
        description="Optional Google Workspace hosted domain restriction (e.g. example.com).",
    )

    # Apple sign-in
    apple_oauth_enabled: bool = Field(
        default=False,
        description="Enable Apple ID token sign-in endpoint.",
    )
    apple_oauth_client_ids: List[str] = Field(
        default_factory=list,
        description="Accepted Apple Services IDs (audience values) for ID token verification.",
    )

    # MQTT
    mqtt_enabled: bool = False
    mqtt_host: str = "localhost"
    mqtt_port: int = 1883
    mqtt_username: str | None = None
    mqtt_password: str | None = None
    mqtt_client_id: str = "projectplant-hub"
    mqtt_tls: bool = False

    # Weather API
    weather_user_agent: str = Field(
        default="ProjectPlantHub/0.1.0 (support@example.com)",
        description="User-Agent sent to upstream weather providers.",
    )
    weather_request_timeout: float = Field(default=5.0, ge=1.0, description="Timeout in seconds for weather HTTP calls")
    weather_cache_ttl: int = Field(default=300, ge=0, description="Cache duration (seconds) for weather responses")
    weather_base_url: str = Field(default="https://api.weather.gov", description="Base URL for weather provider")
    nasa_power_base_url: str = Field(
        default="https://power.larc.nasa.gov",
        description="Base URL for NASA POWER API",
    )

    environment_sensor_freshness_minutes: float = Field(
        default=15.0,
        ge=0.0,
        description="Maximum age in minutes for local environment sensor data before falling back to external sources.",
    )

    # HRRR weather ingestion
    hrrr_enabled: bool = Field(default=False, description="Enable NOAA HRRR downloads and cache management.")
    hrrr_base_url: str = Field(
        default="https://nomads.ncep.noaa.gov/pub/data/nccf/com/hrrr/prod",
        description="Base URL for HRRR GRIB2 assets.",
    )
    hrrr_domain: str = Field(default="conus", description="HRRR domain identifier (e.g. conus, alaska).")
    hrrr_cache_dir: str = Field(
        default="apps/hub/data/hrrr/cache",
        description="Directory for cached HRRR GRIB2 downloads (relative to repo root).",
    )
    hrrr_archive_dir: str = Field(
        default="apps/hub/data/hrrr/archive",
        description="Directory where archived HRRR assets will be stored.",
    )
    hrrr_cache_max_age_minutes: int = Field(
        default=6 * 60,
        ge=1,
        description="How long cached HRRR files are considered fresh before re-fetching.",
    )
    hrrr_refresh_interval_minutes: int = Field(
        default=120,
        ge=1,
        description="Minimum spacing between automatic HRRR refreshes.",
    )
    hrrr_availability_delay_minutes: int = Field(
        default=75,
        ge=0,
        description="Delay applied to HRRR cycle availability to account for NOAA publishing latency.",
    )
    hrrr_max_forecast_hour: int = Field(
        default=18,
        ge=1,
        le=48,
        description="Maximum HRRR forecast hour to request when downloading GRIB2 files.",
    )
    hrrr_default_lat: float | None = Field(
        default=None,
        description="Optional fallback latitude if HRRR requests omit coordinates.",
    )
    hrrr_default_lon: float | None = Field(
        default=None,
        description="Optional fallback longitude if HRRR requests omit coordinates.",
    )

    # Plant lookup APIs
    powo_base_url: str = Field(default="https://powo.science.kew.org/api/2")
    inat_base_url: str = Field(default="https://api.inaturalist.org/v1")
    gbif_base_url: str = Field(default="https://api.gbif.org/v1")
    plant_lookup_timeout: float = Field(default=6.0, ge=1.0, description="Timeout for plant enrichment HTTP calls")
    plant_lookup_cache_ttl: int = Field(default=1800, ge=0, description="Cache duration (seconds) for plant lookups")
    pot_telemetry_db: str = Field(
        default="data/pot_telemetry.sqlite",
        description="SQLite database path for persisted pot telemetry samples.",
    )
    pot_telemetry_retention_hours: int = Field(default=168, ge=1, description="Retention window for pot telemetry")
    pot_telemetry_max_rows: int = Field(
        default=12_000,
        ge=100,
        description="Maximum number of telemetry rows to retain before pruning oldest samples.",
    )
    provision_event_log: str | None = Field(
        default="data/provisioning/events.jsonl",
        description="Path to a JSONL log capturing provisioning wait attempts and results. Set to blank to disable.",
    )
    alerts_history_limit: int = Field(
        default=200,
        ge=50,
        description="Max number of in-memory alert events retained for diagnostics.",
    )
    alerts_event_log: str | None = Field(
        default=None,
        description="Optional path to persist alert events as JSONL. Leave blank to disable persistence.",
    )
    alerts_webhook_url: str | None = Field(
        default=None,
        description="Optional webhook endpoint (e.g., Slack) that receives alert payloads.",
    )
    alerts_smtp_host: str | None = Field(default=None, description="SMTP server for alert email delivery.")
    alerts_smtp_port: int = Field(default=587, description="SMTP port for alert notifications.")
    alerts_smtp_username: str | None = Field(default=None, description="SMTP username when authentication is required.")
    alerts_smtp_password: str | None = Field(default=None, description="SMTP password when authentication is required.")
    alerts_smtp_tls: bool = Field(default=True, description="Use STARTTLS when sending alert emails.")
    alerts_email_from: str | None = Field(default=None, description="Sender address for alert emails.")
    alerts_email_to: List[str] = Field(
        default_factory=list,
        description="Recipient email addresses for alert notifications.",
    )
    device_registry_path: str = Field(
        default="data/device_registry.json",
        description="Path to persist manually tracked pot identifiers.",
    )
    plant_schedule_path: str = Field(
        default="data/plant_schedules.json",
        description="Path to persist per-pot plant control schedules.",
    )
    plant_schedule_interval_seconds: float = Field(
        default=30.0,
        ge=5.0,
        le=3600.0,
        description="Scheduler polling interval for applying plant control timers.",
    )
    plant_schedule_command_timeout_seconds: float = Field(
        default=5.0,
        ge=0.1,
        le=30.0,
        description="Timeout in seconds when waiting for actuator override acknowledgements.",
    )

    @field_validator("cors_origins", mode="before")
    @classmethod
    def normalize_cors(cls, v):
        if isinstance(v, str):
            s = v.strip()
            if s.startswith("["):
                import json
                return json.loads(s)
            if s in ("", "*"):
                return ["*"]
            return [p.strip() for p in s.split(",")]
        return v

    @field_validator("google_oauth_client_ids", mode="before")
    @classmethod
    def normalize_google_client_ids(cls, value):
        if value is None:
            return []
        if isinstance(value, str):
            cleaned = value.strip()
            if not cleaned:
                return []
            if cleaned.startswith("["):
                import json

                parsed = json.loads(cleaned)
                if isinstance(parsed, list):
                    return [str(item).strip() for item in parsed if str(item).strip()]
                return []
            return [item.strip() for item in cleaned.split(",") if item.strip()]
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        return value

    @field_validator("google_oauth_hosted_domain", mode="before")
    @classmethod
    def normalize_google_hosted_domain(cls, value):
        if value is None:
            return None
        cleaned = str(value).strip().lower()
        return cleaned or None

    @field_validator("apple_oauth_client_ids", mode="before")
    @classmethod
    def normalize_apple_client_ids(cls, value):
        if value is None:
            return []
        if isinstance(value, str):
            cleaned = value.strip()
            if not cleaned:
                return []
            if cleaned.startswith("["):
                import json

                parsed = json.loads(cleaned)
                if isinstance(parsed, list):
                    return [str(item).strip() for item in parsed if str(item).strip()]
                return []
            return [item.strip() for item in cleaned.split(",") if item.strip()]
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        return value

settings = Settings()
