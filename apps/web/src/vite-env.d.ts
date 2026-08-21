/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_LEGIWATCH_LIVE_HEARINGS_V2?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
