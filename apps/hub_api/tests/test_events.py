import pytest
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from api.v1.events_router import stream_events


def _issue_token(client: TestClient) -> str:
    response = client.post("/api/v1/auth/token")
    assert response.status_code == 200
    body = response.json()
    return body["access_token"]


@pytest.mark.anyio
async def test_event_stream_returns_initial_snapshot(client: TestClient) -> None:
    token = _issue_token(client)
    response = await stream_events(token=token)
    assert isinstance(response, StreamingResponse)
    body_iter = response.body_iterator
    assert body_iter is not None
    chunk = await anext(body_iter)
    text = chunk.decode("utf-8")
    assert "event: init" in text
    assert '"telemetry"' in text
    if hasattr(body_iter, "aclose"):
        await body_iter.aclose()  # type: ignore[attr-defined]


def test_event_stream_requires_token(client: TestClient) -> None:
    response = client.get("/api/v1/events/stream", headers={})
    assert response.status_code == 401
