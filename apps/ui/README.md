# ProjectPlant UI

This Vite + React + Tailwind app provides the monitoring dashboard for the ProjectPlant Hub.

## Prerequisites
- Node.js 18+
- The FastAPI hub running locally on http://127.0.0.1:8000

## Getting started
```
npm install
npm run dev
```
Run these commands inside `apps/ui`. The dev server listens on http://127.0.0.1:5173 with `/api` proxied to the hub.

## Testing
```
npm test
```
Vitest and Testing Library power the unit tests. CSS is processed through Tailwind for component snapshots.

## Build
```
npm run build
npm run preview
```
The build output lives in `dist/` and can be served by any static host or bundled with Tauri/Capacitor later.
