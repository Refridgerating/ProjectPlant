from __future__ import annotations

from fastapi.testclient import TestClient

from auth.jwt import create_access_token
from services.plants import plant_catalog


def test_list_users_and_me(client: TestClient) -> None:
    all_users = client.get("/api/v1/users")
    assert all_users.status_code == 200
    payload = all_users.json()
    assert isinstance(payload, list)
    assert any(user["id"] == "user-demo-owner" for user in payload)
    owner_details = next(user for user in payload if user["id"] == "user-demo-owner")
    assert owner_details["email_verified"] is True
    assert owner_details["verification_pending"] is False
    assert owner_details["auth_provider"] == "local"

    me = client.get("/api/v1/users/me")
    assert me.status_code == 200
    me_payload = me.json()
    assert me_payload["id"] == "user-demo-owner"
    assert me_payload["email"] == "grower@example.com"
    assert me_payload["email_verified"] is True
    assert me_payload["auth_provider"] == "local"


def test_get_me_with_bearer_token(client: TestClient) -> None:
    token = create_access_token("user-demo-owner")
    response = client.get("/api/v1/users/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    assert response.json()["id"] == "user-demo-owner"


def test_preferences_lifecycle(client: TestClient) -> None:
    initial = client.get("/api/v1/users/me/preferences")
    assert initial.status_code == 200
    assert initial.json()["values"] == {}

    updated = client.put(
        "/api/v1/users/me/preferences",
        json={
            "values": {
                "theme": "forest",
                "telemetry_range": "24h",
            }
        },
    )
    assert updated.status_code == 200
    assert updated.json()["values"]["theme"] == "forest"
    assert updated.json()["values"]["telemetry_range"] == "24h"

    merged = client.put(
        "/api/v1/users/me/preferences",
        json={
            "values": {
                "alerts_enabled": True,
            }
        },
    )
    assert merged.status_code == 200
    assert merged.json()["values"]["theme"] == "forest"
    assert merged.json()["values"]["alerts_enabled"] is True

    replaced = client.put(
        "/api/v1/users/me/preferences",
        json={
            "replace": True,
            "values": {"units": "imperial"},
        },
    )
    assert replaced.status_code == 200
    assert replaced.json()["values"] == {"units": "imperial"}


def test_create_update_delete_user(client: TestClient) -> None:
    initial_outbox = len(plant_catalog.list_verification_outbox())
    created = client.post(
        "/api/v1/users",
        json={
            "email": "new@example.com",
            "display_name": "New User",
            "password": "securepass1",
            "confirm_password": "securepass1",
        },
    )
    assert created.status_code == 201
    user = created.json()
    user_id = user["id"]
    assert user["display_name"] == "New User"
    assert user["email_verified"] is False
    assert user["verification_pending"] is True
    assert user["auth_provider"] == "local"

    outbox = plant_catalog.list_verification_outbox()
    assert len(outbox) == initial_outbox + 1
    token = next(token for email, token in outbox if email == "new@example.com")

    verified = client.post(f"/api/v1/users/{user_id}/verify", json={"token": token})
    assert verified.status_code == 200
    verified_payload = verified.json()
    assert verified_payload["email_verified"] is True
    assert verified_payload["verification_pending"] is False
    assert len(plant_catalog.list_verification_outbox()) == initial_outbox

    updated = client.patch(
        f"/api/v1/users/{user_id}",
        headers={"X-User-Id": user_id},
        json={"display_name": "Updated User", "password": "newsecurepass1", "confirm_password": "newsecurepass1"},
    )
    assert updated.status_code == 200
    assert updated.json()["display_name"] == "Updated User"

    deleted = client.delete(f"/api/v1/users/{user_id}", headers={"X-User-Id": user_id})
    assert deleted.status_code == 204


def test_share_lifecycle(client: TestClient) -> None:
    contractor = client.post(
        "/api/v1/users",
        json={
            "email": "contractor2@example.com",
            "display_name": "Contractor",
            "password": "contractorpass",
            "confirm_password": "contractorpass",
        },
    )
    assert contractor.status_code == 201
    contractor_id = contractor.json()["id"]

    created_share = client.post(
        "/api/v1/users/me/shares",
        json={"contractor_id": contractor_id, "status": "pending", "role": "contractor"},
    )
    assert created_share.status_code == 201
    share = created_share.json()
    share_id = share["id"]
    assert share["status"] == "pending"
    assert share["participant_role"] == "owner"

    # Contractor can view share but not modify.
    contractor_shares = client.get("/api/v1/users/me/shares", headers={"X-User-Id": contractor_id})
    assert contractor_shares.status_code == 200
    as_contractor = contractor_shares.json()
    assert len(as_contractor) == 1
    assert as_contractor[0]["participant_role"] == "contractor"

    updated_share = client.patch(
        f"/api/v1/users/me/shares/{share_id}",
        json={"status": "active"},
    )
    assert updated_share.status_code == 200
    assert updated_share.json()["status"] == "active"

    forbidden_update = client.patch(
        f"/api/v1/users/me/shares/{share_id}",
        headers={"X-User-Id": contractor_id},
        json={"status": "revoked"},
    )
    assert forbidden_update.status_code == 403

    removed = client.delete(f"/api/v1/users/me/shares/{share_id}")
    assert removed.status_code == 204
