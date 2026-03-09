from __future__ import annotations

import argparse
import json
import mimetypes
import uuid
from pathlib import Path
from urllib import request


def build_multipart(release_dir: Path) -> tuple[bytes, str]:
    boundary = f"projectplant-{uuid.uuid4().hex}"
    chunks: list[bytes] = []

    def add_text(name: str, value: str) -> None:
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                value.encode(),
                b"\r\n",
            ]
        )

    def add_file(name: str, path: Path) -> None:
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{name}"; filename="{path.name}"\r\n'.encode(),
                f"Content-Type: {content_type}\r\n\r\n".encode(),
                path.read_bytes(),
                b"\r\n",
            ]
        )

    manifest = json.loads((release_dir / "manifest.json").read_text(encoding="utf-8"))
    add_text("metadata", json.dumps({"manifest": manifest}))
    add_file("signature", release_dir / "manifest.sig")
    for artifact in manifest.get("artifacts", []):
        add_file("artifacts", release_dir / str(artifact["name"]))
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), boundary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--control-url", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--release-dir", required=True)
    args = parser.parse_args()

    release_dir = Path(args.release_dir)
    body, boundary = build_multipart(release_dir)
    req = request.Request(
        args.control_url.rstrip("/") + "/api/v1/releases",
        data=body,
        headers={
            "Authorization": f"Bearer {args.token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    with request.urlopen(req) as response:
        print(response.read().decode("utf-8"))


if __name__ == "__main__":
    main()
