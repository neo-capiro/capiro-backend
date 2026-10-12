/** Canonical, fail-closed per-tenant boolean feature reader. */
export function tenantFeatureEnabled(
  settings: unknown,
  flag: string,
  defaultValue: boolean,
): boolean {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const flags = (settings as Record<string, unknown>).clioFeatureFlags;
    if (flags && typeof flags === 'object' && !Array.isArray(flags)) {
      const value = (flags as Record<string, unknown>)[flag];
      if (typeof value === 'boolean') return value;
    }
  }
  return defaultValue;
}
