export const MEMORY_GOVERNANCE_TENANTS_ENV = 'MEMORY_GOVERNANCE_TENANTS' as const;

/**
 * Exact, bounded tenant selector shared by API and orchestrator adapters.
 *
 * An empty tenant, unset allowlist, or near-match stays off. `all` is accepted
 * only as an explicit general-availability value. The selector consumes a
 * server-resolved tenant id; a browser-provided tenant hint is never authority.
 */
export function governedMemoryTenantSelected(
  tenantId: string | null | undefined,
  rawTenants: string | undefined = process.env[MEMORY_GOVERNANCE_TENANTS_ENV],
): boolean {
  const tenant = normalize(tenantId);
  if (!tenant) return false;
  const selected = tokens(rawTenants);
  return selected.includes('all') || selected.includes(tenant);
}

export function governedMemoryModeEnabledForTenant(
  tenantId: string | null | undefined,
  rawMode: string | undefined,
  rawTenants: string | undefined = process.env[MEMORY_GOVERNANCE_TENANTS_ENV],
): boolean {
  return exactEnforce(rawMode) && governedMemoryTenantSelected(tenantId, rawTenants);
}

export function exactEnforce(raw: string | undefined): boolean {
  return normalize(raw) === 'enforce';
}

function tokens(raw: string | undefined): string[] {
  return [
    ...new Set(
      String(raw ?? '')
        .split(/[,\s]+/)
        .map(normalize)
        .filter(Boolean),
    ),
  ];
}

function normalize(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}
