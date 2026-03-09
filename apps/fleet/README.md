# ProjectPlant Fleet

ProjectPlant Fleet is the private fleet-management control plane for Raspberry Pi hubs.

## Features
- Hub enrollment with one-time bootstrap tokens and Ed25519 identity keys.
- Signed agent check-ins with desired-operation responses.
- Hub inventory, releases, rollouts, and rollback orchestration.
- Local artifact storage for signed release bundles.
- SQLite-backed persistence suitable for a single-tenant private deployment.

## Local start
```bash
cd apps/fleet
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8100
```

## Environment
- `FLEET_DATABASE_PATH`: SQLite path. Default `data/fleet.sqlite3`.
- `FLEET_ARTIFACT_DIR`: Artifact storage directory. Default `data/artifacts`.
- `FLEET_BOOTSTRAP_TOKENS`: Optional comma-separated bootstrap token list for development.
- `FLEET_RELEASE_PUBLIC_KEY_PATH`: Optional path to the Ed25519 public key used to verify release manifests.
- `AUTH_JWT_SECRET`: Shared HMAC secret for operator bearer tokens.

## Endpoints
- `POST /api/v1/hubs/enroll`
- `POST /api/v1/hubs/check-in`
- `GET /api/v1/hubs`
- `GET /api/v1/hubs/{hubId}`
- `PATCH /api/v1/hubs/{hubId}`
- `POST /api/v1/hubs/{hubId}/rollback`
- `POST /api/v1/releases`
- `GET /api/v1/releases`
- `GET /api/v1/releases/{releaseId}`
- `GET /api/v1/releases/{releaseId}/artifacts/{artifactName}`
- `POST /api/v1/rollouts`
- `GET /api/v1/rollouts/{rolloutId}`
- `POST /api/v1/rollouts/{rolloutId}/pause`
- `POST /api/v1/rollouts/{rolloutId}/resume`
