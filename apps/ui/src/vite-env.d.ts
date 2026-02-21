/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly VITE_APPLE_CLIENT_ID?: string;
  readonly VITE_APPLE_REDIRECT_URI?: string;
  readonly VITE_DEBUG_MASTER_USER_ID?: string;
  readonly VITE_DEBUG_MASTER_USER_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
