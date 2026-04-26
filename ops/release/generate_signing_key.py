from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

from nacl.signing import SigningKey


def write_text(path: Path, value: str, *, force: bool) -> None:
    if path.exists() and not force:
        raise FileExistsError(f"{path} already exists; pass --force to overwrite it")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--private-key-path", required=True)
    parser.add_argument("--public-key-path", required=True)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    signing_key = SigningKey.generate()
    private_hex = signing_key.encode().hex()
    public_hex = signing_key.verify_key.encode().hex()

    private_path = Path(args.private_key_path)
    public_path = Path(args.public_key_path)
    write_text(private_path, private_hex, force=args.force)
    write_text(public_path, public_hex, force=args.force)

    fingerprint = hashlib.sha256(bytes.fromhex(public_hex)).hexdigest()
    print(f"private_key={private_path}")
    print(f"public_key={public_path}")
    print(f"fingerprint={fingerprint}")


if __name__ == "__main__":
    main()
