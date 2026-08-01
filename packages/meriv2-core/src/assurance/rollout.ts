import { ASSURANCE_SURFACES, type AssuranceSurface } from './risk-gate';

export type AssuranceRolloutMode = 'off' | 'shadow' | 'enforce';

export interface AssuranceRolloutInput {
  /** Global ceiling: MERI_RELEASE_GATE. */
  globalModeRaw: string | undefined;
  /** Explicit tenant canary list: MERI_RELEASE_GATE_TENANTS. */
  tenantCanariesRaw: string | undefined;
  /** Explicit surface list: MERI_RELEASE_GATE_SURFACES. */
  surfacesRaw: string | undefined;
  /** Server-resolved tenant id. Never accept this from a browser body. */
  tenantId: string;
  surface: AssuranceSurface;
}

/** Exact parser. Truthy-looking, misspelled, or future values fail closed to off. */
export function resolveAssuranceGlobalMode(raw: string | undefined): AssuranceRolloutMode {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'shadow') return 'shadow';
  if (value === 'enforce') return 'enforce';
  return 'off';
}

/**
 * Resolve the effective cross-surface mode. All three controls are required:
 * global ceiling, tenant canary, and surface selection. A deploy with only one
 * switch set changes no behavior.
 */
export function resolveAssuranceRolloutMode(input: AssuranceRolloutInput): AssuranceRolloutMode {
  const global = resolveAssuranceGlobalMode(input.globalModeRaw);
  if (global === 'off') return 'off';
  if (!tokenSelected(input.tenantCanariesRaw, input.tenantId)) return 'off';
  if (!surfaceSelected(input.surfacesRaw, input.surface)) return 'off';
  return global;
}

export function assuranceRolloutEnabled(mode: AssuranceRolloutMode): boolean {
  return mode === 'shadow' || mode === 'enforce';
}

export function assuranceRolloutEnforced(mode: AssuranceRolloutMode): boolean {
  return mode === 'enforce';
}

export function resolveAssuranceTenantCanaries(raw: string | undefined): ReadonlySet<string> {
  const tokens = parseTokens(raw);
  if (tokens.includes('all')) return new Set(['all']);
  return new Set(tokens.filter((token) => token !== 'all'));
}

export function resolveAssuranceCanarySurfaces(
  raw: string | undefined,
): ReadonlySet<AssuranceSurface> {
  const tokens = parseTokens(raw);
  if (tokens.includes('all')) return new Set(ASSURANCE_SURFACES);
  const known = new Set<string>(ASSURANCE_SURFACES);
  return new Set(tokens.filter((token): token is AssuranceSurface => known.has(token)));
}

function tokenSelected(raw: string | undefined, expected: string): boolean {
  const normalized = String(expected ?? '').trim().toLowerCase();
  if (!normalized) return false;
  const tokens = resolveAssuranceTenantCanaries(raw);
  return tokens.has('all') || tokens.has(normalized);
}

function surfaceSelected(raw: string | undefined, surface: AssuranceSurface): boolean {
  return resolveAssuranceCanarySurfaces(raw).has(surface);
}

function parseTokens(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(/[,\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}
