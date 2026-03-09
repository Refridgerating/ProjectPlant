from pathlib import Path
from typing import List

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    _env_file = Path(__file__).resolve().parent.parent / ".env"
    model_config = SettingsConfigDict(env_file=str(_env_file), extra="ignore", case_sensitive=False)

    app_name: str = "ProjectPlant Fleet"
    app_version: str = "0.1.0"
    debug: bool = True
    cors_origins: List[str] = Field(default_factory=lambda: ["*"])
    port: int = 8100

    auth_jwt_algorithm: str = Field(default="EdDSA")
    auth_jwt_issuer: str = Field(default="projectplant-fleet")
    auth_jwt_audience: str = Field(default="projectplant-managed")
    auth_master_access_token_ttl_seconds: int = Field(default=4 * 60 * 60, ge=300, le=24 * 60 * 60)
    auth_user_access_token_ttl_seconds: int = Field(default=12 * 60 * 60, ge=300, le=7 * 24 * 60 * 60)
    auth_state_encryption_key: str = Field(default="change-me-in-production-state-key")
    auth_mfa_challenge_ttl_seconds: int = Field(default=300, ge=60, le=1800)
    auth_login_rate_limit_window_seconds: int = Field(default=900, ge=60, le=3600)
    auth_login_rate_limit_attempts: int = Field(default=5, ge=1, le=20)
    auth_totp_issuer: str = Field(default="ProjectPlant")

    fleet_database_path: str = Field(default="data/fleet.sqlite3")
    fleet_artifact_dir: str = Field(default="data/artifacts")
    fleet_poll_interval_seconds: int = Field(default=30, ge=5, le=300)
    fleet_signature_ttl_seconds: int = Field(default=300, ge=30, le=1800)
    fleet_release_public_key_path: str | None = Field(default=None)
    fleet_bootstrap_tokens: List[str] = Field(default_factory=list)
    fleet_bootstrap_artifact_path: str = Field(default="/etc/projectplant/bootstrap/master-bootstrap.json")
    fleet_recovery_public_key_path: str = Field(default="/etc/projectplant/recovery/master-recovery.pub")
    fleet_bootstrap_nonce_ttl_seconds: int = Field(default=600, ge=60, le=3600)
    fleet_recovery_challenge_ttl_seconds: int = Field(default=300, ge=60, le=1800)

    @field_validator("cors_origins", mode="before")
    @classmethod
    def normalize_cors(cls, value):
        if isinstance(value, str):
            cleaned = value.strip()
            if not cleaned or cleaned == "*":
                return ["*"]
            if cleaned.startswith("["):
                import json

                return json.loads(cleaned)
            return [item.strip() for item in cleaned.split(",") if item.strip()]
        return value

    @field_validator("fleet_bootstrap_tokens", mode="before")
    @classmethod
    def normalize_tokens(cls, value):
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
