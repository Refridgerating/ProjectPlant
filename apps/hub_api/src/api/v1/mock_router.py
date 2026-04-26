from fastapi import APIRouter, Query
from mock.data import telemetry_payload

mock_router = APIRouter(prefix="/mock", tags=["mock"])

@mock_router.get("/telemetry")
def get_mock_telemetry(samples: int = Query(default=24, ge=1, le=168)):
    return {"samples": samples, "data": telemetry_payload(samples=samples)}
