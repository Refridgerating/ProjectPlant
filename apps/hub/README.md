# Hub (FastAPI) — minimal skeleton

## Run (option A: pip/venv)
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn --app-dir apps/hub/src main:app --reload --host 0.0.0.0 --port 8000

## Run (option B: uv + pyproject)
# if you use uv:
# uv run uvicorn --app-dir apps/hub/src main:app --reload --host 0.0.0.0 --port 8000

Open http://localhost:8000/health to verify.
