# ProjectPlant Fleet

ProjectPlant Fleet is the private fleet-management control plane for Raspberry Pi hubs.

## Features
- Hub enrollment with one-time bootstrap tokens and Ed25519 identity keys.
- Signed agent check-ins with desired-operation responses.
- Hub inventory, releases, rollouts, and rollback orchestration.
- Local artifact storage for signed release bundles.
- SQLite-backed persistence suitable for a single-tenant private deployment.

## Local start
Preferred Windows recovery flow:
```powershell
powershell -ExecutionPolicy Bypass -File ..\..\scripts\dev-stack.ps1
```

Manual start remains available for debugging only:
```bash
cd apps/fleet
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn --app-dir src main:app --reload --host 0.0.0.0 --port 8100
```

Manual startup does not inject managed recovery env, generated CORS origins, or dynamic UI URLs.

## Environment
- `DEBUG`: Enables verbose logging. Accepts standard booleans plus aliases such as `debug`, `development`, `release`, and `production`.
- `FLEET_DATABASE_PATH`: SQLite path. Relative values resolve from `apps/fleet`. Default `data/fleet.sqlite3`.
- `FLEET_ARTIFACT_DIR`: Artifact storage directory. Relative values resolve from `apps/fleet`. Default `data/artifacts`.
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
