from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import AgentConfig


@dataclass(slots=True)
class AgentState:
    current_release_id: str | None = None
    last_known_good_release_id: str | None = None
    last_operation_id: str | None = None
    last_rollout_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


def load_state(config: AgentConfig) -> AgentState:
    config.state_dir.mkdir(parents=True, exist_ok=True)
    if not config.state_path.exists():
        return AgentState()
    payload = json.loads(config.state_path.read_text(encoding="utf-8"))
    return AgentState(
        current_release_id=payload.get("currentReleaseId"),
        last_known_good_release_id=payload.get("lastKnownGoodReleaseId"),
        last_operation_id=payload.get("lastOperationId"),
        last_rollout_id=payload.get("lastRolloutId"),
        metadata=dict(payload.get("metadata") or {}),
    )


def save_state(config: AgentConfig, state: AgentState) -> None:
    config.state_dir.mkdir(parents=True, exist_ok=True)
    config.state_path.write_text(
        json.dumps(
            {
                "currentReleaseId": state.current_release_id,
                "lastKnownGoodReleaseId": state.last_known_good_release_id,
                "lastOperationId": state.last_operation_id,
                "lastRolloutId": state.last_rollout_id,
                "metadata": state.metadata,
            },
            indent=2,
            ensure_ascii=True,
        ),
        encoding="utf-8",
    )
