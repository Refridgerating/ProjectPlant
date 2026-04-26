from config import Settings


def test_settings_loads_env_file_defaults():
    settings = Settings()
    assert settings.app_name == "ProjectPlant Hub"
    assert settings.app_version == "0.1.0"
    assert settings.cors_origins == [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "tauri://localhost",
    ]
    assert settings.mqtt_enabled is True
    assert settings.mqtt_host == "192.168.0.15"


def test_settings_normalizes_cors_from_string():
    settings = Settings(cors_origins="http://example.com, http://localhost")
    assert settings.cors_origins == ["http://example.com", "http://localhost"]


def test_settings_normalizes_bracketed_pseudo_list_and_prefixes_host_port():
    settings = Settings(cors_origins='[localhost:5173, "192.168.0.2:5175"]')
    assert settings.cors_origins == ["http://localhost:5173", "http://192.168.0.2:5175"]


def test_settings_normalizes_oauth_lists_and_alert_recipients():
    settings = Settings(
        google_oauth_client_ids='["client-a", client-b]',
        apple_oauth_client_ids="'apple-a', apple-b",
        alerts_email_to='["a@example.com", b@example.com]',
    )
    assert settings.google_oauth_client_ids == ["client-a", "client-b"]
    assert settings.apple_oauth_client_ids == ["apple-a", "apple-b"]
    assert settings.alerts_email_to == ["a@example.com", "b@example.com"]


def test_settings_handles_malformed_shell_cors_env(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", '[http://127.0.0.1:5173, 192.168.0.2:5175]')
    settings = Settings()
    assert settings.cors_origins == ["http://127.0.0.1:5173", "http://192.168.0.2:5175"]


def test_settings_handles_case_insensitive_env(monkeypatch):
    monkeypatch.setenv("mqtt_host", "override-host")
    settings = Settings()
    assert settings.mqtt_host == "override-host"


def test_settings_normalizes_debug_aliases(monkeypatch):
    monkeypatch.setenv("DEBUG", "release")
    assert Settings().debug is False

    monkeypatch.setenv("DEBUG", "production")
    assert Settings().debug is False

    monkeypatch.setenv("DEBUG", "development")
    assert Settings().debug is True

    monkeypatch.setenv("DEBUG", "true")
    assert Settings().debug is True


def test_settings_normalizes_blank_schedule_timezone_override():
    settings = Settings(plant_schedule_tz_posix="   ")
    assert settings.plant_schedule_tz_posix is None
