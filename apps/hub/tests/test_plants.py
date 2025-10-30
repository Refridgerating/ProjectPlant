
from __future__ import annotations

from typing import Any, Sequence

from fastapi.testclient import TestClient
from httpx import Response

TREFLE_SEARCH_URL = "https://trefle.io/api/v1/plants/search"
POWO_SEARCH_URL = "https://powo.science.kew.org/api/2/search"
INAT_TAXA_URL = "https://api.inaturalist.org/v1/taxa"
OPENFARM_CROPS_URL = "https://openfarm.cc/api/v1/crops"


def _stub_trefle(respx_mock, entries: Sequence[dict[str, Any]] | None = None, status: int = 200) -> None:
    respx_mock.get(TREFLE_SEARCH_URL).mock(
        return_value=Response(status, json={"data": list(entries or [])})
    )


def _stub_powo(respx_mock, results: Sequence[dict[str, Any]] | None = None, status: int = 200) -> None:
    respx_mock.get(POWO_SEARCH_URL).mock(
        return_value=Response(status, json={"results": list(results or [])})
    )


def _stub_inat(respx_mock, results: Sequence[dict[str, Any]] | None = None, status: int = 200) -> None:
    respx_mock.get(INAT_TAXA_URL).mock(
        return_value=Response(status, json={"results": list(results or [])})
    )


def _stub_openfarm(respx_mock, crops: Sequence[dict[str, Any]] | None = None, status: int = 200) -> None:
    respx_mock.get(OPENFARM_CROPS_URL).mock(
        return_value=Response(status, json={"data": list(crops or [])})
    )


def test_reference_search(client: TestClient) -> None:
    response = client.get("/api/v1/plants/reference", params={"search": "monstera"})
    assert response.status_code == 200
    payload = response.json()
    assert payload
    entry = payload[0]
    assert entry["species"].lower().startswith("monstera")
    assert "light" in entry


def test_suggest_plants_remote_and_local(
    client: TestClient, respx_mock, settings_override
) -> None:
    settings_override(trefle_token="test-token")
    _stub_trefle(
        respx_mock,
        entries=[
            {
                "scientific_name": "Monstera deliciosa",
                "common_name": "Swiss cheese plant",
                "image_url": "https://img/monstera.jpg",
                "rank": "species",
                "bibliography": "Araceae",
            }
        ],
    )
    _stub_powo(respx_mock, results=[])
    _stub_inat(
        respx_mock,
        results=[
            {
                "name": "Monstera",
                "rank": "genus",
                "iconic_taxon_name": "Plantae",
                "preferred_common_name": "monstera",
                "default_photo": {"medium_url": "https://img/inat_monstera.jpg"},
            }
        ],
    )

    response = client.get("/api/v1/plants/suggest", params={"query": "Monstera"})
    assert response.status_code == 200
    data = response.json()
    sources = {item["source"] for item in data}
    assert {"trefle", "local", "inaturalist"}.issubset(sources)


def test_suggest_plants_common_name(client: TestClient, respx_mock, settings_override) -> None:
    settings_override(trefle_token=None)
    _stub_powo(respx_mock, results=[])
    _stub_inat(
        respx_mock,
        results=[
            {
                "name": "Viola",
                "rank": "genus",
                "iconic_taxon_name": "Plantae",
                "preferred_common_name": "violets",
                "default_photo": {"medium_url": "https://img/violets.jpg"},
            }
        ],
    )

    response = client.get("/api/v1/plants/suggest", params={"query": "violet"})
    assert response.status_code == 200
    payload = response.json()
    assert payload
    viola_entry = next(item for item in payload if item["scientific_name"] == "Viola")
    assert viola_entry["common_name"] == "violets"
    assert viola_entry["source"] == "inaturalist"


def test_details_endpoint_with_openfarm(
    client: TestClient, respx_mock, settings_override
) -> None:
    settings_override(trefle_token="test-token")
    _stub_trefle(
        respx_mock,
        entries=[
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
        ],
    )
    _stub_powo(
        respx_mock,
        results=[
            {
                "name": "Monstera deliciosa",
                "family": "Araceae",
                "rank": "species",
                "mainCommonName": "Swiss cheese plant",
                "thumbnail": "https://img/powo.jpg",
                "synonyms": [{"name": "Philodendron pertusum"}],
                "distribution": {"native": [{"name": "Mexico"}, {"name": "Guatemala"}]},
                "summary": "Climbing evergreen",
            }
        ],
    )
    _stub_openfarm(
        respx_mock,
        crops=[
            {
                "attributes": {
                    "name": "Monstera deliciosa",
                    "binomial_name": "Monstera deliciosa",
                    "sun_requirements": "Partial shade",
                    "description": "Tropical vine",
                    "soil": "Aroid mix rich in organic matter",
                    "spacing": 45,
                    "life_cycle": "perennial",
                    "temperature_minimum": 18,
                    "temperature_maximum": 29,
                    "ph_minimum": 5.5,
                    "ph_maximum": 7.0,
                }
            }
        ],
    )

    detail = client.get("/api/v1/plants/details", params={"name": "Monstera deliciosa"})
    assert detail.status_code == 200
    body = detail.json()
    assert body["scientific_name"] == "Monstera deliciosa"
    care = body["care"]
    assert care["level"] == "species"
    assert care["light"].startswith("Partial")
    assert care["soil"] == "Aroid mix rich in organic matter"


def test_search_endpoint_merges_sources(client: TestClient, respx_mock, settings_override) -> None:
    settings_override(trefle_token="test-token")
    _stub_trefle(
        respx_mock,
        entries=[
            {
                "scientific_name": "Monstera deliciosa",
                "common_name": "Swiss cheese plant",
                "image_url": "https://img/monstera.jpg",
                "rank": "species",
            }
        ],
    )
    _stub_powo(
        respx_mock,
        results=[
            {
                "name": "Monstera deliciosa",
                "rank": "species",
                "mainCommonName": "Swiss cheese plant",
            }
        ],
    )
    _stub_inat(
        respx_mock,
        results=[
            {
                "name": "Monstera",
                "rank": "genus",
                "preferred_common_name": "monstera",
                "default_photo": {"medium_url": "https://img/inat_monstera.jpg"},
            }
        ],
    )

    response = client.get("/api/search", params={"q": "Monstera"})
    assert response.status_code == 200
    payload = response.json()
    assert payload
    assert payload[0]["id"] == "monstera-deliciosa"
    assert any("trefle" in item["sources"] for item in payload)
    assert any("powo" in item["sources"] for item in payload)
    assert any("inaturalist" in item["sources"] for item in payload)


def test_plant_profile_endpoint_includes_openfarm_fields(
    client: TestClient, respx_mock, settings_override
) -> None:
    settings_override(trefle_token="test-token")
    trefle_response = {
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
    powo_response = {
        "name": "Monstera deliciosa",
        "family": "Araceae",
        "rank": "species",
        "mainCommonName": "Swiss cheese plant",
        "thumbnail": "https://img/powo.jpg",
        "synonyms": [{"name": "Philodendron pertusum"}],
        "distribution": {"native": [{"name": "Mexico"}, {"name": "Guatemala"}]},
        "summary": "Climbing evergreen",
    }
    _stub_trefle(respx_mock, entries=[trefle_response])
    _stub_powo(respx_mock, results=[powo_response])
    _stub_inat(respx_mock, results=[])
    _stub_openfarm(
        respx_mock,
        crops=[
            {
                "attributes": {
                    "name": "Monstera deliciosa",
                    "binomial_name": "Monstera deliciosa",
                    "sun_requirements": "Partial shade",
                    "description": "Tropical vine",
                    "soil": "Aroid mix rich in organic matter",
                    "spacing": 45,
                    "life_cycle": "perennial",
                    "temperature_minimum": 18,
                    "temperature_maximum": 29,
                    "ph_minimum": 5.5,
                    "ph_maximum": 7.0,
                }
            }
        ],
    )

    search = client.get("/api/search", params={"q": "Monstera"})
    assert search.status_code == 200
    plant_id = search.json()[0]["id"]

    detail = client.get(f"/api/plants/{plant_id}")
    assert detail.status_code == 200
    payload = detail.json()
    care = payload["care"]
    assert care["soil"] == "Aroid mix rich in organic matter"
    assert care["spacing"] == "45 cm"
    assert care["lifecycle"] == "perennial"
    assert payload["sources"]


def test_create_smart_pot_auto_detect(client: TestClient) -> None:
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


def test_create_garden_plant_with_zone(client: TestClient) -> None:
    zones = client.get("/api/v1/plants/zones").json()
    assert zones
    first_zone = zones[0]
    assert {"irrigation_type", "sun_exposure", "slope", "planting_type", "coverage_sq_ft"}.issubset(first_zone.keys())
    assert first_zone["irrigation_type"] in {"drip", "spray"}
    assert first_zone["sun_exposure"] in {"full_sun", "part_sun", "shade"}
    assert isinstance(first_zone["slope"], bool)
    zone_id = first_zone["id"]
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


def test_create_irrigation_zone(client: TestClient) -> None:
    payload = {
        "name": "Back patio planters",
        "irrigation_type": "drip",
        "sun_exposure": "shade",
        "slope": False,
        "planting_type": "flower_bed",
        "coverage_sq_ft": 42.0,
        "description": "Drip loop under patio pergola planters",
    }
    response = client.post("/api/v1/plants/zones", json=payload)
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == payload["name"]
    assert body["irrigation_type"] == payload["irrigation_type"]
    assert body["sun_exposure"] == payload["sun_exposure"]
    assert body["slope"] is False
    assert body["planting_type"] == payload["planting_type"]
    assert body["coverage_sq_ft"] == payload["coverage_sq_ft"]
    assert body["description"] == payload["description"]

    listing = client.get("/api/v1/plants/zones").json()
    assert any(item["id"] == body["id"] for item in listing)


def test_update_irrigation_zone(client: TestClient) -> None:
    created = client.post(
        "/api/v1/plants/zones",
        json={
            "name": "Veggie beds",
            "irrigation_type": "drip",
            "sun_exposure": "full_sun",
            "slope": False,
            "planting_type": "flower_bed",
            "coverage_sq_ft": 64,
            "description": "Raised beds with drip tape",
        },
    )
    assert created.status_code == 201
    zone_id = created.json()["id"]

    updated = client.put(
        f"/api/v1/plants/zones/{zone_id}",
        json={
            "name": "Veggie beds north",
            "irrigation_type": "spray",
            "sun_exposure": "part_sun",
            "slope": True,
            "planting_type": "flower_bed",
            "coverage_sq_ft": 72,
            "description": "Converted to micro sprays on slope",
        },
    )
    assert updated.status_code == 200
    payload = updated.json()
    assert payload["id"] == zone_id
    assert payload["name"] == "Veggie beds north"
    assert payload["irrigation_type"] == "spray"
    assert payload["sun_exposure"] == "part_sun"
    assert payload["slope"] is True
    assert payload["coverage_sq_ft"] == 72
    assert payload["description"].startswith("Converted")


def test_delete_irrigation_zone_clears_plants(client: TestClient) -> None:
    zone = client.post(
        "/api/v1/plants/zones",
        json={
            "name": "Orchard emitters",
            "irrigation_type": "drip",
            "sun_exposure": "full_sun",
            "slope": False,
            "planting_type": "trees",
            "coverage_sq_ft": 180,
            "description": "Drip loops for dwarf fruit trees",
        },
    ).json()

    created_plant = client.post(
        "/api/v1/plants",
        json={
            "nickname": "Apple row",
            "species": "Malus domestica",
            "location_type": "garden",
            "irrigation_zone_id": zone["id"],
        },
    )
    assert created_plant.status_code == 201

    deleted = client.delete(f"/api/v1/plants/zones/{zone['id']}")
    assert deleted.status_code == 204

    zones_after = client.get("/api/v1/plants/zones").json()
    assert all(item["id"] != zone["id"] for item in zones_after)

    plants_after = client.get("/api/v1/plants").json()
    garden = next(item for item in plants_after if item["nickname"] == "Apple row")
    assert garden["irrigation_zone_id"] is None
