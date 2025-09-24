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
    assert settings.mqtt_host == "localhost"


def test_settings_normalizes_cors_from_string():
    settings = Settings(cors_origins="http://example.com, http://localhost")
    assert settings.cors_origins == ["http://example.com", "http://localhost"]


def test_settings_handles_case_insensitive_env(monkeypatch):
    monkeypatch.setenv("mqtt_host", "override-host")
    settings = Settings()
    assert settings.mqtt_host == "override-host"
