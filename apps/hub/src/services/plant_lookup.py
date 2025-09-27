from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

from config import settings

logger = logging.getLogger("projectplant.hub.plants.lookup")


_SUGGESTION_RANK_ORDER = {
    "species": 0,
    "subspecies": 1,
    "variety": 2,
    "form": 3,
    "genus": 4,
    "subgenus": 5,
    "section": 6,
    "family": 7,
}

_INAT_ALLOWED_RANKS = {"species", "subspecies", "variety", "form", "genus", "subgenus", "section"}




@dataclass(slots=True)
class PlantSuggestion:
    scientific_name: str
    common_name: str | None
    source: str
    rank: str | None = None
    image_url: str | None = None
    summary: str | None = None
    sources: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.sources:
            self.sources = [self.source]
        elif self.source not in self.sources:
            self.sources.insert(0, self.source)


@dataclass(slots=True)
class PlantCareProfile:
    light: str
    water: str
    humidity: str
    temperature_c: tuple[float, float]
    ph_range: tuple[float, float]
    notes: str | None
    level: str
    source: str | None
    warning: str | None = None
    allow_user_input: bool = False
    soil: str | None = None
    spacing: str | None = None
    lifecycle: str | None = None


@dataclass(slots=True)
class PlantDetails:
    scientific_name: str
    common_name: str | None
    family: str | None
    genus: str | None
    rank: str | None
    synonyms: list[str]
    distribution: list[str]
    summary: str | None
    taxonomy: dict[str, str]
    image_url: str | None
    images: list[str]
    care: PlantCareProfile
    sources: list[str]


class PlantLookupService:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._suggest_cache: dict[str, tuple[float, list[PlantSuggestion]]] = {}
        self._details_cache: dict[str, tuple[float, PlantDetails]] = {}
        self._lock = asyncio.Lock()
        self._cache_ttl = settings.plant_lookup_cache_ttl

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            headers = {"User-Agent": settings.weather_user_agent, "Accept": "application/json"}
            self._client = httpx.AsyncClient(timeout=settings.plant_lookup_timeout, headers=headers)
        return self._client

    async def suggest(self, query: str) -> list[PlantSuggestion]:
        term = query.strip()
        if len(term) < 3:
            return []
        key = term.lower()
        cached = self._suggest_cache.get(key)
        now = time.monotonic()
        if cached and cached[0] > now:
            logger.info('suggest cache hit (fast) for %%s', key)
            return cached[1]

        async with self._lock:
            cached = self._suggest_cache.get(key)
            if cached and cached[0] > now:
                logger.info('suggest cache hit (locked) for %%s', key)
                return cached[1]

            tasks = [
                self._powo_suggest(term),
                self._inat_suggest(term),
            ]
            if settings.trefle_token:
                tasks.append(self._trefle_suggest(term))
            try:
                responses = await asyncio.gather(*tasks, return_exceptions=True)
            except Exception as exc:  # pragma: no cover
                logger.warning("Plant suggestion lookup failed: %s", exc)
                responses = []

            suggestions: list[PlantSuggestion] = []
            for response in responses:
                if isinstance(response, Exception):
                    logger.debug("Suggestion source error: %s", response)
                    continue
                suggestions.extend(response)

            term_lower = term.lower()
            deduped: dict[str, PlantSuggestion] = {}
            for item in suggestions:
                key_name = item.scientific_name.lower()
                existing = deduped.get(key_name)
                if existing:
                    merged_sources = list(dict.fromkeys(existing.sources + item.sources))
                    if self._score_suggestion(item, term_lower) < self._score_suggestion(existing, term_lower):
                        item.sources = merged_sources
                        deduped[key_name] = item
                    else:
                        existing.sources = merged_sources
                else:
                    deduped[key_name] = item

            ordered = sorted(deduped.values(), key=lambda item: self._score_suggestion(item, term_lower))[:10]
            if self._cache_ttl > 0:
                self._suggest_cache[key] = (now + self._cache_ttl, ordered)
            return ordered

    def _score_suggestion(self, suggestion: PlantSuggestion, term_lower: str) -> tuple[int, int, int, int, int, str]:
        rank = (suggestion.rank or '').lower()
        rank_score = _SUGGESTION_RANK_ORDER.get(rank, 9)
        common_name = suggestion.common_name or ''
        common_match = 0 if term_lower and common_name.lower().find(term_lower) != -1 else 1
        scientific_match = 0 if term_lower in suggestion.scientific_name.lower() else 1
        missing_common = 0 if suggestion.common_name else 1
        missing_image = 0 if suggestion.image_url else 1
        return (
            rank_score,
            common_match,
            scientific_match,
            missing_common,
            missing_image,
            suggestion.scientific_name.lower(),
        )

    async def details(self, scientific_name: str) -> PlantDetails:
        key = scientific_name.strip()
        if not key:
            raise ValueError("Scientific name is required")
        cache_key = key.lower()
        now = time.monotonic()
        cached = self._details_cache.get(cache_key)
        if cached and cached[0] > now:
            return cached[1]

        async with self._lock:
            cached = self._details_cache.get(cache_key)
            if cached and cached[0] > now:
                return cached[1]

            trefle_data = None
            powo_data = None
            trefle_image: str | None = None
            powo_image: str | None = None
            sources: list[str] = []

            if settings.trefle_token:
                try:
                    trefle_data = await self._trefle_details(key)
                    if trefle_data:
                        sources.append("trefle")
                        trefle_image = trefle_data.get("image_url")
                except Exception as exc:
                    logger.debug("Trefle details failed for %s: %s", key, exc)

            try:
                powo_data = await self._powo_details(key)
                if powo_data:
                    sources.append("powo")
                    powo_image = powo_data.get("image_url")
            except Exception as exc:
                logger.debug("POWO details failed for %s: %s", key, exc)

            if not trefle_data and not powo_data:
                raise RuntimeError("No data found for specified plant")

            scientific = self._choose_value(key, trefle_data, powo_data, "scientific_name")
            common_name = self._choose_value(None, trefle_data, powo_data, "common_name")
            family = self._choose_value(None, trefle_data, powo_data, "family")
            genus = self._choose_value(None, trefle_data, powo_data, "genus")
            rank = self._choose_value(None, trefle_data, powo_data, "rank")
            summary = self._combine_summary(trefle_data, powo_data)
            synonyms = self._combine_list(trefle_data, powo_data, "synonyms")
            distribution = self._combine_list(trefle_data, powo_data, "distribution")
            taxonomy = {k: v for k, v in {
                "family": family,
                "genus": genus,
                "rank": rank,
            }.items() if v}

            images = self._merge_image_sources(powo_image, powo_data, trefle_data)
            if not images and trefle_image:
                images = self._merge_image_sources(trefle_image, trefle_data)
            image_url = images[0] if images else None

            care = await self._build_care_profile(scientific or key, genus or scientific)
            detail = PlantDetails(
                scientific_name=scientific or key,
                common_name=common_name,
                family=family,
                genus=genus,
                rank=rank,
                synonyms=synonyms,
                distribution=distribution,
                summary=summary,
                taxonomy=taxonomy,
                image_url=image_url,
                images=images,
                care=care,
                sources=sources,
            )
            if self._cache_ttl > 0:
                self._details_cache[cache_key] = (now + self._cache_ttl, detail)
            return detail

    async def _inat_suggest(self, query: str) -> list[PlantSuggestion]:
        params = {"q": query, "per_page": 8}
        client = await self._get_client()
        response = await client.get("https://api.inaturalist.org/v1/taxa", params=params)
        response.raise_for_status()
        payload = response.json()
        suggestions: list[PlantSuggestion] = []
        for item in payload.get("results", []):
            iconic = item.get("iconic_taxon_name")
            if iconic and str(iconic).lower() != "plantae":
                continue
            rank = (item.get("rank") or "").lower()
            if rank and rank not in _INAT_ALLOWED_RANKS:
                continue
            scientific = item.get("name")
            if not scientific:
                continue
            default_photo = item.get("default_photo") or {}
            image_url = default_photo.get("medium_url") or default_photo.get("square_url") or default_photo.get("url")
            suggestions.append(
                PlantSuggestion(
                    scientific_name=scientific,
                    common_name=item.get("preferred_common_name"),
                    source="inaturalist",
                    rank=rank or None,
                    image_url=self._normalize_image_url(image_url),
                    summary=None,
                )
            )
        return suggestions

    async def _trefle_suggest(self, query: str) -> list[PlantSuggestion]:
        params = {"q": query, "limit": 6, "token": settings.trefle_token}
        client = await self._get_client()
        response = await client.get(f"{settings.trefle_base_url}/plants/search", params=params)
        response.raise_for_status()
        payload = response.json()
        data = payload.get("data", [])
        suggestions: list[PlantSuggestion] = []
        for item in data:
            suggestions.append(
                PlantSuggestion(
                    scientific_name=item.get("scientific_name") or item.get("slug") or query,
                    common_name=item.get("common_name"),
                    source="trefle",
                    rank=item.get("rank"),
                    image_url=item.get("image_url"),
                    summary=item.get("bibliography"),
                )
            )
        return suggestions

    async def _powo_suggest(self, query: str) -> list[PlantSuggestion]:
        params = {"q": query, "perPage": 12}
        client = await self._get_client()
        response = await client.get(f"{settings.powo_base_url}/search", params=params)
        response.raise_for_status()
        payload = response.json()
        suggestions: list[PlantSuggestion] = []
        for item in payload.get("results", []):
            accepted = item.get("acceptedName") or {}
            scientific = (
                item.get("name")
                or accepted.get("scientificNameWithoutAuthor")
                or accepted.get("name")
            )
            if not scientific:
                continue
            common = (
                item.get("commonName")
                or item.get("mainCommonName")
                or accepted.get("commonName")
                or accepted.get("mainCommonName")
            )
            rank = item.get("rank") or accepted.get("rank")
            summary = item.get("summary") or item.get("briefDescription") or item.get("snippet")
            image_url = item.get("thumbnail")
            if not image_url:
                images = item.get("images")
                if isinstance(images, list) and images:
                    first_image = images[0]
                    image_url = first_image.get("thumbnail") or first_image.get("url")
            suggestions.append(
                PlantSuggestion(
                    scientific_name=scientific,
                    common_name=common,
                    source="powo",
                    rank=rank,
                    image_url=self._normalize_image_url(image_url),
                    summary=summary,
                )
            )
        return suggestions

    @staticmethod
    def _normalize_image_url(url: str | None) -> str | None:
        if not url:
            return None
        url = url.strip()
        if url.startswith("//"):
            return f"https:{url}"
        return url


    async def _trefle_details(self, scientific_name: str) -> dict[str, Any] | None:
        params = {"q": scientific_name, "limit": 1, "token": settings.trefle_token}
        client = await self._get_client()
        response = await client.get(f"{settings.trefle_base_url}/plants/search", params=params)
        response.raise_for_status()
        data = response.json().get("data") or []
        if not data:
            return None
        entry = data[0]
        image_url = entry.get("image_url")
        images = []
        if image_url:
            images.append(image_url)
        if isinstance(entry.get("images"), list):
            for item in entry["images"]:
                if isinstance(item, dict):
                    candidate = item.get("image_url") or item.get("full_url") or item.get("url")
                    if candidate:
                        images.append(candidate)
                elif isinstance(item, str):
                    images.append(item)
        return {
            "scientific_name": entry.get("scientific_name"),
            "common_name": entry.get("common_name"),
            "family": entry.get("family"),
            "genus": entry.get("genus"),
            "rank": entry.get("rank"),
            "synonyms": entry.get("synonyms", []) or [],
            "distribution": _split(entry.get("native_status")) or [],
            "summary": entry.get("bibliography") or entry.get("author"),
            "image_url": image_url,
            "images": images,
        }

    async def _powo_details(self, scientific_name: str) -> dict[str, Any] | None:
        params = {"q": scientific_name, "perPage": 1}
        client = await self._get_client()
        response = await client.get(f"{settings.powo_base_url}/search", params=params)
        response.raise_for_status()
        payload = response.json()
        results = payload.get("results", [])
        if not results:
            return None
        record = results[0]
        accepted = record.get("acceptedName", {})
        distribution = []
        if record.get("distribution"):
            distribution = [entry.get("name") for entry in record["distribution"].get("native", []) if entry.get("name")]
        images: list[str] = []
        thumbnail = record.get("thumbnail")
        if thumbnail:
            images.append(thumbnail)
        images_payload = record.get("images") or []
        if isinstance(images_payload, list):
            for item in images_payload:
                if isinstance(item, dict):
                    candidate = item.get("fullsize") or item.get("url") or item.get("thumbnail") or item.get("image")
                    if candidate:
                        images.append(candidate)
                elif isinstance(item, str):
                    images.append(item)
        return {
            "scientific_name": record.get("name") or accepted.get("scientificNameWithoutAuthor"),
            "common_name": record.get("mainCommonName"),
            "family": record.get("family"),
            "genus": accepted.get("genus") or record.get("genus"),
            "rank": record.get("rank") or accepted.get("rank"),
            "synonyms": [syn.get("name") for syn in record.get("synonyms", []) if syn.get("name")],
            "distribution": distribution,
            "summary": record.get("summary") or record.get("briefDescription"),
            "image_url": thumbnail,
            "images": images,
        }

    async def _build_care_profile(self, scientific_name: str, genus: str | None) -> PlantCareProfile:
        try:
            care = await self._openfarm_care(scientific_name)
            if care:
                return care
        except Exception as exc:
            logger.debug("OpenFarm species care failed: %s", exc)
        if genus:
            try:
                care = await self._openfarm_care(genus, level="genus")
                if care:
                    care.allow_user_input = True
                    care.warning = (
                        "Specific care guidance for this species was not available. Showing genus-level advice; adjust as needed."
                    )
                    return care
            except Exception as exc:
                logger.debug("OpenFarm genus care failed: %s", exc)
        return PlantCareProfile(
            light="Provide bright indirect light",
            water="Keep soil evenly moist; avoid standing water",
            humidity="Average indoor humidity",
            temperature_c=(18.0, 26.0),
            ph_range=(6.0, 7.0),
            notes="Baseline guidance. Add custom care notes for this plant.",
            level="custom",
            source=None,
            warning="Care data unavailable; please enter custom instructions.",
            allow_user_input=True,
            soil=None,
            spacing=None,
            lifecycle=None,
        )

    async def _openfarm_care(self, name: str, level: str = "species") -> PlantCareProfile | None:
        params = {"filter": name}
        client = await self._get_client()
        response = await client.get(f"{settings.openfarm_base_url}/crops", params=params)
        response.raise_for_status()
        data = response.json().get("data", [])
        if not data:
            return None
        target = self._choose_openfarm_entry(data, name)
        if not target:
            return None
        attr = target.get("attributes", {})
        sunlight = attr.get("sun_requirements") or "Refer to cultivation notes"
        water = attr.get("watering") or attr.get("irrigation") or "Maintain consistent moisture suited to crop"
        humidity = "Average humidity"  # OpenFarm does not supply
        temp_low = attr.get("temperature_minimum")
        temp_high = attr.get("temperature_maximum")
        if isinstance(temp_low, (int, float)) and isinstance(temp_high, (int, float)):
            temp_range = (float(temp_low), float(temp_high))
        else:
            temp_range = (18.0, 26.0)
        ph_low = attr.get("ph_minimum")
        ph_high = attr.get("ph_maximum")
        ph_min = float(ph_low) if isinstance(ph_low, (int, float)) else 6.0
        ph_max = float(ph_high) if isinstance(ph_high, (int, float)) else 7.0
        notes = attr.get("description") or attr.get("growing_advice")
        soil = attr.get("soil") or attr.get("soil_type") or attr.get("growing_medium")
        soil_text = str(soil) if soil else None
        spacing_value = attr.get("spacing") or attr.get("spread") or attr.get("row_spacing")
        if isinstance(spacing_value, (int, float)):
            spacing_text = f"{float(spacing_value):g} cm"
        else:
            spacing_text = str(spacing_value) if spacing_value else None
        lifecycle_value = attr.get("life_cycle") or attr.get("duration")
        lifecycle_text = str(lifecycle_value) if lifecycle_value else None
        return PlantCareProfile(
            light=sunlight,
            water=water,
            humidity=humidity,
            temperature_c=temp_range,
            ph_range=(ph_min, ph_max),
            notes=notes,
            level=level,
            source="openfarm",
            warning=None,
            allow_user_input=False,
            soil=soil_text,
            spacing=spacing_text,
            lifecycle=lifecycle_text,
        )

    def _merge_image_sources(self, *sources: Any) -> list[str]:
        collected: list[str] = []
        for source in sources:
            if not source:
                continue
            if isinstance(source, str):
                normalized = self._normalize_image_url(str(source))
                if normalized:
                    collected.append(normalized)
                continue
            if isinstance(source, dict):
                primary = source.get("image_url")
                if primary:
                    normalized = self._normalize_image_url(str(primary))
                    if normalized:
                        collected.append(normalized)
                images = source.get("images")
                if isinstance(images, list):
                    for item in images:
                        candidate = None
                        if isinstance(item, str):
                            candidate = item
                        elif isinstance(item, dict):
                            for key in ("image_url", "full_url", "fullsize", "url", "image", "original_url"):
                                if item.get(key):
                                    candidate = item[key]
                                    break
                        if candidate:
                            normalized = self._normalize_image_url(str(candidate))
                            if normalized:
                                collected.append(normalized)
        deduped: list[str] = []
        seen: set[str] = set()
        for url in collected:
            lowered = url.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            deduped.append(url)
            if len(deduped) >= 10:
                break
        return deduped

    def _choose_value(
        self,
        default: Optional[str],
        trefle_data: Optional[dict[str, Any]],
        powo_data: Optional[dict[str, Any]],
        key: str,
    ) -> Optional[str]:
        for source in (trefle_data, powo_data):
            if source and source.get(key):
                return source[key]
        return default

    def _combine_list(
        self,
        trefle_data: Optional[dict[str, Any]],
        powo_data: Optional[dict[str, Any]],
        key: str,
    ) -> list[str]:
        combined: list[str] = []
        for source in (trefle_data, powo_data):
            if source and source.get(key):
                combined.extend(item for item in source[key] if item)
        # remove duplicates preserving order
        seen: set[str] = set()
        deduped: list[str] = []
        for item in combined:
            lower = item.lower()
            if lower not in seen:
                seen.add(lower)
                deduped.append(item)
        return deduped

    def _combine_summary(
        self,
        trefle_data: Optional[dict[str, Any]],
        powo_data: Optional[dict[str, Any]],
    ) -> Optional[str]:
        summaries = []
        for source in (trefle_data, powo_data):
            if source and source.get("summary"):
                summaries.append(source["summary"])
        if summaries:
            return " \n\n".join(dict.fromkeys(summaries))
        return None

    def _choose_openfarm_entry(self, data: list[dict[str, Any]], name: str) -> Optional[dict[str, Any]]:
        lowered = name.lower()
        for entry in data:
            attr = entry.get("attributes", {})
            binomial = attr.get("binomial_name")
            if binomial and binomial.lower() == lowered:
                return entry
            if attr.get("name", "").lower() == lowered:
                return entry
        return data[0] if data else None


def _split(value: Any) -> list[str]:
    if isinstance(value, str):
        parts = [part.strip() for part in value.split(",") if part.strip()]
        return parts
    if isinstance(value, list):
        return [str(item) for item in value if item]
    return []


plant_lookup_service = PlantLookupService()