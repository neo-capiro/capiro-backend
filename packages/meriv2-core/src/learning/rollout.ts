export const LEARNING_TENANTS_ENV = 'LEARNING_TENANTS' as const;

/**
 * Exact, bounded tenant selector shared by EVERY Phase 27 institutional-
 * learning control: signal capture, candidate generation, quality telemetry
 * and evaluation. Deliberately the same shape, and the same fail-closed
 * semantics, as `governedMemoryTenantSelected` in
 * `../memory/governance-rollout` — a comma/space separated allowlist of
 * server-resolved tenant ids, with the literal `all` as the only
 * general-availability value.
 *
 * WHY this exists (Phase 27G §9). Every Phase 27 control shipped as a
 * PROCESS-WIDE boolean with no tenant dimension at all, so the only
 * available rollout granularity was "off everywhere" or "on for every
 * tenant in the cluster". `LEARNING_SIGNAL_CAPTURE` is the sharp edge:
 * unlike the other three it defaults to ON, so Phase 27A's deploy armed
 * capture for every tenant at once. That no customer tenant had yet
 * produced a row was luck — nobody outside the internal tenant happened to
 * use a wired surface — not a control. A controlled canary needs the blast
 * radius bounded by configuration, so this selector is ANDed into each
 * control's own switch.
 *
 * The two stay INDEPENDENT on purpose, because 27G requires each control to
 * be independently reversible: the per-control switch still kills that one
 * control everywhere regardless of the allowlist, and the allowlist still
 * bounds every control to named tenants regardless of the switches.
 *
 * Fails CLOSED: an unset or empty allowlist selects nothing. For capture
 * this deliberately flips the effective default from on-everywhere to
 * off-everywhere — a Phase 27 control should be armed by naming a tenant,
 * never merely by being deployed.
 *
 * Consumes a server-resolved tenant id; a browser-provided tenant hint is
 * never authority.
 */
export function learningTenantSelected(
  tenantId: string | null | undefined,
  rawTenants: string | undefined = process.env[LEARNING_TENANTS_ENV],
): boolean {
  const tenant = normalize(tenantId);
  if (!tenant) return false;
  const selected = tokens(rawTenants);
  return selected.includes('all') || selected.includes(tenant);
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
