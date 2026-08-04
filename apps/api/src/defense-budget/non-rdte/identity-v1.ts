/**
 * identity-v1 — pure builders for non-RDT&E budget-line identities.
 *
 * Canonical extraction identities:
 *   PROCUREMENT_BLIN = component + appropriation account + line code + base/AP distinction
 *   OM_SAG           = component + appropriation/account + SAG/activity code
 *   MILCON_PROJECT   = component + appropriation + project number + installation/location context
 *
 * The fiscal year belongs to funding/quantity assertions, not the identity key.
 *
 * Rules:
 *   - Normalize only syntax required for matching (trim, uppercase).
 *   - Preserve exact printed codes separately.
 *   - Reject identities missing required account/component context.
 *   - Titles are aliases, never keys.
 *   - A PE code printed in P-40 narrative is an explicit cross-reference only.
 *   - Base procurement and advance procurement are distinct identities.
 *
 * Pure module. No side effects, no database access, no parser calls.
 */
import type { BudgetComponentV1 } from '../contracts/extraction-artifact-v1.js';

/* ------------------------------------------------------------------ */
/* Procurement BLIN identity                                            */
/* ------------------------------------------------------------------ */

export interface ProcurementBlinIdentityInput {
  /** P-1/P-40 Budget Line Item Number (BLIN) as printed. */
  code: string;
  /** Appropriation account code/title (e.g. "2031A: Aircraft Procurement, Army"). */
  account: string;
  /** Component/service (ARMY, NAVY, AF, etc.). */
  component: BudgetComponentV1;
  /** Base vs advance procurement designation. */
  advanceProcurement?: boolean;
}

export interface ProcurementBlinIdentityV1 {
  lineKind: 'PROCUREMENT_BLIN';
  /** Normalized code for matching (trimmed, uppercased). */
  code: string;
  /** Original printed code preserved exactly. */
  printedCode: string;
  /** Normalized account. */
  account: string;
  component: BudgetComponentV1;
  advanceProcurement: boolean;
  /**
   * Deterministic natural key string.
   * Format: PROCUREMENT_BLIN:{component}:{account}:{code}:{base|advance}
   * Used by extractors, reconciliation, projection plans, and tests.
   */
  naturalKey: string;
}

/**
 * Build a procurement BLIN identity.
 * Throws when code or account is blank.
 */
export function buildProcurementBlinIdentity(
  input: ProcurementBlinIdentityInput,
): ProcurementBlinIdentityV1 {
  const code = input.code.trim();
  if (code.length === 0) {
    throw new Error('procurement BLIN identity requires a non-blank code');
  }
  const account = input.account.trim();
  if (account.length === 0) {
    throw new Error('procurement BLIN identity requires a non-blank account');
  }
  if (input.component === 'UNKNOWN' || input.component === 'OTHER') {
    throw new Error(
      `procurement BLIN identity requires a concrete component, got "${input.component}"`,
    );
  }

  const advanceProcurement = input.advanceProcurement ?? false;
  const normalizedCode = code.toUpperCase();
  const normalizedAccount = account.toUpperCase();

  return {
    lineKind: 'PROCUREMENT_BLIN',
    code: normalizedCode,
    printedCode: code,
    account: normalizedAccount,
    component: input.component,
    advanceProcurement,
    naturalKey: `PROCUREMENT_BLIN:${input.component}:${normalizedAccount}:${normalizedCode}:${advanceProcurement ? 'advance' : 'base'}`,
  };
}

/* ------------------------------------------------------------------ */
/* O&M SAG identity                                                     */
/* ------------------------------------------------------------------ */

export interface OmSagIdentityInput {
  /** SAG/activity code as printed. */
  code: string;
  /** Appropriation/account (e.g. "O&M, Army"). */
  account: string;
  /** Component/service. */
  component: BudgetComponentV1;
}

export interface OmSagIdentityV1 {
  lineKind: 'OM_SAG';
  /** Normalized code for matching. */
  code: string;
  /** Original printed code preserved exactly. */
  printedCode: string;
  /** Normalized account. */
  account: string;
  component: BudgetComponentV1;
  /**
   * Deterministic natural key string.
   * Format: OM_SAG:{component}:{account}:{code}
   */
  naturalKey: string;
}

/**
 * Build an O&M SAG identity.
 * Throws when code or account is blank.
 */
export function buildOmSagIdentity(input: OmSagIdentityInput): OmSagIdentityV1 {
  const code = input.code.trim();
  if (code.length === 0) {
    throw new Error('O&M SAG identity requires a non-blank code');
  }
  const account = input.account.trim();
  if (account.length === 0) {
    throw new Error('O&M SAG identity requires a non-blank account');
  }
  if (input.component === 'UNKNOWN' || input.component === 'OTHER') {
    throw new Error(
      `O&M SAG identity requires a concrete component, got "${input.component}"`,
    );
  }

  const normalizedCode = code.toUpperCase();
  const normalizedAccount = account.toUpperCase();

  return {
    lineKind: 'OM_SAG',
    code: normalizedCode,
    printedCode: code,
    account: normalizedAccount,
    component: input.component,
    naturalKey: `OM_SAG:${input.component}:${normalizedAccount}:${normalizedCode}`,
  };
}

/* ------------------------------------------------------------------ */
/* MILCON project identity                                              */
/* ------------------------------------------------------------------ */

export interface MilconProjectIdentityInput {
  /** Project number as printed. */
  projectCode: string;
  /** Component/service. */
  component: BudgetComponentV1;
  /** Installation or source-defined location context. */
  location?: string;
  /** Appropriation account (required for full identity). */
  account?: string;
}

export interface MilconProjectIdentityV1 {
  lineKind: 'MILCON_PROJECT';
  /** Normalized project code for matching. */
  projectCode: string;
  /** Original printed project code preserved exactly. */
  printedProjectCode: string;
  component: BudgetComponentV1;
  /** Normalized location or undefined when not printed. */
  location?: string;
  /** Normalized account or undefined when not printed. */
  account?: string;
  /**
   * Deterministic natural key string.
   * Format: MILCON_PROJECT:{component}:{projectCode}:{location|'NO_LOC'}:{account|'NO_ACCT'}
   */
  naturalKey: string;
}

/**
 * Build a MILCON project identity.
 * Throws when projectCode is blank or component is UNKNOWN/OTHER.
 * Account and location are optional but strongly recommended.
 */
export function buildMilconProjectIdentity(
  input: MilconProjectIdentityInput,
): MilconProjectIdentityV1 {
  const projectCode = input.projectCode.trim();
  if (projectCode.length === 0) {
    throw new Error('MILCON project identity requires a non-blank project code');
  }
  if (input.component === 'UNKNOWN' || input.component === 'OTHER') {
    throw new Error(
      `MILCON project identity requires a concrete component, got "${input.component}"`,
    );
  }

  const normalizedProjectCode = projectCode.toUpperCase();
  const normalizedLocation = input.location?.trim().toUpperCase();
  const normalizedAccount = input.account?.trim().toUpperCase();

  const locPart = normalizedLocation ?? 'NO_LOC';
  const acctPart = normalizedAccount ?? 'NO_ACCT';

  return {
    lineKind: 'MILCON_PROJECT',
    projectCode: normalizedProjectCode,
    printedProjectCode: projectCode,
    component: input.component,
    ...(normalizedLocation != null ? { location: normalizedLocation } : {}),
    ...(normalizedAccount != null ? { account: normalizedAccount } : {}),
    naturalKey: `MILCON_PROJECT:${input.component}:${normalizedProjectCode}:${locPart}:${acctPart}`,
  };
}

/* ------------------------------------------------------------------ */
/* Natural-key string builders for external consumers                   */
/* ------------------------------------------------------------------ */

/**
 * Build a natural-key string from procurement identity components.
 * Input permutation produces identical natural keys.
 */
export function procurementBlinNaturalKey(
  code: string,
  account: string,
  component: BudgetComponentV1,
  advanceProcurement: boolean,
): string {
  return buildProcurementBlinIdentity({
    code,
    account,
    component,
    advanceProcurement,
  }).naturalKey;
}

/**
 * Build a natural-key string from O&M SAG identity components.
 */
export function omSagNaturalKey(
  code: string,
  account: string,
  component: BudgetComponentV1,
): string {
  return buildOmSagIdentity({ code, account, component }).naturalKey;
}

/**
 * Build a natural-key string from MILCON project identity components.
 */
export function milconProjectNaturalKey(
  projectCode: string,
  component: BudgetComponentV1,
  location?: string,
  account?: string,
): string {
  return buildMilconProjectIdentity({
    projectCode,
    component,
    location,
    account,
  }).naturalKey;
}

/* ------------------------------------------------------------------ */
/* Identity collision checks                                            */
/* ------------------------------------------------------------------ */

/**
 * Check whether two procurement identities would collide (same natural key).
 * Same short Navy line under different appropriation accounts remains distinct.
 */
export function procurementIdentitiesCollide(
  a: ProcurementBlinIdentityV1,
  b: ProcurementBlinIdentityV1,
): boolean {
  return a.naturalKey === b.naturalKey;
}

/**
 * Check whether two O&M SAG identities would collide.
 * Same SAG code under different O&M accounts remains distinct.
 */
export function omSagIdentitiesCollide(a: OmSagIdentityV1, b: OmSagIdentityV1): boolean {
  return a.naturalKey === b.naturalKey;
}

/**
 * Check whether two MILCON project identities would collide.
 * Same project number at different installations/components remains distinct.
 */
export function milconProjectIdentitiesCollide(
  a: MilconProjectIdentityV1,
  b: MilconProjectIdentityV1,
): boolean {
  return a.naturalKey === b.naturalKey;
}
