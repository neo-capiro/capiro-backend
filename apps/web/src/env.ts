/**
 * Resolves the web app's runtime config.
 *
 * Two sources, in order:
 *   1. window.__CAPIRO_CONFIG__  , set by /runtime-config.js, generated at
 *      container start by apps/web/nginx/entrypoint.sh. Used in deployed
 *      environments. The same Vite-built image promotes through dev → prod
 *      because the keys are NOT baked into the bundle.
 *   2. Vite import.meta.env.VITE_* , used for local `pnpm dev` against a
 *      .env file. Vite substitutes these at build time.
 *
 * The Clerk publishable key is technically public, but routing it through
 * runtime config keeps the build artifact env-agnostic.
 */

/**
 * Basemap defaults (plan §4.4). OpenFreeMap Positron is key-free, has no
 * request limits and permits commercial use, so the map works out of the box:
 * a missing env var degrades to a working default rather than a blank canvas.
 */
export const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
export const DEFAULT_MAP_STYLE_ATTRIBUTION = '© OpenStreetMap contributors';

interface RuntimeConfig {
  clerkPublishableKey: string;
  apiBaseUrl: string;
  appEnv?: string;
  /** Optional. Absent OR empty string falls back to the default above. */
  mapStyleUrl?: string;
  mapStyleAttribution?: string;
}

declare global {
  interface Window {
    __CAPIRO_CONFIG__?: RuntimeConfig;
  }
}

function loadConfig(): RuntimeConfig {
  if (typeof window !== 'undefined' && window.__CAPIRO_CONFIG__) {
    const c = window.__CAPIRO_CONFIG__;
    if (!c.clerkPublishableKey || c.clerkPublishableKey === 'runtime') {
      throw new Error(
        'runtime-config.js was loaded but clerkPublishableKey is missing, check ECS env vars',
      );
    }
    return c;
  }

  const env = import.meta.env;
  const clerkKey = env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
  if (!clerkKey || clerkKey === 'runtime') {
    throw new Error(
      'No runtime config found and VITE_CLERK_PUBLISHABLE_KEY is not set, see .env.example',
    );
  }
  return {
    clerkPublishableKey: clerkKey,
    apiBaseUrl:
      (env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
    appEnv: 'local',
    mapStyleUrl: env.VITE_MAP_STYLE_URL as string | undefined,
    mapStyleAttribution: env.VITE_MAP_STYLE_ATTRIBUTION as string | undefined,
  };
}

export const config: RuntimeConfig = loadConfig();

/**
 * The basemap style to render, with the default applied.
 *
 * Treats an EMPTY STRING as absent, which matters: entrypoint.sh always emits
 * the key, so an unset container var arrives as '' rather than undefined. A
 * plain `??` would hand MapLibre an empty style URL and blank the map.
 */
export const mapStyleUrl: string = config.mapStyleUrl?.trim() || DEFAULT_MAP_STYLE_URL;

export const mapStyleAttribution: string =
  config.mapStyleAttribution?.trim() || DEFAULT_MAP_STYLE_ATTRIBUTION;
