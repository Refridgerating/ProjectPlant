from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Literal, Optional
from uuid import uuid4


def _now() -> float:
    return time.time()


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
    owner_user_id: str
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
    owner_user_id: str
    features: list[str] = field(default_factory=list)


@dataclass(slots=True)
class IrrigationZone:
    id: str
    name: str
    irrigation_type: Literal["drip", "spray"]
    sun_exposure: Literal["full_sun", "part_sun", "shade"]
    slope: bool
    planting_type: Literal["lawn", "flower_bed", "ground_cover", "trees"]
    coverage_sq_ft: float
    owner_user_id: str
    description: str = ""


class ShareRole(str, Enum):
    OWNER = "owner"
    CONTRACTOR = "contractor"
    VIEWER = "viewer"


class ShareStatus(str, Enum):
    PENDING = "pending"
    ACTIVE = "active"
    REVOKED = "revoked"


@dataclass(slots=True)
class UserAccount:
    id: str
    email: str
    display_name: str
    created_at: float
    updated_at: float
    password_hash: str
    email_verified: bool
    verification_token: str | None


@dataclass(slots=True)
class ShareRecord:
    id: str
    owner_id: str
    contractor_id: str
    role: ShareRole
    status: ShareStatus
    invite_token: str | None = None
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)


class CatalogError(RuntimeError):
    """Base class for catalog failures."""


class CatalogPermissionError(CatalogError):
    """Raised when a caller attempts an unauthorized catalog operation."""


class CatalogNotFoundError(CatalogError):
    """Raised when a requested catalog entity cannot be located."""


def _hash_password(password: str, *, salt: str | None = None) -> str:
    cleaned = password.strip()
    if not cleaned:
        raise CatalogError("Password must not be empty")
    salt_value = salt or uuid4().hex
    digest = hashlib.sha256(f"{salt_value}:{cleaned}".encode("utf-8")).hexdigest()
    return f"{salt_value}${digest}"


def _verify_password(stored_hash: str, password: str) -> bool:
    if not stored_hash or "$" not in stored_hash:
        return False
    salt, existing = stored_hash.split("$", 1)
    candidate = hashlib.sha256(f"{salt}:{password.strip()}".encode("utf-8")).hexdigest()
    return candidate == existing


def _generate_token() -> str:
    return uuid4().hex


class PlantCatalog:
    def __init__(self) -> None:
        self._initialize_state()

    def _initialize_state(self) -> None:
        self._references: list[PlantReference] = _default_references()
        self._users: dict[str, UserAccount] = {user.id: user for user in _default_users()}
        self._shares: dict[str, ShareRecord] = {share.id: share for share in _default_shares()}
        self._share_cache: dict[str, set[str]] = {}
        self._verification_outbox: list[tuple[str, str]] = []
        self._pot_models: list[PotModel] = _default_pot_models(_DEFAULT_OWNER_ID)
        self._zones: list[IrrigationZone] = _default_zones(_DEFAULT_OWNER_ID)
        self._records: list[PlantRecord] = []
        self._next_id = 1

    def reset(self) -> None:
        self._initialize_state()

    def list_users(self) -> list[UserAccount]:
        return list(self._users.values())

    def get_user(self, user_id: str) -> UserAccount | None:
        return self._users.get(user_id)

    def add_user(
        self,
        *,
        email: str,
        display_name: str,
        password: str,
        require_verification: bool = True,
    ) -> UserAccount:
        cleaned_email = email.strip().lower()
        if not cleaned_email:
            raise CatalogError("Email is required")
        if any(existing.email.lower() == cleaned_email for existing in self._users.values()):
            raise CatalogError("Email already registered")
        cleaned_name = display_name.strip() or cleaned_email
        cleaned_password = password.strip()
        if len(cleaned_password) < 8:
            raise CatalogError("Password must be at least 8 characters")
        user_id = f"user-{uuid4().hex[:8]}"
        now = _now()
        token = _generate_token() if require_verification else None
        password_hash = _hash_password(cleaned_password)
        user = UserAccount(
            id=user_id,
            email=cleaned_email,
            display_name=cleaned_name,
            created_at=now,
            updated_at=now,
            password_hash=password_hash,
            email_verified=not require_verification,
            verification_token=token,
        )
        self._users[user_id] = user
        self._invalidate_share_cache(user_id)
        if token:
            self._queue_verification_email(user)
        return user

    def verify_user(self, user_id: str, token: str) -> UserAccount:
        user = self._ensure_user(user_id)
        if user.email_verified:
            raise CatalogError("User already verified")
        provided = token.strip()
        if not provided or user.verification_token != provided:
            raise CatalogError("Invalid verification token")
        user.email_verified = True
        user.verification_token = None
        user.updated_at = _now()
        self._verification_outbox = [entry for entry in self._verification_outbox if entry[0] != user.email]
        return user

    def list_verification_outbox(self) -> list[tuple[str, str]]:
        return list(self._verification_outbox)

    def _queue_verification_email(self, user: UserAccount) -> None:
        if user.verification_token:
            self._verification_outbox.append((user.email, user.verification_token))

    def update_user(
        self,
        user_id: str,
        *,
        email: Optional[str] = None,
        display_name: Optional[str] = None,
        password: Optional[str] = None,
    ) -> UserAccount:
        user = self._users.get(user_id)
        if user is None:
            raise CatalogNotFoundError(f"User {user_id!r} not found")
        updated = False
        if email is not None:
            cleaned_email = email.strip().lower()
            if cleaned_email and cleaned_email != user.email:
                if any(existing.email == cleaned_email and existing.id != user_id for existing in self._users.values()):
                    raise CatalogError("Email already registered")
                # remove previous pending emails
                self._verification_outbox = [entry for entry in self._verification_outbox if entry[0] != user.email]
                user.email = cleaned_email
                user.email_verified = False
                user.verification_token = _generate_token()
                self._queue_verification_email(user)
                updated = True
        if display_name is not None:
            cleaned_name = display_name.strip()
            if cleaned_name:
                user.display_name = cleaned_name
                updated = True
        if password is not None:
            cleaned_password = password.strip()
            if cleaned_password:
                if len(cleaned_password) < 8:
                    raise CatalogError("Password must be at least 8 characters")
                user.password_hash = _hash_password(cleaned_password)
                updated = True
        if updated:
            user.updated_at = _now()
        return user

    def remove_user(self, user_id: str) -> None:
        if user_id not in self._users:
            raise CatalogNotFoundError(f"User {user_id!r} not found")
        if any(zone.owner_user_id == user_id for zone in self._zones):
            raise CatalogError("User still owns irrigation zones")
        if any(model.owner_user_id == user_id for model in self._pot_models):
            raise CatalogError("User still owns smart pot models")
        if any(record.owner_user_id == user_id for record in self._records):
            raise CatalogError("User still owns plant records")
        user = self._users.pop(user_id)
        self._verification_outbox = [entry for entry in self._verification_outbox if entry[0] != user.email]
        impacted: set[str] = {user_id}
        to_remove = [
            share_id
            for share_id, share in self._shares.items()
            if share.owner_id == user_id or share.contractor_id == user_id
        ]
        for share_id in to_remove:
            share = self._shares.pop(share_id)
            impacted.add(share.owner_id)
            impacted.add(share.contractor_id)
        self._invalidate_share_cache(*impacted)

    def list_shares(self, user_id: str) -> list[ShareRecord]:
        self._ensure_user(user_id)
        return [
            share
            for share in self._shares.values()
            if share.owner_id == user_id or share.contractor_id == user_id
        ]

    def add_share(
        self,
        *,
        owner_id: str,
        contractor_id: str,
        role: ShareRole,
        status: ShareStatus = ShareStatus.PENDING,
        invite_token: str | None = None,
    ) -> ShareRecord:
        self._ensure_user(owner_id)
        self._ensure_user(contractor_id)
        if owner_id == contractor_id:
            raise CatalogError("Owner and contractor must be different users")
        share_id = f"share-{uuid4().hex[:8]}"
        now = _now()
        share = ShareRecord(
            id=share_id,
            owner_id=owner_id,
            contractor_id=contractor_id,
            role=role,
            status=status,
            invite_token=invite_token,
            created_at=now,
            updated_at=now,
        )
        self._shares[share_id] = share
        self._invalidate_share_cache(owner_id, contractor_id)
        return share

    def update_share(
        self,
        share_id: str,
        *,
        status: ShareStatus | None = None,
        role: ShareRole | None = None,
    ) -> ShareRecord:
        share = self._shares.get(share_id)
        if share is None:
            raise CatalogNotFoundError(f"Share {share_id!r} not found")
        if status is not None:
            share.status = status
        if role is not None:
            share.role = role
        share.updated_at = _now()
        self._invalidate_share_cache(share.owner_id, share.contractor_id)
        return share

    def remove_share(self, share_id: str) -> None:
        share = self._shares.pop(share_id, None)
        if share is None:
            raise CatalogNotFoundError(f"Share {share_id!r} not found")
        self._invalidate_share_cache(share.owner_id, share.contractor_id)

    def get_share(self, share_id: str) -> ShareRecord | None:
        return self._shares.get(share_id)

    def list_pot_models(self, requester_id: str) -> list[PotModel]:
        owners = self._resolve_accessible_owners(requester_id)
        return [model for model in self._pot_models if model.owner_user_id in owners]

    def list_zones(self, requester_id: str) -> list[IrrigationZone]:
        owners = self._resolve_accessible_owners(requester_id)
        return [zone for zone in self._zones if zone.owner_user_id in owners]

    def add_zone(
        self,
        owner_id: str,
        *,
        name: str,
        irrigation_type: Literal["drip", "spray"],
        sun_exposure: Literal["full_sun", "part_sun", "shade"],
        slope: bool,
        planting_type: Literal["lawn", "flower_bed", "ground_cover", "trees"],
        coverage_sq_ft: float = 0.0,
        description: str | None = None,
    ) -> IrrigationZone:
        self._ensure_user(owner_id)
        zone = IrrigationZone(
            id=f"zone-{uuid4().hex[:8]}",
            name=name or "Unnamed Zone",
            irrigation_type=irrigation_type,
            sun_exposure=sun_exposure,
            slope=slope,
            planting_type=planting_type,
            coverage_sq_ft=max(0.0, float(coverage_sq_ft)),
            owner_user_id=owner_id,
            description=(description or "").strip(),
        )
        self._zones.append(zone)
        self._invalidate_share_cache(owner_id)
        return zone

    def update_zone(
        self,
        requester_id: str,
        zone_id: str,
        *,
        name: str,
        irrigation_type: Literal["drip", "spray"],
        sun_exposure: Literal["full_sun", "part_sun", "shade"],
        slope: bool,
        planting_type: Literal["lawn", "flower_bed", "ground_cover", "trees"],
        coverage_sq_ft: float = 0.0,
        description: str | None = None,
    ) -> IrrigationZone:
        index, zone = self._get_zone_record(zone_id)
        self._require_owner_permission(requester_id, zone.owner_user_id)
        updated = IrrigationZone(
            id=zone.id,
            name=name or zone.name,
            irrigation_type=irrigation_type,
            sun_exposure=sun_exposure,
            slope=slope,
            planting_type=planting_type,
            coverage_sq_ft=max(0.0, float(coverage_sq_ft)),
            owner_user_id=zone.owner_user_id,
            description=(description if description is not None else zone.description) or "",
        )
        self._zones[index] = updated
        return updated

    def remove_zone(self, requester_id: str, zone_id: str) -> IrrigationZone:
        index, zone = self._get_zone_record(zone_id)
        self._require_owner_permission(requester_id, zone.owner_user_id)
        removed = self._zones.pop(index)
        for record in self._records:
            if record.irrigation_zone_id == zone_id:
                record.irrigation_zone_id = None
        return removed

    def detect_pot(self, requester_id: str) -> PotModel:
        models = self.list_pot_models(requester_id)
        if not models:
            raise CatalogNotFoundError("No smart pot models available for user")
        index = (self._next_id - 1) % len(models)
        return models[index]

    def search_references(self, query: Optional[str] = None) -> list[PlantReference]:
        if not query:
            return list(self._references)
        lowered = query.strip().lower()
        return [
            ref
            for ref in self._references
            if lowered in ref.species.lower() or lowered in ref.common_name.lower()
        ]

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
        owner_id: str,
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
        self._ensure_user(owner_id)
        reference = self.resolve_reference(species)
        if irrigation_zone_id:
            _, zone = self._get_zone_record(irrigation_zone_id)
            if zone.owner_user_id != owner_id:
                raise CatalogPermissionError("Cannot assign irrigation zone owned by another user")
        if location_type == "smart_pot" and not pot_model:
            detected = self.detect_pot(owner_id)
            pot_model = detected.id
        ideal = _build_conditions(reference)
        if care_profile:
            ideal.update(
                {
                    "light": care_profile.get("light", ideal["light"]),
                    "water": care_profile.get("water", ideal["water"]),
                    "humidity": care_profile.get("humidity", ideal.get("humidity", "Average indoor humidity")),
                    "temperature_c": care_profile.get("temperature_c", ideal.get("temperature_c", (18.0, 26.0))),
                    "ph_range": care_profile.get("ph_range", ideal.get("ph_range", (6.0, 7.0))),
                    "notes": care_profile.get("notes", ideal.get("notes", "")),
                }
            )
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
            owner_user_id=owner_id,
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

    def list_records(self, requester_id: str) -> list[PlantRecord]:
        owners = self._resolve_accessible_owners(requester_id)
        return [record for record in self._records if record.owner_user_id in owners]

    def role_for(self, viewer_id: str, owner_id: str) -> ShareRole:
        if viewer_id == owner_id:
            return ShareRole.OWNER
        for share in self._shares.values():
            if share.status != ShareStatus.ACTIVE:
                continue
            if share.owner_id == owner_id and share.contractor_id == viewer_id:
                return share.role
        raise CatalogPermissionError(f"User {viewer_id!r} does not have access to owner {owner_id!r}")

    def _ensure_user(self, user_id: str) -> UserAccount:
        user = self._users.get(user_id)
        if user is None:
            raise CatalogNotFoundError(f"User {user_id!r} not found")
        return user

    def _invalidate_share_cache(self, *user_ids: str) -> None:
        if not user_ids:
            self._share_cache.clear()
            return
        for user_id in user_ids:
            self._share_cache.pop(user_id, None)

    def _resolve_accessible_owners(self, user_id: str) -> set[str]:
        self._ensure_user(user_id)
        cached = self._share_cache.get(user_id)
        if cached is not None:
            return set(cached)
        owners = {user_id}
        for share in self._shares.values():
            if share.status != ShareStatus.ACTIVE:
                continue
            if share.contractor_id == user_id:
                owners.add(share.owner_id)
            if share.owner_id == user_id:
                owners.add(share.owner_id)
        self._share_cache[user_id] = set(owners)
        return set(owners)

    def _require_owner_permission(self, requester_id: str, owner_id: str) -> None:
        if requester_id != owner_id:
            raise CatalogPermissionError("Only the owner may modify this resource")

    def _get_zone_record(self, zone_id: str) -> tuple[int, IrrigationZone]:
        for index, zone in enumerate(self._zones):
            if zone.id == zone_id:
                return index, zone
        raise CatalogNotFoundError(f"Irrigation zone {zone_id!r} not found")


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


_DEFAULT_OWNER_ID = "user-demo-owner"
_DEFAULT_CONTRACTOR_ID = "user-demo-contractor"
_DEFAULT_SHARE_ID = "share-demo-owner-contractor"


def _default_users() -> list[UserAccount]:
    created = _now()
    owner_hash = _hash_password("demo-owner-password", salt="owner-salt")
    contractor_hash = _hash_password("demo-contractor-password", salt="contractor-salt")
    return [
        UserAccount(
            id=_DEFAULT_OWNER_ID,
            email="grower@example.com",
            display_name="Demo Grower",
            created_at=created,
            updated_at=created,
            password_hash=owner_hash,
            email_verified=True,
            verification_token=None,
        ),
        UserAccount(
            id=_DEFAULT_CONTRACTOR_ID,
            email="contractor@example.com",
            display_name="Demo Contractor",
            created_at=created,
            updated_at=created,
            password_hash=contractor_hash,
            email_verified=True,
            verification_token=None,
        ),
    ]


def _default_shares() -> list[ShareRecord]:
    created = _now()
    return [
        ShareRecord(
            id=_DEFAULT_SHARE_ID,
            owner_id=_DEFAULT_OWNER_ID,
            contractor_id=_DEFAULT_CONTRACTOR_ID,
            role=ShareRole.CONTRACTOR,
            status=ShareStatus.ACTIVE,
            invite_token=None,
            created_at=created,
            updated_at=created,
        )
    ]


def _default_pot_models(owner_id: str) -> list[PotModel]:
    return [
        PotModel(
            id="smartpot-mini",
            name="SmartPot Mini",
            volume_l=2.5,
            owner_user_id=owner_id,
            features=["Capacitive moisture", "LED strip"],
        ),
        PotModel(
            id="smartpot-midi",
            name="SmartPot Midi",
            volume_l=4.0,
            owner_user_id=owner_id,
            features=["Weight cell", "Fan assist"],
        ),
        PotModel(
            id="smartpot-pro",
            name="SmartPot Pro",
            volume_l=7.5,
            owner_user_id=owner_id,
            features=["Multi-sensor", "Root temp probe"],
        ),
    ]


def _default_zones(owner_id: str) -> list[IrrigationZone]:
    return [
        IrrigationZone(
            id="zone-1",
            name="Front Garden Drip",
            irrigation_type="drip",
            sun_exposure="part_sun",
            slope=False,
            planting_type="flower_bed",
            coverage_sq_ft=120.0,
            owner_user_id=owner_id,
            description="Drip loop along front beds",
        ),
        IrrigationZone(
            id="zone-2",
            name="Back Lawn Spray",
            irrigation_type="spray",
            sun_exposure="full_sun",
            slope=False,
            planting_type="lawn",
            coverage_sq_ft=450.0,
            owner_user_id=owner_id,
            description="Rotor heads covering backyard",
        ),
        IrrigationZone(
            id="zone-3",
            name="Raised Beds",
            irrigation_type="drip",
            sun_exposure="full_sun",
            slope=False,
            planting_type="ground_cover",
            coverage_sq_ft=80.0,
            owner_user_id=owner_id,
            description="Soaker hose in raised vegetable beds",
        ),
    ]


plant_catalog = PlantCatalog()

