from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from services.plant_aggregator import (
    AggregatedPlantProfile,
    AggregatedPlantSuggestion,
    plant_aggregator_service,
)
from services.plant_lookup import PlantCareProfile

from .v1.plant_router import CareProfileModel

router = APIRouter(prefix="/api", tags=["plant-guides"])


class SearchSuggestionModel(BaseModel):
    id: str
    scientific_name: str
    common_name: str | None = None
    rank: str | None = None
    summary: str | None = None
    image_url: str | None = None
    sources: list[str]


class PlantGuideModel(BaseModel):
    id: str
    scientific_name: str
    common_name: str | None = None
    family: str | None = None
    genus: str | None = None
    rank: str | None = None
    summary: str | None = None
    taxonomy: dict[str, str]
    distribution: list[str]
    synonyms: list[str]
    image_url: str | None = None
    images: list[str]
    sources: list[str]
    care: CareProfileModel
    powo_id: str | None = None
    inat_id: int | None = None
    gbif_id: str | None = None
    care_profile_normalized: dict[str, Any] | None = None


@router.get("/search", response_model=list[SearchSuggestionModel])
async def search_plants(q: str = Query(..., min_length=2, description="Search term")) -> list[SearchSuggestionModel]:
    results = await plant_aggregator_service.search(q)
    return [_to_suggestion_model(item) for item in results]


@router.get("/plants/{plant_id}", response_model=PlantGuideModel)
async def get_plant_profile(plant_id: str) -> PlantGuideModel:
    try:
        profile = await plant_aggregator_service.get_profile(plant_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail="Plant not found") from exc
    return _to_guide_model(profile)


def _to_suggestion_model(item: AggregatedPlantSuggestion) -> SearchSuggestionModel:
    return SearchSuggestionModel(
        id=item.id,
        scientific_name=item.scientific_name,
        common_name=item.common_name,
        rank=item.rank,
        summary=item.summary,
        image_url=item.image_url,
        sources=item.sources,
    )


def _to_guide_model(profile: AggregatedPlantProfile) -> PlantGuideModel:
    return PlantGuideModel(
        id=profile.id,
        scientific_name=profile.scientific_name,
        common_name=profile.common_name,
        family=profile.family,
        genus=profile.genus,
        rank=profile.rank,
        summary=profile.summary,
        taxonomy=profile.taxonomy,
        distribution=profile.distribution,
        synonyms=profile.synonyms,
        image_url=profile.image_url,
        images=list(profile.images),
        sources=profile.sources,
        care=_to_care_model(profile.care),
        powo_id=profile.powo_id,
        inat_id=profile.inat_id,
        gbif_id=profile.gbif_id,
        care_profile_normalized=profile.care_profile_normalized,
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
