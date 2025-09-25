from __future__ import annotations

import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from config import settings
from main import create_app
from services.plant_lookup import plant_lookup_service


@pytest.fixture
def client():
    settings.mqtt_enabled = False
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


def _clear_lookup_cache():
    plant_lookup_service._suggest_cache.clear()  # type: ignore[attr-defined]
    plant_lookup_service._details_cache.clear()  # type: ignore[attr-defined]


def test_reference_search(client: TestClient):
    response = client.get("/api/v1/plants/reference", params={"search": "monstera"})
    assert response.status_code == 200
    payload = response.json()
    assert payload
    entry = payload[0]
    assert entry["species"].lower().startswith("monstera")
    assert "light" in entry


@respx.mock
def test_suggest_plants_remote_and_local(client: TestClient):
    settings.trefle_token = "test-token"
    _clear_lookup_cache()
    respx.get("https://trefle.io/api/v1/plants/search").mock(
        return_value=Response(
            200,
            json={
                "data": [
                    {
                        "scientific_name": "Monstera deliciosa",
                        "common_name": "Swiss cheese plant",
                        "image_url": "https://img/monstera.jpg",
                        "rank": "species",
                        "bibliography": "Araceae",
                    }
                ]
            },
        )
    )
    respx.get("https://powo.science.kew.org/api/2/search").mock(
        return_value=Response(200, json={"results": []})
    )

    response = client.get("/api/v1/plants/suggest", params={"query": "Monstera"})
    assert response.status_code == 200
    data = response.json()
    sources = {item["source"] for item in data}
    assert "trefle" in sources
    assert "local" in sources

    settings.trefle_token = None
    _clear_lookup_cache()


@respx.mock
def test_details_endpoint_with_openfarm(client: TestClient):
    settings.trefle_token = "test-token"
    _clear_lookup_cache()
    respx.get("https://trefle.io/api/v1/plants/search").mock(
        return_value=Response(
            200,
            json={
                "data": [
                    {
                        "scientific_name": "Monstera deliciosa",
                        "common_name": "Swiss cheese plant",
                        "family": "Araceae",
                        "genus": "Monstera",
                        "rank": "species",
                        "synonyms": ["Monstera borsigiana"],
                        "native_status": "Central America",
                        "bibliography": "Some botanical notes",
                        "image_url": "https://img/monstera.jpg",
                    }
                ]
            },
        )
    )
    respx.get("https://powo.science.kew.org/api/2/search").mock(
        return_value=Response(
            200,
            json={
                "results": [
                    {
                        "name": "Monstera deliciosa",
                        "family": "Araceae",
                        "rank": "species",
                        "mainCommonName": "Swiss cheese plant",
                        "thumbnail": "https://img/powo.jpg",
                        "synonyms": [{"name": "Philodendron pertusum"}],
                        "distribution": {
                            "native": [
                                {"name": "Mexico"},
                                {"name": "Guatemala"},
                            ]
                        },
                        "summary": "Climbing evergreen",
                    }
                ]
            },
        )
    )
    respx.get("https://openfarm.cc/api/v1/crops").mock(
        return_value=Response(
            200,
            json={
                "data": [
                    {
                        "attributes": {
                            "name": "Monstera deliciosa",
                            "binomial_name": "Monstera deliciosa",
                            "sun_requirements": "Partial shade",
                            "description": "Tropical vine",
                            "temperature_minimum": 18,
                            "temperature_maximum": 29,
                            "ph_minimum": 5.5,
                            "ph_maximum": 7.0,
                        }
                    }
                ]
            },
        )
    )

    response = client.get("/api/v1/plants/details", params={"name": "Monstera deliciosa"})
    assert response.status_code == 200
    body = response.json()
    assert body["scientific_name"] == "Monstera deliciosa"
    assert body["care"]["level"] == "species"
    assert body["care"]["light"].startswith("Partial")

    settings.trefle_token = None
    _clear_lookup_cache()


def test_create_smart_pot_auto_detect(client: TestClient):
    created = client.post(
        "/api/v1/plants",
        json={
            "nickname": "Office Monstera",
            "species": "Monstera deliciosa",
            "location_type": "smart_pot",
            "image_data": None,
        },
    )
    assert created.status_code == 201
    body = created.json()
    assert body["pot_model"] is not None
    assert body["ideal_conditions"]["light"].lower().startswith("bright")

    listing = client.get("/api/v1/plants")
    assert listing.status_code == 200
    records = listing.json()
    assert any(item["nickname"] == "Office Monstera" for item in records)


def test_create_garden_plant_with_zone(client: TestClient):
    zones = client.get("/api/v1/plants/zones").json()
    assert zones
    zone_id = zones[0]["id"]
    created = client.post(
        "/api/v1/plants",
        json={
            "nickname": "Raised Bed Basil",
            "species": "Ocimum basilicum",
            "location_type": "garden",
            "irrigation_zone_id": zone_id,
        },
    )
    assert created.status_code == 201
    body = created.json()
    assert body["irrigation_zone_id"] == zone_id
    assert body["ideal_conditions"]["temperature_c"] == [18.0, 30.0]