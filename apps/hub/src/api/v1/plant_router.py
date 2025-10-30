from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field

from services.plant_lookup import PlantCareProfile, PlantDetails, PlantSuggestion, plant_lookup_service
from services.plants import (
    CatalogNotFoundError,
    CatalogPermissionError,
    IrrigationZone,
    PlantRecord,
    PlantReference,
    PotModel,
    ShareRole,
    UserAccount,
    plant_catalog,
)
from .dependencies import get_current_user

router = APIRouter(prefix="/plants", tags=["plants"])


class CareProfileModel(BaseModel):
    light: str
    water: str
    humidity: str
    temperature_c: tuple[float, float]
    ph_range: tuple[float, float]
    notes: str | None = None
    level: Literal["species", "genus", "custom"] = "species"
    source: str | None = None
    warning: str | None = None
    allow_user_input: bool | None = None
    soil: str | None = None
    spacing: str | None = None
    lifecycle: str | None = None


class PlantSuggestionModel(BaseModel):
    scientific_name: str
    common_name: str | None = None
    source: str
    rank: str | None = None
    image_url: str | None = None
    summary: str | None = None
    sources: list[str] | None = None


class PlantReferenceModel(BaseModel):
    species: str
    common_name: str
    light: str
    water: str
    humidity: str
    temperature_c: tuple[float, float]
    ph_range: tuple[float, float]
    notes: str


class PotModelModel(BaseModel):
    id: str
    name: str
    volume_l: float
    features: list[str]
    owner_user_id: str
    access_role: ShareRole


class IrrigationZoneModel(BaseModel):
    id: str
    name: str
    irrigation_type: Literal["drip", "spray"]
    sun_exposure: Literal["full_sun", "part_sun", "shade"]
    slope: bool
    planting_type: Literal["lawn", "flower_bed", "ground_cover", "trees"]
    coverage_sq_ft: float
    description: str = ""
    owner_user_id: str
    access_role: ShareRole


class PlantDetailsModel(BaseModel):
    scientific_name: str
    common_name: str | None = None
    family: str | None = None
    genus: str | None = None
    rank: str | None = None
    synonyms: list[str]
    distribution: list[str]
    summary: str | None = None
    taxonomy: dict[str, str]
    image_url: str | None = None
    images: list[str]
    care: CareProfileModel
    sources: list[str]


class PlantResponse(BaseModel):
    id: int
    nickname: str
    species: str
    common_name: str
    location_type: Literal["smart_pot", "garden"]
    pot_model: str | None
    irrigation_zone_id: str | None
    taxonomy: dict[str, str]
    summary: str | None
    image_url: str | None
    ideal_conditions: CareProfileModel
    care_level: Literal["species", "genus", "custom"]
    care_source: str | None = None
    care_warning: str | None = None
    image_data: str | None = None
    owner_user_id: str
    access_role: ShareRole


class PlantCreateRequest(BaseModel):
    nickname: str = Field(default="", max_length=80)
    species: str = Field(..., max_length=120)
    location_type: Literal["smart_pot", "garden"]
    pot_model: Optional[str] = None
    irrigation_zone_id: Optional[str] = None
    image_data: Optional[str] = Field(default=None, description="Data URL or remote image reference")
    taxonomy: dict[str, str] | None = None
    summary: str | None = None
    image_url: str | None = None
    care_profile: CareProfileModel | None = None


class IrrigationZoneCreateRequest(BaseModel):
    name: str = Field(..., max_length=80)
    irrigation_type: Literal["drip", "spray"]
    sun_exposure: Literal["full_sun", "part_sun", "shade"]
    slope: bool
    planting_type: Literal["lawn", "flower_bed", "ground_cover", "trees"]
    coverage_sq_ft: float = Field(default=0.0, ge=0.0)
    description: str | None = Field(default=None, max_length=200)


@router.get("/reference", response_model=list[PlantReferenceModel])
async def list_references(search: str | None = None) -> list[PlantReferenceModel]:
    references = plant_catalog.search_references(search)
    return [_to_reference_model(ref) for ref in references]


@router.get("/suggest", response_model=list[PlantSuggestionModel])
async def suggest_plants(query: str = Query(..., min_length=2, description="Search term for plant lookup")) -> list[PlantSuggestionModel]:
    remote = await plant_lookup_service.suggest(query)
    suggestions: list[PlantSuggestionModel] = [_to_suggestion_model(item) for item in remote]
    local_refs = plant_catalog.search_references(query)
    local_seen: set[str] = set()
    for ref in local_refs:
        key = ref.species.lower()
        if key in local_seen:
            continue
        suggestions.append(
            PlantSuggestionModel(
                scientific_name=ref.species,
                common_name=ref.common_name,
                source="local",
                summary=ref.notes,
            )
        )
        local_seen.add(key)
    return suggestions[:15]


@router.get("/details", response_model=PlantDetailsModel)
async def get_details(name: str = Query(..., description="Scientific name to resolve")) -> PlantDetailsModel:
    try:
        detail = await plant_lookup_service.details(name)
    except RuntimeError as exc:  # pragma: no cover - networks stubbed in tests
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _to_details_model(detail)


@router.get("/pots", response_model=list[PotModelModel])
async def list_pot_models(current_user: UserAccount = Depends(get_current_user)) -> list[PotModelModel]:
    models = plant_catalog.list_pot_models(current_user.id)
    return [
        _to_pot_model(model, plant_catalog.role_for(current_user.id, model.owner_user_id))
        for model in models
    ]


@router.get("/zones", response_model=list[IrrigationZoneModel])
async def list_irrigation_zones(current_user: UserAccount = Depends(get_current_user)) -> list[IrrigationZoneModel]:
    zones = plant_catalog.list_zones(current_user.id)
    return [
        _to_zone_model(zone, plant_catalog.role_for(current_user.id, zone.owner_user_id))
        for zone in zones
    ]


@router.post("/zones", response_model=IrrigationZoneModel, status_code=status.HTTP_201_CREATED)
async def create_irrigation_zone(
    payload: IrrigationZoneCreateRequest,
    current_user: UserAccount = Depends(get_current_user),
) -> IrrigationZoneModel:
    zone = plant_catalog.add_zone(
        current_user.id,
        name=payload.name,
        irrigation_type=payload.irrigation_type,
        sun_exposure=payload.sun_exposure,
        slope=payload.slope,
        planting_type=payload.planting_type,
        coverage_sq_ft=payload.coverage_sq_ft,
        description=payload.description,
    )
    return _to_zone_model(zone, plant_catalog.role_for(current_user.id, zone.owner_user_id))


@router.put("/zones/{zone_id}", response_model=IrrigationZoneModel)
async def update_irrigation_zone(
    zone_id: str,
    payload: IrrigationZoneCreateRequest,
    current_user: UserAccount = Depends(get_current_user),
) -> IrrigationZoneModel:
    try:
        zone = plant_catalog.update_zone(
            current_user.id,
            zone_id=zone_id,
            name=payload.name,
            irrigation_type=payload.irrigation_type,
            sun_exposure=payload.sun_exposure,
            slope=payload.slope,
            planting_type=payload.planting_type,
            coverage_sq_ft=payload.coverage_sq_ft,
            description=payload.description,
        )
    except CatalogNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except CatalogPermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    return _to_zone_model(zone, plant_catalog.role_for(current_user.id, zone.owner_user_id))


@router.delete("/zones/{zone_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_irrigation_zone(
    zone_id: str,
    current_user: UserAccount = Depends(get_current_user),
) -> Response:
    try:
        plant_catalog.remove_zone(current_user.id, zone_id)
    except CatalogNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except CatalogPermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/detect-pot", response_model=PotModelModel)
async def detect_pot(current_user: UserAccount = Depends(get_current_user)) -> PotModelModel:
    try:
        model = plant_catalog.detect_pot(current_user.id)
    except CatalogNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return _to_pot_model(model, plant_catalog.role_for(current_user.id, model.owner_user_id))


@router.get("", response_model=list[PlantResponse])
async def list_plants(current_user: UserAccount = Depends(get_current_user)) -> list[PlantResponse]:
    records = plant_catalog.list_records(current_user.id)
    return [
        _to_plant_response(record, plant_catalog.role_for(current_user.id, record.owner_user_id))
        for record in records
    ]


@router.post("", response_model=PlantResponse, status_code=status.HTTP_201_CREATED)
async def create_plant(
    payload: PlantCreateRequest,
    current_user: UserAccount = Depends(get_current_user),
) -> PlantResponse:
    care_profile_dict = payload.care_profile.model_dump() if payload.care_profile else None
    care_level = payload.care_profile.level if payload.care_profile else "custom"
    care_source = payload.care_profile.source if payload.care_profile else None
    care_warning = payload.care_profile.warning if payload.care_profile else None

    try:
        record = plant_catalog.add_record(
            current_user.id,
            nickname=payload.nickname,
            species=payload.species,
            location_type=payload.location_type,
            pot_model=payload.pot_model,
            irrigation_zone_id=payload.irrigation_zone_id,
            image_data=payload.image_data,
            care_profile=care_profile_dict,
            care_level=care_level,
            care_source=care_source,
            care_warning=care_warning,
            taxonomy=payload.taxonomy,
            summary=payload.summary,
            image_url=payload.image_url,
        )
    except CatalogNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except CatalogPermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    return _to_plant_response(record, plant_catalog.role_for(current_user.id, record.owner_user_id))


def _to_reference_model(ref: PlantReference) -> PlantReferenceModel:
    return PlantReferenceModel(
        species=ref.species,
        common_name=ref.common_name,
        light=ref.light,
        water=ref.water,
        humidity=ref.humidity,
        temperature_c=ref.temperature_c,
        ph_range=ref.ph_range,
        notes=ref.notes,
    )


def _to_suggestion_model(item: PlantSuggestion) -> PlantSuggestionModel:
    return PlantSuggestionModel(
        scientific_name=item.scientific_name,
        common_name=item.common_name,
        source=item.source,
        rank=item.rank,
        image_url=item.image_url,
        summary=item.summary,
        sources=list(item.sources),
    )


def _to_details_model(detail: PlantDetails) -> PlantDetailsModel:
    return PlantDetailsModel(
        scientific_name=detail.scientific_name,
        common_name=detail.common_name,
        family=detail.family,
        genus=detail.genus,
        rank=detail.rank,
        synonyms=detail.synonyms,
        distribution=detail.distribution,
        summary=detail.summary,
        taxonomy=detail.taxonomy,
        image_url=detail.image_url,
        images=list(detail.images),
        care=_to_care_model(detail.care),
        sources=detail.sources,
    )


def _to_pot_model(model: PotModel, role: ShareRole) -> PotModelModel:
    return PotModelModel(
        id=model.id,
        name=model.name,
        volume_l=model.volume_l,
        features=list(model.features),
        owner_user_id=model.owner_user_id,
        access_role=role,
    )


def _to_zone_model(zone: IrrigationZone, role: ShareRole) -> IrrigationZoneModel:
    return IrrigationZoneModel(
        id=zone.id,
        name=zone.name,
        irrigation_type=zone.irrigation_type,
        sun_exposure=zone.sun_exposure,
        slope=zone.slope,
        planting_type=zone.planting_type,
        coverage_sq_ft=zone.coverage_sq_ft,
        description=zone.description,
        owner_user_id=zone.owner_user_id,
        access_role=role,
    )


def _to_care_model(care: PlantCareProfile) -> CareProfileModel:
    return CareProfileModel(
        light=care.light,
        water=care.water,
        humidity=care.humidity,
        temperature_c=care.temperature_c,
        ph_range=care.ph_range,
        notes=care.notes,
        level=care.level,  # type: ignore[arg-type]
        source=care.source,
        warning=care.warning,
        allow_user_input=care.allow_user_input,
        soil=care.soil,
        spacing=care.spacing,
        lifecycle=care.lifecycle,
    )


def _to_plant_response(record: PlantRecord, role: ShareRole) -> PlantResponse:
    care_model = CareProfileModel(
        light=str(record.ideal_conditions.get("light", "")),
        water=str(record.ideal_conditions.get("water", "")),
        humidity=str(record.ideal_conditions.get("humidity", "")),
        temperature_c=tuple(record.ideal_conditions.get("temperature_c", (18.0, 26.0))),
        ph_range=tuple(record.ideal_conditions.get("ph_range", (6.0, 7.0))),
        notes=record.ideal_conditions.get("notes"),
        level=record.care_level,  # type: ignore[arg-type]
        source=record.care_source,
        warning=record.care_warning,
    )
    return PlantResponse(
        id=record.id,
        nickname=record.nickname,
        species=record.species,
        common_name=record.common_name,
        location_type=record.location_type,  # type: ignore[arg-type]
        pot_model=record.pot_model,
        irrigation_zone_id=record.irrigation_zone_id,
        taxonomy=record.taxonomy,
        summary=record.summary,
        image_url=record.image_url,
        ideal_conditions=care_model,
        care_level=record.care_level,  # type: ignore[arg-type]
        care_source=record.care_source,
        care_warning=record.care_warning,
        image_data=record.image_data,
        owner_user_id=record.owner_user_id,
        access_role=role,
    )
