import { ASSURANCE_SURFACES, type AssuranceSurface } from '../assurance/risk-gate';
import { parseRolloutTokens } from './tokens';

export type CapabilityRolloutMode = 'off' | 'shadow' | 'enforce';
export type CapabilityRolloutEnvironment = Readonly<Record<string, string | undefined>>;

export interface CapabilityRolloutConfigInput {
  capability: string;
  env: CapabilityRolloutEnvironment;
}

export interface CapabilityRolloutInput extends CapabilityRolloutConfigInput {
  tenantId: string | null | undefined;
  surface: AssuranceSurface;
}

export interface CapabilityRolloutResult {
  mode: CapabilityRolloutMode;
  reasons: string[];
}

export interface CapabilityRolloutValidation {
  ok: boolean;
  issues: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_SURFACES = new Set<string>(ASSURANCE_SURFACES);

function keys(capability: string): { mode: string; tenants: string; surfaces: string } {
  const prefix = `MERI_${capability}`;
  return { mode: `${prefix}_MODE`, tenants: `${prefix}_TENANTS`, surfaces: `${prefix}_SURFACES` };
}

function configuredMode(raw: string | undefined): CapabilityRolloutMode | undefined {
  const mode = String(raw ?? '').trim().toLowerCase();
  return mode === 'off' || mode === 'shadow' || mode === 'enforce' ? mode : undefined;
}

function tenantConfig(raw: string | undefined): { selected: ReadonlySet<string>; issues: string[] } {
  const tokens = parseRolloutTokens(raw);
  const invalid = tokens.filter((token) => token !== 'all' && !UUID_RE.test(token));
  const valid = tokens.filter((token) => token === 'all' || UUID_RE.test(token));
  return {
    selected: new Set(valid.includes('all') ? ['all'] : valid),
    issues: invalid.map((token) => `invalid_tenant:${token}`),
  };
}

function surfaceConfig(raw: string | undefined): {
  selected: ReadonlySet<AssuranceSurface>;
  issues: string[];
} {
  const tokens = parseRolloutTokens(raw);
  const invalid = tokens.filter((token) => !KNOWN_SURFACES.has(token));
  const valid = tokens.filter((token): token is AssuranceSurface => KNOWN_SURFACES.has(token));
  return {
    selected: new Set(valid),
    issues: invalid.map((token) => `invalid_surface:${token}`),
  };
}

export function validateCapabilityRolloutConfig(
  input: CapabilityRolloutConfigInput,
): CapabilityRolloutValidation {
  const envKeys = keys(input.capability);
  const issues: string[] = [];
  if (!configuredMode(input.env[envKeys.mode])) issues.push('invalid_mode');
  issues.push(...tenantConfig(input.env[envKeys.tenants]).issues);
  issues.push(...surfaceConfig(input.env[envKeys.surfaces]).issues);
  return { ok: issues.length === 0, issues };
}

export function resolveCapabilityRollout(input: CapabilityRolloutInput): CapabilityRolloutResult {
  const envKeys = keys(input.capability);
  const mode = configuredMode(input.env[envKeys.mode]);
  const tenants = tenantConfig(input.env[envKeys.tenants]);
  const surfaces = surfaceConfig(input.env[envKeys.surfaces]);
  const reasons = [...(mode ? [] : ['invalid_mode']), ...tenants.issues, ...surfaces.issues];
  const tenantId = input.tenantId?.trim().toLowerCase();
  const tenantSelected = Boolean(
    tenantId && UUID_RE.test(tenantId) && (tenants.selected.has('all') || tenants.selected.has(tenantId)),
  );
  if (!tenantSelected) reasons.push('tenant_not_enrolled');
  if (!surfaces.selected.has(input.surface)) reasons.push('surface_not_enrolled');
  const invalidEnrollmentConfig = tenants.issues.length > 0 || surfaces.issues.length > 0;
  return {
    mode: mode && mode !== 'off' && !invalidEnrollmentConfig
      && tenantSelected && surfaces.selected.has(input.surface) ? mode : 'off',
    reasons,
  };
}
