/**
 * Resolves the web app's runtime config.
 *
 * Two sources, in order:
 *   1. window.__CAPIRO_CONFIG__, set by /runtime-config.js at container start.
 *   2. Vite import.meta.env.VITE_*, used only for explicit local development.
 *
 * The deployed web surface is selected by runtime configuration. Hostname
 * detection is intentionally not used as the production switch.
 */

export const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
export const DEFAULT_MAP_STYLE_ATTRIBUTION = '© OpenStreetMap contributors';

export interface RuntimeConfig {
  clerkPublishableKey: string;
  apiBaseUrl: string;
  appEnv?: string;
  /** Optional. Absent OR empty string falls back to the default above. */
  mapStyleUrl?: string;
  mapStyleAttribution?: string;
  /** Runtime presentation surface. `vnext` is injected only by WebVNextStack. */
  webSurface?: string;
  /** Exact release SHA injected into the deployed vNext task definition. */
  releaseSha?: string;
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
    apiBaseUrl: (env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin,
    appEnv: 'local',
    mapStyleUrl: env.VITE_MAP_STYLE_URL as string | undefined,
    mapStyleAttribution: env.VITE_MAP_STYLE_ATTRIBUTION as string | undefined,
    // Explicit local-only fallback for developers who need to exercise the
    // alternate presentation bundle. Production selection still comes from
    // runtime-config.js generated from ECS environment variables.
    webSurface: env.VITE_WEB_SURFACE as string | undefined,
    releaseSha: env.VITE_RELEASE_SHA as string | undefined,
  };
}

export const config: RuntimeConfig = loadConfig();

export function runtimeConfigIsVNext(value: Pick<RuntimeConfig, 'webSurface'>): boolean {
  return value.webSurface?.trim().toLowerCase() === 'vnext';
}

/** Canonical production switch for the vNext presentation surface. */
export const isVNextSurface = runtimeConfigIsVNext(config);

export const mapStyleUrl: string = config.mapStyleUrl?.trim() || DEFAULT_MAP_STYLE_URL;

export const mapStyleAttribution: string =
  config.mapStyleAttribution?.trim() || DEFAULT_MAP_STYLE_ATTRIBUTION;
