from __future__ import annotations

import base64
import hashlib
import hmac
import os
import struct
import time
from urllib.parse import quote


def generate_totp_secret() -> str:
    return base64.b32encode(os.urandom(20)).decode("ascii").rstrip("=")


def provisioning_uri(*, secret: str, label: str, issuer: str) -> str:
    safe_label = quote(label)
    safe_issuer = quote(issuer)
    return f"otpauth://totp/{safe_issuer}:{safe_label}?secret={secret}&issuer={safe_issuer}&algorithm=SHA1&digits=6&period=30"


def render_otpauth_svg(*, label: str, secret: str, uri: str) -> str:
    escaped_label = _xml_escape(label)
    escaped_secret = _xml_escape(secret)
    escaped_uri = _xml_escape(uri)
    return (
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"360\" height=\"180\" viewBox=\"0 0 360 180\">"
        "<rect width=\"360\" height=\"180\" rx=\"16\" fill=\"#0f172a\"/>"
        "<text x=\"20\" y=\"36\" fill=\"#e2e8f0\" font-family=\"monospace\" font-size=\"16\">TOTP Enrollment</text>"
        f"<text x=\"20\" y=\"72\" fill=\"#93c5fd\" font-family=\"monospace\" font-size=\"14\">{escaped_label}</text>"
        f"<text x=\"20\" y=\"102\" fill=\"#f8fafc\" font-family=\"monospace\" font-size=\"14\">Secret: {escaped_secret}</text>"
        f"<text x=\"20\" y=\"132\" fill=\"#94a3b8\" font-family=\"monospace\" font-size=\"10\">{escaped_uri}</text>"
        "<text x=\"20\" y=\"156\" fill=\"#fbbf24\" font-family=\"monospace\" font-size=\"10\">Add manually in your authenticator if QR scanning is unavailable.</text>"
        "</svg>"
    )


def verify_totp(secret: str, code: str, *, at_time: int | None = None, window: int = 1) -> bool:
    candidate = code.strip().replace(" ", "")
    if len(candidate) != 6 or not candidate.isdigit():
        return False
    now = int(at_time if at_time is not None else time.time())
    for offset in range(-window, window + 1):
        if _totp_code(secret, now + (offset * 30)) == candidate:
            return True
    return False


def generate_recovery_codes(count: int = 8) -> list[str]:
    codes: list[str] = []
    for _ in range(max(1, count)):
        raw = hashlib.sha256(os.urandom(24)).hexdigest()[:10].upper()
        codes.append(f"{raw[:5]}-{raw[5:]}")
    return codes


def hash_recovery_code(code: str) -> str:
    return hashlib.sha256(code.strip().upper().encode("utf-8")).hexdigest()


def _totp_code(secret: str, epoch_seconds: int) -> str:
    key = base64.b32decode(_pad_base32(secret), casefold=True)
    counter = max(0, epoch_seconds // 30)
    message = struct.pack(">Q", counter)
    digest = hmac.new(key, message, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(binary % 1_000_000).zfill(6)


def _pad_base32(value: str) -> str:
    padding = "=" * ((8 - (len(value) % 8)) % 8)
    return value + padding


def _xml_escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )
