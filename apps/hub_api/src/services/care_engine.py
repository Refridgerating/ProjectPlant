from __future__ import annotations

import asyncio
import json
import logging
import subprocess
from pathlib import Path
from typing import Any, Tuple

logger = logging.getLogger("projectplant.hub.care_engine")


class CareEngineError(RuntimeError):
    """Raised when the care engine runner cannot execute."""


class CareEngineRunner:
    def __init__(self, repo_root: Path | None = None) -> None:
        self._repo_root = repo_root or Path(__file__).resolve().parents[4]
        self._cli_path = (
            self._repo_root / "packages" / "care-engine" / "dist" / "cli" / "run-care-engine.js"
        )
        self._build_lock = asyncio.Lock()

    async def run(
        self,
        *,
        canonical_name: str,
        powo_id: str | None,
        inat_id: int | None,
        gbif_id: int | None = None,
        powo_raw: dict[str, Any] | None = None,
        inat_raw: dict[str, Any] | None = None,
        gbif_raw: dict[str, Any] | None = None,
        powo_context_url: str | None,
        inat_context_url: str | None,
        gbif_context_url: str | None = None,
        powo_base_url: str,
        inat_base_url: str,
        gbif_base_url: str | None = None,
        inference_version: str | None = None,
        schema_version: str | None = None,
    ) -> dict[str, Any] | None:
        """Invoke the Node-based care engine runner and return a normalized care profile."""

        if not canonical_name or (not powo_id and inat_id is None and gbif_id is None):
            return None

        await self._ensure_cli()

        payload = {
            "canonicalName": canonical_name,
            "powoId": powo_id,
            "inatId": inat_id,
            "powoRaw": powo_raw,
            "inatRaw": inat_raw,
            "gbifRaw": gbif_raw,
            "powoContextUrl": powo_context_url,
            "inatContextUrl": inat_context_url,
            "gbifContextUrl": gbif_context_url,
            "powoBaseUrl": powo_base_url,
            "inatBaseUrl": inat_base_url,
            "gbifBaseUrl": gbif_base_url,
            "gbifId": gbif_id,
            "schemaVersion": schema_version,
            "inferenceVersion": inference_version,
        }

        exit_code, stdout, stderr = await self._exec_cli(json.dumps(payload).encode("utf-8"))
        if exit_code != 0:
            message = stderr.decode().strip() or stdout.decode().strip() or "care-engine failed"
            logger.warning("care-engine runner exited with %s: %s", exit_code, message)
            return None
        try:
            result = json.loads(stdout.decode() or "{}")
        except json.JSONDecodeError as exc:  # pragma: no cover - defensive
            raise CareEngineError("care-engine returned invalid JSON") from exc

        if not isinstance(result, dict) or not result.get("ok"):
            logger.warning("care-engine runner returned error: %s", result.get("error"))
            return None

        profile = result.get("profile")
        if not isinstance(profile, dict):
            logger.warning("care-engine runner returned unexpected payload")
            return None
        return profile

    async def _ensure_cli(self) -> None:
        if self._cli_path.exists():
            return
        async with self._build_lock:
            if self._cli_path.exists():
                return
            process = await asyncio.create_subprocess_exec(
                "pnpm",
                "--filter",
                "@projectplant/care-engine",
                "build",
                cwd=str(self._repo_root),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()
            if process.returncode != 0:
                message = stderr.decode().strip() or stdout.decode().strip()
                raise CareEngineError(f"Failed to build care-engine CLI: {message}")

    async def _exec_cli(self, input_bytes: bytes) -> Tuple[int, bytes, bytes]:
        args = [
            "node",
            str(self._cli_path),
        ]
        try:
            process = await asyncio.create_subprocess_exec(
                *args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self._repo_root),
            )
            stdout, stderr = await process.communicate(input_bytes)
            return process.returncode or 0, stdout, stderr
        except NotImplementedError:
            loop = asyncio.get_running_loop()

            def _run_blocking() -> Tuple[int, bytes, bytes]:
                completed = subprocess.run(
                    args,
                    input=input_bytes,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=self._repo_root,
                    check=False,
                )
                return completed.returncode, completed.stdout, completed.stderr

            return await loop.run_in_executor(None, _run_blocking)


care_engine_runner = CareEngineRunner()
