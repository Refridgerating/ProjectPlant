.PHONY: help
help:
	@echo "Targets:"
	@echo "  setup   - placeholder for dev setup"
	@echo "  hub     - run hub (will be added)"
	@echo "  ui      - run UI (will be added)"
	@echo "  fw      - build firmware (will be added)"

.PHONY: hub
hub:
	uvicorn --app-dir apps/hub/src main:app --reload --host 0.0.0.0 --port 8000
