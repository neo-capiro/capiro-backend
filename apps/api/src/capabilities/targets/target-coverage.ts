import type { OutreachResolvedTargetRefV1 } from './outreach-target.contract.js';

export const TARGET_HEALTH_CODES = [
  'EMAIL_MISSING',
  'EMAIL_INVALID',
  'ROLE_HISTORICAL',
  'ROLE_UNKNOWN',
  'PROFILE_LIMITED',
  'PROFILE_UNAVAILABLE',
  'DUPLICATE_EMAIL',
] as const;

export const TARGET_COVERAGE_GAP_CODES = [
  'NO_TARGETS',
  'NO_CONTACTABLE_TARGETS',
  'STAFF_COVERAGE_MISSING',
  'PRINCIPAL_COVERAGE_MISSING',
  'CHAMBER_COVERAGE_MISSING',
  'COMMITTEE_COVERAGE_MISSING',
  'STATE_COVERAGE_MISSING',
  'EXISTING_RELATIONSHIP_NOT_PROVEN',
] as const;

export type TargetHealthCode = (typeof TARGET_HEALTH_CODES)[number];
export type TargetCoverageGapCode = (typeof TARGET_COVERAGE_GAP_CODES)[number];

export interface TargetCoverageCriteriaV1 {
  chambers: readonly string[];
  committees: readonly string[];
  states: readonly string[];
  relationshipPreference: 'any' | 'existing' | 'new' | 'mixed';
  includeStaff: boolean;
  includePrincipals: boolean;
}

export interface TargetHealthResultV1 {
  targetKey: string;
  displayName: string;
  readyForDrafting: boolean;
  readyForSending: boolean;
  healthCodes: TargetHealthCode[];
}

export interface TargetCoverageGapV1 {
  code: TargetCoverageGapCode;
  label: string;
  requestedValues: string[];
}

export interface TargetCoverageV1 {
  status: 'empty' | 'partial' | 'complete';
  selectedCount: number;
  draftingReadyCount: number;
  sendReadyCount: number;
  staffCount: number;
  principalCount: number;
  chambers: string[];
  committees: string[];
  states: string[];
  duplicateEmailGroups: Array<{ email: string; targetKeys: string[] }>;
  health: TargetHealthResultV1[];
  gaps: TargetCoverageGapV1[];
}

export function deriveTargetCoverage(
  criteria: TargetCoverageCriteriaV1 | null,
  targets: readonly OutreachResolvedTargetRefV1[],
): TargetCoverageV1 {
  const duplicateEmailGroups = duplicatesByEmail(targets);
  const duplicateKeys = new Set(duplicateEmailGroups.flatMap((group) => group.targetKeys));
  const health = [...targets]
    .sort((a, b) => compare(a.targetKey, b.targetKey))
    .map((target) => targetHealth(target, duplicateKeys));
  const staff = targets.filter((target) => target.locator.source === 'directory_staff');
  const principals = targets.filter((target) => target.locator.source !== 'directory_staff');
  const chambers = normalizedSet(targets.map((target) => target.jurisdiction.chamber));
  const committees = normalizedSet(targets.flatMap((target) => target.jurisdiction.committees));
  const states = normalizedSet(targets.map((target) => target.jurisdiction.state));
  const gaps: TargetCoverageGapV1[] = [];

  if (!targets.length) {
    gaps.push({ code: 'NO_TARGETS', label: 'No targets are selected.', requestedValues: [] });
  }
  if (targets.length && health.every((entry) => !entry.readyForSending)) {
    gaps.push({
      code: 'NO_CONTACTABLE_TARGETS',
      label: 'No selected target currently has a usable email and current role.',
      requestedValues: [],
    });
  }
  if (criteria?.includeStaff && staff.length === 0) {
    gaps.push({
      code: 'STAFF_COVERAGE_MISSING',
      label: 'The target criteria request staff coverage, but no staff targets are selected.',
      requestedValues: [],
    });
  }
  if (criteria?.includePrincipals && principals.length === 0) {
    gaps.push({
      code: 'PRINCIPAL_COVERAGE_MISSING',
      label: 'The target criteria request principal coverage, but no principals are selected.',
      requestedValues: [],
    });
  }
  if (criteria?.chambers.length) {
    const missing = criteria.chambers.filter(
      (requested) => !chambers.some((actual) => chamberMatches(requested, actual)),
    );
    if (missing.length) {
      gaps.push({
        code: 'CHAMBER_COVERAGE_MISSING',
        label: 'One or more requested chambers are not represented.',
        requestedValues: [...missing].sort(compare),
      });
    }
  }
  if (criteria?.committees.length) {
    const missing = criteria.committees.filter(
      (requested) => !committees.some((actual) => textMatches(requested, actual)),
    );
    if (missing.length) {
      gaps.push({
        code: 'COMMITTEE_COVERAGE_MISSING',
        label: 'One or more requested committees are not represented.',
        requestedValues: [...missing].sort(compare),
      });
    }
  }
  if (criteria?.states.length) {
    const missing = criteria.states.filter(
      (requested) => !states.some((actual) => textMatches(requested, actual)),
    );
    if (missing.length) {
      gaps.push({
        code: 'STATE_COVERAGE_MISSING',
        label: 'One or more requested states are not represented.',
        requestedValues: [...missing].sort(compare),
      });
    }
  }
  if (criteria?.relationshipPreference === 'existing') {
    gaps.push({
      code: 'EXISTING_RELATIONSHIP_NOT_PROVEN',
      label: 'Relationship preference requires a live relationship analysis before it is satisfied.',
      requestedValues: ['existing'],
    });
  }

  const draftingReadyCount = health.filter((entry) => entry.readyForDrafting).length;
  const sendReadyCount = health.filter((entry) => entry.readyForSending).length;
  return {
    status: !targets.length ? 'empty' : gaps.length ? 'partial' : 'complete',
    selectedCount: targets.length,
    draftingReadyCount,
    sendReadyCount,
    staffCount: staff.length,
    principalCount: principals.length,
    chambers,
    committees,
    states,
    duplicateEmailGroups,
    health,
    gaps: gaps.sort((a, b) => compare(a.code, b.code)),
  };
}

function targetHealth(
  target: OutreachResolvedTargetRefV1,
  duplicateKeys: Set<string>,
): TargetHealthResultV1 {
  const healthCodes: TargetHealthCode[] = [];
  if (target.emailStatus === 'missing') healthCodes.push('EMAIL_MISSING');
  if (target.emailStatus === 'invalid') healthCodes.push('EMAIL_INVALID');
  if (target.roleStatus === 'historical') healthCodes.push('ROLE_HISTORICAL');
  if (target.roleStatus === 'unknown') healthCodes.push('ROLE_UNKNOWN');
  if (target.profileStatus === 'limited') healthCodes.push('PROFILE_LIMITED');
  if (target.profileStatus === 'unavailable') healthCodes.push('PROFILE_UNAVAILABLE');
  if (duplicateKeys.has(target.targetKey)) healthCodes.push('DUPLICATE_EMAIL');
  healthCodes.sort(compare);
  return {
    targetKey: target.targetKey,
    displayName: target.displayName,
    readyForDrafting: target.profileStatus !== 'unavailable' && target.roleStatus !== 'historical',
    readyForSending:
      target.emailStatus === 'available' &&
      target.roleStatus === 'current' &&
      target.profileStatus !== 'unavailable' &&
      !duplicateKeys.has(target.targetKey),
    healthCodes,
  };
}

function duplicatesByEmail(
  targets: readonly OutreachResolvedTargetRefV1[],
): Array<{ email: string; targetKeys: string[] }> {
  const groups = new Map<string, string[]>();
  for (const target of targets) {
    const email = target.email?.toLowerCase();
    if (!email) continue;
    const list = groups.get(email) ?? [];
    list.push(target.targetKey);
    groups.set(email, list);
  }
  return [...groups.entries()]
    .filter(([, targetKeys]) => targetKeys.length > 1)
    .map(([email, targetKeys]) => ({ email, targetKeys: [...targetKeys].sort(compare) }))
    .sort((a, b) => compare(a.email, b.email));
}

function normalizedSet(values: readonly (string | null)[]): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => Boolean(value))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort(compare);
}

function chamberMatches(requested: string, actual: string): boolean {
  const req = requested.toLowerCase().replace('state_', '');
  const act = actual.toLowerCase();
  if (requested.startsWith('state_')) {
    return (
      act.includes(req) ||
      (req === 'house' && act === 'lower') ||
      (req === 'senate' && act === 'upper')
    );
  }
  return act === req;
}

function textMatches(a: string, b: string): boolean {
  const left = a.toLowerCase().trim();
  const right = b.toLowerCase().trim();
  return left.includes(right) || right.includes(left);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
