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

## Google Sign-In (optional)
Set `VITE_GOOGLE_CLIENT_ID` in your UI environment if you want to render the native Google Sign-In button in Settings.
The hub must also be configured with `GOOGLE_OAUTH_ENABLED=true` and matching `GOOGLE_OAUTH_CLIENT_IDS`.

## Apple Sign-In (optional)
Set `VITE_APPLE_CLIENT_ID` (and optionally `VITE_APPLE_REDIRECT_URI`) in your UI environment to enable Apple sign-in on the login page.
The hub must also be configured with `APPLE_OAUTH_ENABLED=true` and matching `APPLE_OAUTH_CLIENT_IDS`.

## Debug Master Account (optional)
Set `VITE_DEBUG_MASTER_USER_ID` (and optionally `VITE_DEBUG_MASTER_USER_NAME`) to preload a fallback local user id for development while unauthenticated.
Use `/api/v1/auth/local` to obtain a bearer token with email/password.
