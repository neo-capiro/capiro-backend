/**
 * Boot config, fetched (unauthenticated) from the onboard-api before React
 * mounts. Same-origin in prod (one container serves SPA + API); the Vite dev
 * proxy forwards /onboard-api to localhost:4400 locally.
 */
export interface OnboardConfig {
  clerkPublishableKey: string | null;
  stripePublishableKey: string | null;
  appBaseUrl: string;
  apiBaseUrl: string;
  onboardingBaseUrl: string;
  funnelEnabled: boolean;
  environment: string;
}

export async function fetchConfig(): Promise<OnboardConfig> {
  const res = await fetch('/onboard-api/public/config', { credentials: 'omit' });
  if (!res.ok) {
    throw new Error(`Config fetch failed: ${res.status}`);
  }
  return (await res.json()) as OnboardConfig;
}
