from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass(slots=True)
class PlantReference:
    species: str
    common_name: str
    light: str
    water: str
    humidity: str
    temperature_c: tuple[float, float]
    ph_range: tuple[float, float]
    notes: str = ""


@dataclass(slots=True)
class PlantRecord:
    id: int
    nickname: str
    species: str
    common_name: str
    location_type: str
    pot_model: str | None
    irrigation_zone_id: str | None
    taxonomy: dict[str, str] = field(default_factory=dict)
    summary: str | None = None
    image_url: str | None = None
    ideal_conditions: dict[str, object] = field(default_factory=dict)
    care_level: str = "custom"
    care_source: str | None = None
    care_warning: str | None = None
    image_data: str | None = None


@dataclass(slots=True)
class PotModel:
    id: str
    name: str
    volume_l: float
    features: list[str] = field(default_factory=list)


@dataclass(slots=True)
class IrrigationZone:
    id: str
    name: str
    description: str
    coverage_sq_ft: float


class PlantCatalog:
    def __init__(self) -> None:
        self._references: list[PlantReference] = _default_references()
        self._pot_models: list[PotModel] = _default_pot_models()
        self._zones: list[IrrigationZone] = _default_zones()
        self._records: list[PlantRecord] = []
        self._next_id = 1

    def list_pot_models(self) -> list[PotModel]:
        return list(self._pot_models)

    def list_zones(self) -> list[IrrigationZone]:
        return list(self._zones)

    def detect_pot(self) -> PotModel:
        # Placeholder detection: return the first model with simple rotation
        if not self._pot_models:
            raise RuntimeError("No smart pot models configured")
        index = (self._next_id - 1) % len(self._pot_models)
        return self._pot_models[index]

    def search_references(self, query: Optional[str] = None) -> list[PlantReference]:
        if not query:
            return list(self._references)
        lowered = query.strip().lower()
        results = [
            ref
            for ref in self._references
            if lowered in ref.species.lower() or lowered in ref.common_name.lower()
        ]
        return results

    def resolve_reference(self, species: str) -> PlantReference | None:
        lowered = species.lower()
        for ref in self._references:
            if ref.species.lower() == lowered:
                return ref
        for ref in self._references:
            if lowered in ref.species.lower() or lowered in ref.common_name.lower():
                return ref
        return None

    def add_record(
        self,
        *,
        nickname: str,
        species: str,
        location_type: str,
        pot_model: str | None,
        irrigation_zone_id: str | None,
        image_data: str | None,
        care_profile: dict[str, object] | None = None,
        care_level: str = "custom",
        care_source: str | None = None,
        care_warning: str | None = None,
        taxonomy: dict[str, str] | None = None,
        summary: str | None = None,
        image_url: str | None = None,
    ) -> PlantRecord:
        reference = self.resolve_reference(species)
        if location_type == "smart_pot" and not pot_model:
            detected = self.detect_pot()
            pot_model = detected.id
        ideal = _build_conditions(reference)
        if care_profile:
            ideal.update({
                "light": care_profile.get("light", ideal["light"]),
                "water": care_profile.get("water", ideal["water"]),
                "humidity": care_profile.get("humidity", ideal.get("humidity", "Average indoor humidity")),
                "temperature_c": care_profile.get("temperature_c", ideal.get("temperature_c", (18.0, 26.0))),
                "ph_range": care_profile.get("ph_range", ideal.get("ph_range", (6.0, 7.0))),
                "notes": care_profile.get("notes", ideal.get("notes", "")),
            })
            if care_profile.get("warning"):
                care_warning = str(care_profile["warning"])
            if care_profile.get("source") and not care_source:
                care_source = str(care_profile["source"])
            if care_profile.get("level"):
                care_level = str(care_profile["level"])
        record = PlantRecord(
            id=self._next_id,
            nickname=nickname or species,
            species=species,
            common_name=(reference.common_name if reference else species),
            location_type=location_type,
            pot_model=pot_model,
            irrigation_zone_id=irrigation_zone_id,
            taxonomy=taxonomy or {},
            summary=summary,
            image_url=image_url,
            ideal_conditions=ideal,
            care_level=care_level,
            care_source=care_source,
            care_warning=care_warning,
            image_data=image_data,
        )
        self._records.append(record)
        self._next_id += 1
        return record

    def list_records(self) -> list[PlantRecord]:
        return list(self._records)


def _build_conditions(ref: PlantReference | None) -> dict[str, object]:
    if not ref:
        return {
            "light": "Bright indirect",
            "water": "Keep evenly moist",
            "humidity": "40-60%",
            "temperature_c": (18.0, 26.0),
            "ph_range": (6.0, 7.0),
            "notes": "Baseline recommendation; adjust based on plant response.",
        }
    return {
        "light": ref.light,
        "water": ref.water,
        "humidity": ref.humidity,
        "temperature_c": ref.temperature_c,
        "ph_range": ref.ph_range,
        "notes": ref.notes,
    }


# default reference data truncated for brevity


def _default_references() -> list[PlantReference]:
    return [
        PlantReference(
            species="Monstera deliciosa",
            common_name="Swiss Cheese Plant",
            light="Bright indirect light",
            water="Allow top 2-3 cm of soil to dry",
            humidity="60-80%",
            temperature_c=(18.0, 29.0),
            ph_range=(5.5, 7.0),
            notes="Prefers chunky, well-draining substrate; avoid cold drafts.",
        ),
        PlantReference(
            species="Ficus lyrata",
            common_name="Fiddle Leaf Fig",
            light="Bright filtered light",
            water="Water when top 5 cm are dry",
            humidity="40-60%",
            temperature_c=(16.0, 27.0),
            ph_range=(6.0, 7.0),
            notes="Rotate weekly for even growth; dislikes sudden moves.",
        ),
        PlantReference(
            species="Ocimum basilicum",
            common_name="Basil",
            light="Full sun (6+ hours)",
            water="Keep soil consistently moist but not soggy",
            humidity="40-60%",
            temperature_c=(18.0, 30.0),
            ph_range=(5.5, 6.5),
            notes="Pinch tops to encourage bushy growth; frost sensitive.",
        ),
        PlantReference(
            species="Solanum lycopersicum",
            common_name="Tomato",
            light="Full sun (6-8 hours)",
            water="Deeply water 2-3 times per week",
            humidity="50-70%",
            temperature_c=(20.0, 28.0),
            ph_range=(6.2, 6.8),
            notes="Support vines and ensure good air flow to reduce disease.",
        ),
    ]


def _default_pot_models() -> list[PotModel]:
    return [
        PotModel(id="smartpot-mini", name="SmartPot Mini", volume_l=2.5, features=["Capacitive moisture", "LED strip"]),
        PotModel(id="smartpot-midi", name="SmartPot Midi", volume_l=4.0, features=["Weight cell", "Fan assist"]),
        PotModel(id="smartpot-pro", name="SmartPot Pro", volume_l=7.5, features=["Multi-sensor", "Root temp probe"]),
    ]


def _default_zones() -> list[IrrigationZone]:
    return [
        IrrigationZone(id="zone-1", name="Front Garden Drip", description="Drip loop along front beds", coverage_sq_ft=120.0),
        IrrigationZone(id="zone-2", name="Back Lawn Spray", description="Rotor heads covering backyard", coverage_sq_ft=450.0),
        IrrigationZone(id="zone-3", name="Raised Beds", description="Soaker hose in raised vegetable beds", coverage_sq_ft=80.0),
    ]


plant_catalog = PlantCatalog()