from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from typing import Dict, List, Tuple

from config import settings
from services.plant_lookup import (
    PlantCareProfile,
    PlantDetails,
    PlantLookupService,
    plant_lookup_service,
)


@dataclass(slots=True)
class AggregatedPlantSuggestion:
    id: str
    scientific_name: str
    common_name: str | None
    rank: str | None
    summary: str | None
    image_url: str | None
    sources: list[str]


@dataclass(slots=True)
class AggregatedPlantProfile:
    id: str
    scientific_name: str
    common_name: str | None
    family: str | None
    genus: str | None
    rank: str | None
    summary: str | None
    taxonomy: dict[str, str]
    distribution: list[str]
    synonyms: list[str]
    image_url: str | None
    images: list[str]
    sources: list[str]
    care: PlantCareProfile


class PlantAggregatorService:
    def __init__(self, lookup_service: PlantLookupService) -> None:
        self._lookup_service = lookup_service
        self._details_cache: Dict[str, Tuple[float, AggregatedPlantProfile]] = {}
        self._slug_map: Dict[str, str] = {}
        self._lock = asyncio.Lock()
        self._cache_ttl = settings.plant_lookup_cache_ttl

    async def search(self, query: str) -> list[AggregatedPlantSuggestion]:
        term = query.strip()
        if len(term) < 2:
            return []
        suggestions = await self._lookup_service.suggest(term)
        combined: Dict[str, AggregatedPlantSuggestion] = {}
        order: List[str] = []
        for entry in suggestions:
            scientific = entry.scientific_name.strip()
            if not scientific:
                continue
            slug = self._slugify(scientific)
            existing = combined.get(slug)
            if existing is None:
                suggestion = AggregatedPlantSuggestion(
                    id=slug,
                    scientific_name=scientific,
                    common_name=entry.common_name,
                    rank=entry.rank,
                    summary=entry.summary,
                    image_url=entry.image_url,
                    sources=list(entry.sources),
                )
                combined[slug] = suggestion
                order.append(slug)
            else:
                if entry.common_name and not existing.common_name:
                    existing.common_name = entry.common_name
                if entry.rank and not existing.rank:
                    existing.rank = entry.rank
                if entry.summary and not existing.summary:
                    existing.summary = entry.summary
                if entry.image_url and not existing.image_url:
                    existing.image_url = entry.image_url
                for source in entry.sources:
                    if source not in existing.sources:
                        existing.sources.append(source)
            self._slug_map[slug] = scientific
        return [combined[key] for key in order]

    async def get_profile(self, plant_id: str) -> AggregatedPlantProfile:
        slug = plant_id.strip().lower()
        if not slug:
            raise ValueError("Plant identifier is required")
        now = time.monotonic()
        cached = self._details_cache.get(slug)
        if cached and cached[0] > now:
            return cached[1]
        async with self._lock:
            cached = self._details_cache.get(slug)
            if cached and cached[0] > now:
                return cached[1]
            scientific = self._slug_map.get(slug) or self._unslugify(slug)
            try:
                detail = await self._lookup_service.details(scientific)
            except Exception as exc:
                raise LookupError(f"Plant profile unavailable for '{scientific}'") from exc
            profile = self._to_profile(detail)
            resolved_slug = profile.id
            self._slug_map[slug] = detail.scientific_name
            self._slug_map[resolved_slug] = detail.scientific_name
            if self._cache_ttl > 0:
                expires = now + self._cache_ttl
                self._details_cache[resolved_slug] = (expires, profile)
                self._details_cache[slug] = (expires, profile)
            return profile

    def clear(self) -> None:
        self._details_cache.clear()
        self._slug_map.clear()

    def _to_profile(self, detail: PlantDetails) -> AggregatedPlantProfile:
        return AggregatedPlantProfile(
            id=self._slugify(detail.scientific_name),
            scientific_name=detail.scientific_name,
            common_name=detail.common_name,
            family=detail.family,
            genus=detail.genus,
            rank=detail.rank,
            summary=detail.summary,
            taxonomy=detail.taxonomy,
            distribution=detail.distribution,
            synonyms=detail.synonyms,
            image_url=detail.image_url,
            images=detail.images,
            sources=detail.sources,
            care=detail.care,
        )

    @staticmethod
    def _slugify(name: str) -> str:
        lowered = name.strip().lower()
        normalized = re.sub(r"[^a-z0-9]+", "-", lowered)
        return normalized.strip("-") or "plant"

    @staticmethod
    def _unslugify(slug: str) -> str:
        text = slug.replace("-", " ")
        return text


plant_aggregator_service = PlantAggregatorService(plant_lookup_service)
