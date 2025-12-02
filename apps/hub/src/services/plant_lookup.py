from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx
from pykew.core import Api as PowoApi

from config import settings
from services.care_engine import care_engine_runner

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


class _ConfiguredPowoApi(PowoApi):
    def __init__(self, base_url: str, timeout: float, headers: dict[str, str]) -> None:
        super().__init__(base_url.rstrip("/"))
        self._timeout = timeout
        self._headers = headers

    def get(self, method: str, params: dict[str, Any] | None = None) -> httpx.Response:
        payload = dict(params or {})
        response = httpx.get(
            self._url(method, payload),
            headers=self._headers,
            timeout=self._timeout,
        )
        if response.status_code == 249:
            time.sleep(5)
            return self.get(method, payload)
        return response


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
    powo_id: str | None = None
    inat_id: int | None = None
    care_profile_normalized: dict[str, Any] | None = None
    gbif_id: str | None = None
    powo_raw: dict[str, Any] | None = None
    inat_raw: dict[str, Any] | None = None


class PlantLookupService:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._suggest_cache: dict[str, tuple[float, list[PlantSuggestion]]] = {}
        self._details_cache: dict[str, tuple[float, PlantDetails]] = {}
        self._lock = asyncio.Lock()
        self._cache_ttl = settings.plant_lookup_cache_ttl
        powo_headers = {
            "User-Agent": settings.weather_user_agent,
            "Accept": "application/json",
        }
        self._powo_api = _ConfiguredPowoApi(
            base_url=settings.powo_base_url,
            timeout=settings.plant_lookup_timeout,
            headers=powo_headers,
        )
        self._gbif_base_url = settings.gbif_base_url.rstrip("/")
        self._gbif_base_url = settings.gbif_base_url.rstrip("/")

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
            logger.info("suggest cache hit (fast) for %s", key)
            return cached[1]

        async with self._lock:
            cached = self._suggest_cache.get(key)
            if cached and cached[0] > now:
                logger.info("suggest cache hit (locked) for %s", key)
                return cached[1]

            tasks = [
                self._powo_suggest(term),
                self._inat_suggest(term),
            ]
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

            powo_data = None
            powo_image: str | None = None
            inat_data = None
            inat_image: str | None = None
            inat_id: int | None = None
            sources: list[str] = []
            gbif_id: str | None = None
            gbif_context_url: str | None = None

            try:
                powo_data = await self._powo_details(key)
                if powo_data:
                    sources.append("powo")
                    powo_image = powo_data.get("image_url")
            except Exception as exc:
                logger.debug("POWO details failed for %s: %s", key, exc)

            try:
                inat_data = await self._inat_details(key)
                if inat_data:
                    inat_id = int(inat_data.get("id")) if inat_data.get("id") is not None else None
                    sources.append("inaturalist")
                    photo = inat_data.get("default_photo")
                    if isinstance(photo, dict):
                        inat_image = (
                            photo.get("medium_url")
                            or photo.get("square_url")
                            or photo.get("url")
                        )
            except Exception as exc:
                logger.debug("iNaturalist details failed for %s: %s", key, exc)

            if not powo_data:
                raise RuntimeError("No data found for specified plant")

            scientific = powo_data.get("scientific_name") or key
            common_name = powo_data.get("common_name")
            if not common_name and inat_data:
                common_candidate = inat_data.get("preferred_common_name")
                if isinstance(common_candidate, str) and common_candidate.strip():
                    common_name = common_candidate
            family = powo_data.get("family")
            genus = powo_data.get("genus")
            rank = powo_data.get("rank")
            summary = powo_data.get("summary")
            synonyms = list(powo_data.get("synonyms", []))
            distribution = list(powo_data.get("distribution", []))
            taxonomy = {k: v for k, v in {
                "family": family,
                "genus": genus,
                "rank": rank,
            }.items() if v}

            images = self._merge_image_sources(powo_image, powo_data, inat_image)
            image_url = images[0] if images else None


            try:
                gbif_candidates = [scientific or key]
                epithet = None
                if scientific:
                    parts = scientific.split()
                    if len(parts) >= 2:
                        epithet = parts[1]
                if not scientific and genus:
                    gbif_candidates.append(genus)
                if genus and epithet:
                    gbif_candidates.append(f"{genus} {epithet}")
                gbif_id = await self._match_gbif_species(gbif_candidates)
                if gbif_id and "gbif" not in sources:
                    sources.append("gbif")
                    gbif_context_url = f"https://www.gbif.org/species/{gbif_id}"
            except Exception as exc:
                logger.debug("GBIF lookup failed for %s: %s", key, exc)

            care = await self._build_care_profile(scientific or key, genus or scientific)
            normalized_care = None
            try:
                powo_context_url = None
                powo_fqid = powo_data.get("fqId")
                if isinstance(powo_fqid, str):
                    powo_context_url = f"{settings.powo_base_url.rstrip('/')}/taxon/{powo_fqid}"
                inat_context_url = None
                if inat_id:
                    inat_context_url = f"{settings.inat_base_url.rstrip('/')}/taxa/{inat_id}"
                normalized_care = await care_engine_runner.run(
                    canonical_name=scientific or key,
                    powo_id=powo_fqid,
                    inat_id=inat_id,
                    gbif_id=int(gbif_id) if gbif_id is not None else None,
                    powo_raw=powo_data,
                    inat_raw=inat_data,
                    powo_context_url=powo_context_url,
                    inat_context_url=inat_context_url,
                    gbif_context_url=gbif_context_url,
                    powo_base_url=settings.powo_base_url,
                    inat_base_url=settings.inat_base_url,
                    gbif_base_url=settings.gbif_base_url,
                )
            except Exception as exc:  # pragma: no cover - logging only
                logger.warning("Care engine inference failed for %s: %s", key, exc, exc_info=True)
            normalized_care = self._ensure_guidance_inputs(
                normalized_care,
                canonical_name=scientific or key,
                powo_id=powo_data.get("fqId"),
                gbif_id=gbif_id,
                care=care,
            )
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
                powo_id=powo_data.get("fqId"),
                inat_id=inat_id,
                care_profile_normalized=normalized_care,
                gbif_id=gbif_id,
                powo_raw=powo_data,
                inat_raw=inat_data,
            )
            if self._cache_ttl > 0:
                self._details_cache[cache_key] = (now + self._cache_ttl, detail)
            return detail

    async def _match_gbif_species(self, candidates: list[str]) -> str | None:
        client = await self._get_client()
        for name in candidates:
            if not name:
                continue
            trimmed = name.strip()
            if not trimmed:
                continue
            try:
                response = await client.get(
                    f"{self._gbif_base_url}/species/match",
                    params={"name": trimmed},
                )
                response.raise_for_status()
                payload = response.json()
                key = payload.get("speciesKey") or payload.get("usageKey")
                if isinstance(key, int) and key > 0:
                    return str(key)
            except Exception as exc:
                logger.debug("GBIF species match failed for %s: %s", trimmed, exc)
        return None

    def _ensure_guidance_inputs(
        self,
        normalized: dict[str, Any] | None,
        *,
        canonical_name: str,
        powo_id: str | None,
        gbif_id: str | None,
        care: PlantCareProfile,
    ) -> dict[str, Any]:
        profile = normalized or {}
        taxon = profile.setdefault("taxon", {})
        taxon.setdefault("canonicalName", canonical_name)
        if powo_id and not taxon.get("powoId"):
            taxon["powoId"] = powo_id
        if gbif_id and not taxon.get("gbifId"):
            taxon["gbifId"] = gbif_id

        profile.setdefault(
            "metadata",
            {
                "schemaVersion": "2024-10-12",
                "inferenceVersion": profile.get("metadata", {}).get("inferenceVersion") or "heuristic-fallback",
                "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            },
        )

        evidence_source = {"id": "projectplant", "name": "ProjectPlant heuristics"}

        if not profile.get("light"):
            light_value = self._map_light_hint(care.light)
            if light_value:
                profile["light"] = {
                    "value": light_value,
                    "confidence": {"level": "low"},
                    "evidence": [{"source": evidence_source, "signal": care.light}],
                }

        if not profile.get("water"):
            water_value = self._map_water_hint(care.water)
            if water_value:
                profile["water"] = {
                    "value": water_value,
                    "confidence": {"level": "low"},
                    "evidence": [{"source": evidence_source, "signal": care.water}],
                }

        if not profile.get("humidity"):
            humidity_value = self._map_humidity_hint(care.humidity)
            if humidity_value:
                profile["humidity"] = {
                    "value": humidity_value,
                    "confidence": {"level": "low"},
                    "evidence": [{"source": evidence_source, "signal": care.humidity}],
                }

        return profile

    @staticmethod
    def _map_light_hint(text: str | None) -> list[str] | None:
        if not text:
            return None
        lowered = text.lower()
        if "full sun" in lowered:
            return ["full_sun"]
        if "partial" in lowered or "part sun" in lowered:
            return ["partial_sun"]
        if "shade" in lowered:
            return ["full_shade"]
        if "bright" in lowered:
            return ["bright_indirect"]
        return None

    @staticmethod
    def _map_water_hint(text: str | None) -> str | None:
        if not text:
            return None
        lowered = text.lower()
        if "standing water" in lowered or "consistently moist" in lowered or "water frequently" in lowered:
            return "high"
        if "evenly moist" in lowered or "moderate" in lowered:
            return "medium"
        if "infrequent" in lowered or "allow to dry" in lowered or "light watering" in lowered:
            return "low"
        if "sparingly" in lowered or "dry" in lowered:
            return "very_low"
        return None

    @staticmethod
    def _map_humidity_hint(text: str | None) -> str | None:
        if not text:
            return None
        lowered = text.lower()
        if "high" in lowered:
            return "high"
        if "low" in lowered:
            return "low"
        return "medium"

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

    async def _powo_request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        request_params = dict(params or {})

        def _call() -> dict[str, Any]:
            response = self._powo_api.get(method, request_params)
            response.raise_for_status()
            return response.json()

        return await asyncio.to_thread(_call)

    async def _powo_suggest(self, query: str) -> list[PlantSuggestion]:
        payload = await self._powo_request("search", {"q": query, "perPage": 12})
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

    async def _powo_details(self, scientific_name: str) -> dict[str, Any] | None:
        payload = await self._powo_request("search", {"q": scientific_name, "perPage": 1})
        results = payload.get("results", [])
        if not results:
            return None
        search_record = results[0]
        fqid = search_record.get("fqId")
        taxon_record: dict[str, Any] | None = None
        if fqid:
            try:
                taxon_record = await self._powo_request(f"taxon/{fqid}")
            except Exception as exc:
                logger.debug("POWO taxon fetch failed for %s: %s", fqid, exc)

        accepted = search_record.get("acceptedName", {})
        record_for_text = taxon_record or search_record

        def collect_distribution() -> list[str]:
            if taxon_record and isinstance(taxon_record.get("locations"), list):
                return [loc for loc in taxon_record["locations"] if isinstance(loc, str)]
            if search_record.get("distribution"):
                native = search_record["distribution"].get("native", [])
                return [
                    entry.get("name")
                    for entry in native
                    if isinstance(entry, dict) and entry.get("name")
                ]
            return []

        def collect_synonyms() -> list[str]:
            source = taxon_record or search_record
            items = source.get("synonyms", []) if isinstance(source, dict) else []
            if isinstance(items, list):
                return [syn.get("name") for syn in items if isinstance(syn, dict) and syn.get("name")]
            return []

        def add_image(container: list[str], url: str | None) -> None:
            if not url:
                return
            normalized = self._normalize_image_url(str(url))
            if normalized and normalized not in container:
                container.append(normalized)

        images: list[str] = []
        for source in filter(None, (taxon_record, search_record)):
            thumb = source.get("thumbnail")
            add_image(images, thumb)
            for item in source.get("images", []) or []:
                if isinstance(item, dict):
                    candidate = (
                        item.get("fullsize")
                        or item.get("url")
                        or item.get("thumbnail")
                        or item.get("image")
                    )
                    add_image(images, candidate)
                elif isinstance(item, str):
                    add_image(images, item)

        summary = (
            record_for_text.get("summary")
            or record_for_text.get("briefDescription")
            or record_for_text.get("taxonRemarks")
        )

        return {
            "scientific_name": record_for_text.get("name")
            or accepted.get("scientificNameWithoutAuthor"),
            "common_name": record_for_text.get("mainCommonName"),
            "family": record_for_text.get("family") or search_record.get("family"),
            "genus": record_for_text.get("genus") or accepted.get("genus"),
            "rank": record_for_text.get("rank") or accepted.get("rank"),
            "synonyms": collect_synonyms(),
            "distribution": collect_distribution(),
            "summary": summary,
            "image_url": images[0] if images else None,
            "images": images,
            "fqId": fqid,
            "lifeform": record_for_text.get("lifeform"),
            "climate": record_for_text.get("climate"),
            "locations": taxon_record.get("locations") if taxon_record else None,
        }

    async def _inat_details(self, scientific_name: str) -> dict[str, Any] | None:
        params = {"q": scientific_name, "per_page": 1, "all_names": "true", "locale": "en"}
        client = await self._get_client()
        response = await client.get(f"{settings.inat_base_url}/taxa", params=params)
        response.raise_for_status()
        payload = response.json()
        results = payload.get("results", [])
        if not results:
            return None
        return results[0]

    async def _build_care_profile(self, scientific_name: str, genus: str | None) -> PlantCareProfile:
        _ = (scientific_name, genus)
        return PlantCareProfile(
            light="Provide bright indirect light",
            water="Keep soil evenly moist; avoid standing water",
            humidity="Average indoor humidity",
            temperature_c=(18.0, 26.0),
            ph_range=(6.0, 7.0),
            notes="Baseline guidance generated by the ProjectPlant care engine. Adjust for your exact space.",
            level="custom",
            source="projectplant",
            warning="Care heuristics are generic until ProjectPlant ingests telemetry for this plant.",
            allow_user_input=True,
            soil=None,
            spacing=None,
            lifecycle=None,
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

plant_lookup_service = PlantLookupService()
