import json
import re
from pathlib import Path
from typing import Annotated, List

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

APP_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = APP_ROOT.parent.parent
_TRUE_ALIASES = {"1", "true", "t", "yes", "y", "on", "debug", "development", "dev"}
_FALSE_ALIASES = {"0", "false", "f", "no", "n", "off", "release", "production", "prod"}


def _resolve_fleet_path(raw_value: object) -> str | None:
    if raw_value is None:
        return None
    cleaned = str(raw_value).strip()
    if not cleaned:
        return None

    candidate = Path(cleaned).expanduser()
    if candidate.is_absolute():
        return str(candidate.resolve())

    normalized = cleaned.replace("\\", "/")
    if normalized.startswith("apps/fleet/"):
        return str((REPO_ROOT / normalized).resolve())

    return str((APP_ROOT / candidate).resolve())


_HOST_PORT_RE = re.compile(r"^[A-Za-z0-9.-]+(?::\d+)?$")


def _clean_list_token(raw_value: object) -> str:
    cleaned = str(raw_value).strip()
    while len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in {'"', "'"}:
        cleaned = cleaned[1:-1].strip()
    return cleaned


def _normalize_string_list(raw_value: object, *, auto_http: bool = False) -> list[str]:
    if raw_value is None:
        return []
    if isinstance(raw_value, (list, tuple, set)):
        values = list(raw_value)
    elif isinstance(raw_value, str):
        cleaned = raw_value.strip()
        if not cleaned:
            return []
        if cleaned == "*":
            return ["*"]
        values: list[object]
        if cleaned.startswith("[") and cleaned.endswith("]"):
            try:
                parsed = json.loads(cleaned)
            except json.JSONDecodeError:
                parsed = [part for part in cleaned[1:-1].split(",")]
            if isinstance(parsed, list):
                values = parsed
            else:
                values = [parsed]
        else:
            values = cleaned.split(",")
    else:
        values = [raw_value]

    normalized: list[str] = []
    for value in values:
        token = _clean_list_token(value)
        if not token:
            continue
        if auto_http and token != "*" and "://" not in token and _HOST_PORT_RE.match(token):
            token = f"http://{token}"
        normalized.append(token)
    return normalized


def _normalize_booleanish(raw_value: object) -> bool:
    if isinstance(raw_value, bool):
        return raw_value
    if isinstance(raw_value, (int, float)) and raw_value in (0, 1):
        return bool(raw_value)
    cleaned = str(raw_value).strip().lower()
    if cleaned in _TRUE_ALIASES:
        return True
    if cleaned in _FALSE_ALIASES:
        return False
    raise ValueError(f"Unsupported boolean value: {raw_value}")


class Settings(BaseSettings):
    _env_file = APP_ROOT / ".env"
    model_config = SettingsConfigDict(env_file=str(_env_file), extra="ignore", case_sensitive=False)

    app_name: str = "ProjectPlant Fleet"
    app_version: str = "0.1.0"
    debug: bool = True
    cors_origins: Annotated[List[str], NoDecode] = Field(default_factory=lambda: ["*"])
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
    fleet_bootstrap_tokens: Annotated[List[str], NoDecode] = Field(default_factory=list)
    fleet_bootstrap_artifact_path: str = Field(default="/etc/projectplant/bootstrap/master-bootstrap.json")
    fleet_recovery_public_key_path: str = Field(default="/etc/projectplant/recovery/master-recovery.pub")
    fleet_bootstrap_nonce_ttl_seconds: int = Field(default=600, ge=60, le=3600)
    fleet_recovery_challenge_ttl_seconds: int = Field(default=300, ge=60, le=1800)

    @field_validator("cors_origins", mode="before")
    @classmethod
    def normalize_cors(cls, value):
        normalized = _normalize_string_list(value, auto_http=True)
        return normalized or ["*"]

    @field_validator("debug", mode="before")
    @classmethod
    def normalize_debug(cls, value):
        return _normalize_booleanish(value)

    @field_validator("fleet_bootstrap_tokens", mode="before")
    @classmethod
    def normalize_tokens(cls, value):
        return _normalize_string_list(value)

    @field_validator(
        "fleet_database_path",
        "fleet_artifact_dir",
        "fleet_release_public_key_path",
        "fleet_bootstrap_artifact_path",
        "fleet_recovery_public_key_path",
        mode="before",
    )
    @classmethod
    def resolve_runtime_paths(cls, value):
        return _resolve_fleet_path(value)


settings = Settings()
