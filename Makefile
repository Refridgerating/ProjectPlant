.PHONY: help fleet hub fleet-ui ui stack

help:
	@echo "Targets:"
	@echo "  stack     - preferred: start the Windows recovery stack with managed env + dynamic local ports"
	@echo "  fleet     - debug only: run fleet API on 8100 without launcher preflight"
	@echo "  hub       - debug only: run hub API on 8000 without managed runtime injection"
	@echo "  fleet-ui  - debug only: run fleet UI on 5180 without launcher URL injection"
	@echo "  ui        - debug only: run hub UI on 5173 without launcher proxy injection"

fleet:
	cd apps/fleet && python -m uvicorn --app-dir src main:app --reload --host 0.0.0.0 --port 8100

hub:
	cd apps/hub_api && python -m uvicorn --app-dir src main:app --reload --host 0.0.0.0 --port 8000

fleet-ui:
	pnpm -C apps/fleet-ui dev --host 127.0.0.1 --port 5180

ui:
	pnpm -C apps/web_ui dev --host 127.0.0.1 --port 5173

stack:
	powershell -ExecutionPolicy Bypass -File scripts/dev-stack.ps1
