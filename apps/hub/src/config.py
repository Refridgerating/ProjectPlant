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

    hrrr_enabled: bool = Field(default=True, description="Enable NOAA HRRR ingestion pipeline")
    hrrr_base_url: str = Field(
        default="https://noaa-hrrr-bdp-pds.s3.amazonaws.com",
        description="Base URL for downloading HRRR GRIB assets",
    )
    hrrr_domain: str = Field(default="conus", description="HRRR domain segment used when building GRIB paths")
    hrrr_cache_dir: str = Field(default="data/hrrr", description="Local directory used to cache HRRR GRIB downloads")
    hrrr_cache_max_age_minutes: int = Field(
        default=360,
        ge=0,
        description="Maximum age (minutes) for cached HRRR GRIB before re-fetching",
    )
    hrrr_availability_delay_minutes: int = Field(
        default=90,
        ge=0,
        description="Delay applied when selecting HRRR cycle/forecast to account for publication lag",
    )
    hrrr_max_forecast_hour: int = Field(
        default=18,
        ge=0,
        le=48,
        description="Maximum forecast hour to request from a single HRRR cycle",
    )
    hrrr_default_lat: float | None = Field(
        default=None,
        ge=-90.0,
        le=90.0,
        description="Default latitude used for HRRR scheduled refresh",
    )
    hrrr_default_lon: float | None = Field(
        default=None,
        ge=-180.0,
        le=180.0,
        description="Default longitude used for HRRR scheduled refresh",
    )
    hrrr_refresh_interval_minutes: float | None = Field(
        default=60.0,
        ge=0.0,
        description="Interval (minutes) between scheduled HRRR refresh executions",
    )

    environment_sensor_freshness_minutes: float = Field(
        default=15.0,
        ge=0.0,
        description="Maximum age in minutes for local environment sensor data before falling back to external sources.",
    )

    # Plant lookup APIs
    trefle_token: str | None = Field(default=None, description="Token for Trefle API access")
    trefle_base_url: str = Field(default="https://trefle.io/api/v1")
    powo_base_url: str = Field(default="https://powo.science.kew.org/api/2")
    openfarm_base_url: str = Field(default="https://openfarm.cc/api/v1")
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

settings = Settings()
