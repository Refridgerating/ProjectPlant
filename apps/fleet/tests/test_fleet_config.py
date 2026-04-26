from config import Settings


def test_settings_normalize_cors_from_csv():
    settings = Settings(cors_origins="http://example.com, http://localhost:5173")
    assert settings.cors_origins == ["http://example.com", "http://localhost:5173"]


def test_settings_normalize_bracketed_pseudo_list_and_tokens():
    settings = Settings(
        cors_origins='[localhost:5180, "192.168.0.2:5180"]',
        fleet_bootstrap_tokens='["token-a", token-b]',
    )
    assert settings.cors_origins == ["http://localhost:5180", "http://192.168.0.2:5180"]
    assert settings.fleet_bootstrap_tokens == ["token-a", "token-b"]


def test_settings_handle_malformed_shell_cors_env(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "[http://127.0.0.1:5173, localhost:5180]")
    settings = Settings()
    assert settings.cors_origins == ["http://127.0.0.1:5173", "http://localhost:5180"]


def test_settings_normalize_debug_aliases(monkeypatch):
    monkeypatch.setenv("DEBUG", "release")
    assert Settings().debug is False

    monkeypatch.setenv("DEBUG", "production")
    assert Settings().debug is False

    monkeypatch.setenv("DEBUG", "development")
    assert Settings().debug is True

    monkeypatch.setenv("DEBUG", "true")
    assert Settings().debug is True
