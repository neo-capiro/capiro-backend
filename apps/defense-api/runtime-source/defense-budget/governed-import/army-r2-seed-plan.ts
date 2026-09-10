/**
 * Phase 10B-19 Part N — pure seed-planning logic for
 * `seed-army-r2-bundle-members-v1.ts`, split out so the identity-mismatch
 * check and the create/skip plan are directly unit-testable without a
 * database.
 */
import { ARMY_RDTE_VOLUME_CATALOG, armyRdteOfficialUrl, armyRdteTitle } from '@capiro/defense-domain';

export const ARMY_FY24_R2_EXPECTED_IDENTITY = Object.freeze({
  fiscalYear: 2024,
  authorityTrack: 'request',
  stage: 'president_budget_request',
  sourceFamily: 'pb_r2',
  component: 'ARMY',
});

export interface ExpectedSourceIdentityFacts {
  readonly fiscalYear: number;
  readonly authorityTrack: string;
  readonly stage: string;
  readonly sourceFamily: string;
  readonly component: string | null;
}

/**
 * Fail-closed identity check (Part C, "critical"): refuses to seed the WHOLE
 * manifest unless the named expected source is exactly the identity every
 * catalog entry declares. Belt-and-suspenders on top of the DB trigger
 * (`defense_budget_source_bundle_member_identity_chk`) — checking here means
 * zero partial-seed state instead of N-1 rows succeeding before the Nth
 * insert throws.
 */
export function checkArmyR2ExpectedSourceIdentity(
  expectedSource: ExpectedSourceIdentityFacts,
): readonly string[] {
  const mismatches: string[] = [];
  const expected = ARMY_FY24_R2_EXPECTED_IDENTITY;
  if (expectedSource.fiscalYear !== expected.fiscalYear) {
    mismatches.push(`fiscalYear: expected ${expected.fiscalYear}, source is ${expectedSource.fiscalYear}`);
  }
  if (expectedSource.authorityTrack !== expected.authorityTrack) {
    mismatches.push(`authorityTrack: expected ${expected.authorityTrack}, source is ${expectedSource.authorityTrack}`);
  }
  if (expectedSource.stage !== expected.stage) {
    mismatches.push(`stage: expected ${expected.stage}, source is ${expectedSource.stage}`);
  }
  if (expectedSource.sourceFamily !== expected.sourceFamily) {
    mismatches.push(`sourceFamily: expected ${expected.sourceFamily}, source is ${expectedSource.sourceFamily}`);
  }
  if (expectedSource.component !== expected.component) {
    mismatches.push(`component: expected ${expected.component}, source is ${expectedSource.component}`);
  }
  return mismatches;
}

export interface ArmyR2SeedPlanRow {
  readonly memberKey: string;
  readonly volume: string;
  readonly budgetActivity: string;
  readonly required: boolean;
  readonly officialUrl: string;
  readonly title: string;
  readonly alreadyExists: boolean;
  readonly existingStatus: string | null;
}

/**
 * Idempotent by `memberKey`: a member already present is reported but never
 * rewritten (never regresses an existing `verified`/`observed` row back to a
 * fresh `missing` insert, and this plan never even attempts an UPDATE on an
 * existing row).
 */
export function buildArmyR2SeedPlan(input: {
  fiscalYear: number;
  existingMemberKeys: ReadonlyMap<string, string>;
}): readonly ArmyR2SeedPlanRow[] {
  return ARMY_RDTE_VOLUME_CATALOG.map((entry) => ({
    memberKey: entry.memberKey,
    volume: entry.volume,
    budgetActivity: entry.budgetActivity,
    required: entry.required,
    officialUrl: armyRdteOfficialUrl(entry, input.fiscalYear),
    title: armyRdteTitle(entry, input.fiscalYear),
    alreadyExists: input.existingMemberKeys.has(entry.memberKey),
    existingStatus: input.existingMemberKeys.get(entry.memberKey) ?? null,
  }));
}
