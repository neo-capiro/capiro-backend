export const MERIV3_CHAT_FLAG = 'meriv3.fullChat' as const;

export function meriV3EnvironmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERIV3_ENABLED === 'true';
}

export function meriV3CanaryTenantSlugs(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.MERIV3_CANARY_TENANT_SLUGS?.trim() || 'capiro-internal';
  return new Set(
    raw
      .split(',')
      .map((slug) => slug.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function meriV3TenantFlagEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const flags = (settings as Record<string, unknown>).clioFeatureFlags;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) return false;
  return (flags as Record<string, unknown>)[MERIV3_CHAT_FLAG] === true;
}

/**
 * MeriV3 is a three-key canary: global switch, server-resolved tenant slug
 * allowlist, and an explicit per-tenant flag. Every key defaults closed.
 */
export function meriV3ChatActive(
  settings: unknown,
  tenantSlug: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!meriV3EnvironmentEnabled(env)) return false;
  const slug = tenantSlug?.trim().toLowerCase();
  if (!slug || !meriV3CanaryTenantSlugs(env).has(slug)) return false;
  return meriV3TenantFlagEnabled(settings);
}
