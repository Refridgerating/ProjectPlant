
from fastapi.testclient import TestClient

from auth.jwt import verify_access_token
from config import settings


def test_meta_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": settings.app_version}


def test_v1_info(client: TestClient) -> None:
    response = client.get("/api/v1/info")
    assert response.status_code == 200
    payload = response.json()
    assert payload["name"] == settings.app_name
    assert payload["version"] == settings.app_version
    assert payload["debug"] == settings.debug
    assert payload["cors_origins"] == settings.cors_origins
    assert payload["mqtt_enabled"] == settings.mqtt_enabled
    assert payload["mqtt_host"] == settings.mqtt_host
    assert payload["mqtt_port"] == settings.mqtt_port
    assert payload["pot_telemetry_retention_hours"] == settings.pot_telemetry_retention_hours
    assert payload["pot_telemetry_max_rows"] == settings.pot_telemetry_max_rows


def test_issue_auth_token(client: TestClient) -> None:
    response = client.post("/api/v1/auth/token")
    assert response.status_code == 200
    payload = response.json()
    assert payload["token_type"] == "bearer"
    assert payload["expires_in"] == settings.auth_access_token_ttl_seconds
    assert verify_access_token(payload["access_token"]) == "user-demo-owner"


def test_google_sign_in_disabled(client: TestClient) -> None:
    response = client.post("/api/v1/auth/google", json={"id_token": "demo-token"})
    assert response.status_code == 503


def test_local_sign_in_with_master_account(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/local",
        json={
            "email": "grower@example.com",
            "password": "demo-owner-password",
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["token_type"] == "bearer"
    assert payload["user"]["id"] == "user-demo-owner"
    assert payload["user"]["auth_provider"] == "local"
    assert verify_access_token(payload["access_token"]) == "user-demo-owner"


def test_local_sign_in_rejects_invalid_password(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/local",
        json={
            "email": "grower@example.com",
            "password": "wrong-password",
        },
    )
    assert response.status_code == 401


def test_google_sign_in_creates_user_and_issues_token(client: TestClient, settings_override, monkeypatch) -> None:
    from auth.google import GoogleIdentity

    settings_override(
        google_oauth_enabled=True,
        google_oauth_client_ids=["test-client-id.apps.googleusercontent.com"],
    )

    def _fake_verify(token: str, *, allowed_client_ids, hosted_domain=None) -> GoogleIdentity:
        assert token == "google-id-token"
        assert allowed_client_ids == ["test-client-id.apps.googleusercontent.com"]
        assert hosted_domain is None
        return GoogleIdentity(
            subject="google-sub-123",
            email="plant.owner@gmail.com",
            email_verified=True,
            display_name="Plant Owner",
            picture="https://example.com/avatar.png",
            hosted_domain=None,
        )

    monkeypatch.setattr("api.v1.auth_router.verify_google_id_token", _fake_verify)

    response = client.post("/api/v1/auth/google", json={"id_token": "google-id-token"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["token_type"] == "bearer"
    assert payload["user"]["email"] == "plant.owner@gmail.com"
    assert payload["user"]["display_name"] == "Plant Owner"
    assert payload["user"]["auth_provider"] == "google"
    assert payload["user"]["email_verified"] is True
    assert verify_access_token(payload["access_token"]) == payload["user"]["id"]


def test_apple_sign_in_disabled(client: TestClient) -> None:
    response = client.post("/api/v1/auth/apple", json={"id_token": "demo-token"})
    assert response.status_code == 503


def test_apple_sign_in_creates_user_and_issues_token(client: TestClient, settings_override, monkeypatch) -> None:
    from auth.apple import AppleIdentity

    settings_override(
        apple_oauth_enabled=True,
        apple_oauth_client_ids=["com.projectplant.web"],
    )

    def _fake_verify(token: str, *, allowed_client_ids) -> AppleIdentity:
        assert token == "apple-id-token"
        assert allowed_client_ids == ["com.projectplant.web"]
        return AppleIdentity(
            subject="apple-sub-999",
            email="grower.apple@example.com",
            email_verified=True,
            display_name="Apple Grower",
        )

    monkeypatch.setattr("api.v1.auth_router.verify_apple_id_token", _fake_verify)

    response = client.post("/api/v1/auth/apple", json={"id_token": "apple-id-token"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["token_type"] == "bearer"
    assert payload["user"]["email"] == "grower.apple@example.com"
    assert payload["user"]["display_name"] == "Apple Grower"
    assert payload["user"]["auth_provider"] == "apple"
    assert payload["user"]["email_verified"] is True
    assert verify_access_token(payload["access_token"]) == payload["user"]["id"]


def test_etkc_metrics_endpoint(client: TestClient) -> None:
    response = client.get("/api/v1/etkc/metrics/test-pot")
    assert response.status_code == 200
    assert response.json() == []
