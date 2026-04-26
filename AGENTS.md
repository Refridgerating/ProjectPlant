# ProjectPlant AGENTS.md

## Purpose
Define how agents build and modify ProjectPlant.  
This document establishes system boundaries, ownership, and workflow.

---

## System Architecture (Source of Truth)

ProjectPlant is a hub-centered system:

Clients (UI, Mobile)  
↓  
Hub API (FastAPI)  
↓  
Services Layer  
↓  
Care Engine | Weather | Device Manager | Scheduler  
↓  
Database + MQTT Broker  
↓  
ESP32 Devices  

### Rules
- Backend owns all logic and system state
- GUI is a thin client only
- Firmware executes commands, does not make decisions
- MQTT is the device interface, not the application API

---

## Component Ownership

### Hub API (`apps/hub_api/`)
- Owns system state
- Exposes REST/WebSocket API
- Validates and routes all inputs

Rule:
- No business logic in route handlers

---

### Services Layer
- `care_engine`: irrigation logic, ETo, plant rules
- `weather`: NOAA/HRRR ingestion and caching
- `device`: registry, state, command routing
- `scheduler`: automation and timing

Rule:
- All decision-making logic lives here

---

### GUI (`apps/web_ui`, `apps/web`, `apps/android`)
- Displays backend state
- Sends user commands to API

Rules:
- No irrigation, plant, or weather logic
- No duplication of backend models

---

### Firmware (`firmware/esp32_pot`)
- Reads sensors
- Executes commands
- Publishes telemetry via MQTT

Rule:
- No autonomous decision-making

---

### Shared Packages (`packages/`)
- `protocol`: MQTT schemas and topics
- `care-engine`: pure logic only
- `sdk`: typed API client

---

## Data Flow

Device → MQTT → Hub → Database  
                       ↓  
                  Care Engine  
                       ↓  
               Irrigation Decision  
                       ↓  
               MQTT Command → Device  

---

## Design Principles

### Backend-First
All features must exist in the backend before UI integration.

### Pure Logic Isolation
Care engine must be:
- deterministic
- testable
- independent of API and database

### Strong Contracts
- API schemas defined with Pydantic
- MQTT schemas defined in `packages/protocol`
- No ad-hoc payloads

### Incremental Refactor Only
- No large rewrites
- Move logic in vertical slices
- Preserve behavior unless explicitly changing it

---

## What NOT to Do

- Do not put logic in React components
- Do not duplicate models across frontend and backend
- Do not bypass the Hub API
- Do not embed hardware assumptions in backend logic
- Do not introduce breaking API changes without versioning

---

## Safety Constraints

- Default all hardware actions to OFF
- Never trigger pumps or valves in tests
- Do not modify credentials or network configuration without instruction

---

## Refactor Workflow

When refactoring:

1. Audit
   - Identify misplaced logic in UI or route handlers

2. Extract
   - Move logic into services or care_engine

3. Stabilize
   - Add or update tests

4. Expose
   - Add or modify API endpoints

5. Reconnect
   - Update UI to call API

---

## When to Ask

- Hardware-specific assumptions (ports, voltage, calibration)
- MQTT topic or schema changes
- Any action affecting live devices
- Ambiguous ownership between components

---

## Optional Dev Commands

Keep minimal. Expand only when necessary.

```bash
# Backend
make hub

# UI
pnpm -C apps/web_ui dev

# Tests
pytest
pnpm test