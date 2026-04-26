from __future__ import annotations

import json
import sys
from pathlib import Path


HUB_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = HUB_ROOT / "src"
OUTPUT_PATH = HUB_ROOT / "openapi.json"


def main() -> None:
    sys.path.insert(0, str(SRC_ROOT))

    from main import create_app

    app = create_app()
    schema = app.openapi()
    OUTPUT_PATH.write_text(
        json.dumps(schema, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {OUTPUT_PATH.relative_to(HUB_ROOT)}")


if __name__ == "__main__":
    main()
