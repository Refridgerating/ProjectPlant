from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, field_validator
from typing import List

class Settings(BaseSettings):
    # Load apps/hub/.env and accept env keys in any case
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

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
