from __future__ import annotations

import base64
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from nacl.exceptions import BadSignatureError
from nacl.secret import SecretBox
from nacl.signing import VerifyKey
from nacl.utils import random as nacl_random

from config import settings


def utc_now_iso() -> str:
    iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return iso.replace("+00:00", "Z")


def sha256_hexdigest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_password(password: str, *, salt: str | None = None) -> str:
    cleaned = password.strip()
    if not cleaned:
        raise ValueError("Password must not be empty")
    salt_value = salt or uuid4().hex
    digest = hashlib.sha256(f"{salt_value}:{cleaned}".encode("utf-8")).hexdigest()
    return f"{salt_value}${digest}"


def verify_password(stored_hash: str, password: str) -> bool:
    if "$" not in stored_hash:
        return False
    salt, expected = stored_hash.split("$", 1)
    candidate = hashlib.sha256(f"{salt}:{password.strip()}".encode("utf-8")).hexdigest()
    return candidate == expected


def verify_agent_signature(public_key_hex: str, timestamp: str, payload: bytes, signature_b64: str) -> bool:
    verify_key = VerifyKey(bytes.fromhex(public_key_hex))
    signed = f"{timestamp}\n".encode("utf-8") + payload
    signature = base64.b64decode(signature_b64)
    try:
        verify_key.verify(signed, signature)
    except BadSignatureError:
        return False
    return True


def verify_release_signature(manifest_bytes: bytes, signature_bytes: bytes) -> bool:
    key_path = settings.fleet_release_public_key_path
    if not key_path:
        return True
    raw = Path(key_path).read_text(encoding="utf-8").strip()
    verify_key = VerifyKey(bytes.fromhex(raw))
    try:
        verify_key.verify(manifest_bytes, signature_bytes)
    except BadSignatureError:
        return False
    return True


def recovery_public_key_hex(path: str | Path | None = None) -> str | None:
    key_path = Path(path or settings.fleet_recovery_public_key_path)
    if not key_path.exists():
        return None
    return key_path.read_text(encoding="utf-8").strip() or None


def recovery_public_key_fingerprint(path: str | Path | None = None) -> str | None:
    raw_hex = recovery_public_key_hex(path)
    if not raw_hex:
        return None
    return sha256_hexdigest(bytes.fromhex(raw_hex))


def verify_recovery_signature(challenge: bytes, signature_b64: str, *, path: str | Path | None = None) -> bool:
    raw_hex = recovery_public_key_hex(path)
    if not raw_hex:
        return False
    verify_key = VerifyKey(bytes.fromhex(raw_hex))
    try:
        verify_key.verify(challenge, base64.b64decode(signature_b64))
    except BadSignatureError:
        return False
    return True


def _secret_box() -> SecretBox:
    key = hashlib.sha256(settings.auth_state_encryption_key.encode("utf-8")).digest()
    return SecretBox(key)


def encrypt_sensitive_value(value: str) -> str:
    box = _secret_box()
    encrypted = box.encrypt(value.encode("utf-8"), nonce=nacl_random(SecretBox.NONCE_SIZE))
    return base64.b64encode(encrypted).decode("ascii")


def decrypt_sensitive_value(value: str) -> str:
    box = _secret_box()
    decrypted = box.decrypt(base64.b64decode(value.encode("ascii")))
    return decrypted.decode("utf-8")
