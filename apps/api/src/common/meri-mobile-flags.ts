/**
 * Native Meri API rollout controls.
 *
 * Mobile is default-closed behind a fleet switch, a canonical tenant-id
 * allowlist, and an explicit tenant flag. Individual capabilities have their
 * own fleet and tenant switches so each surface can be rolled back independently.
 */
export const MERI_MOBILE_API_FLAG = 'meri.mobileApi' as const;
export const MERI_MOBILE_CAPABILITY_FLAGS = {
  runs: 'meri.mobile.runs',
  meetings: 'meri.mobile.meetings',
  files: 'meri.mobile.files',
  deviceTokens: 'meri.mobile.deviceTokens',
} as const;

export type MeriMobileCapability = keyof typeof MERI_MOBILE_CAPABILITY_FLAGS;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function meriMobileEnvironmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERI_MOBILE_ENABLED === 'true';
}

export function meriMobilePilotTenantIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.MERI_MOBILE_PILOT_TENANT_IDS ?? '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => UUID_RE.test(id)),
  );
}

export function meriMobileTenantAllowed(
  tenantId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!meriMobileEnvironmentEnabled(env)) return false;
  const id = tenantId?.trim().toLowerCase();
  return Boolean(id && UUID_RE.test(id) && meriMobilePilotTenantIds(env).has(id));
}

export function meriMobileCapabilityEnvironmentEnabled(
  capability: MeriMobileCapability,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const names: Record<MeriMobileCapability, string> = {
    runs: 'MERI_MOBILE_RUNS_ENABLED',
    meetings: 'MERI_MOBILE_MEETINGS_ENABLED',
    files: 'MERI_MOBILE_FILES_ENABLED',
    deviceTokens: 'MERI_MOBILE_DEVICE_TOKENS_ENABLED',
  };
  return env[names[capability]] === 'true';
}
