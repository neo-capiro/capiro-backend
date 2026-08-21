/**
 * Phase 8 Session 7 — Annual Defense Budget Cycle + Lifecycle Watcher types.
 *
 * Two independent facts drive every type here:
 *
 *  1. There is no single global `currentFiscalYear`. FY27 appropriations, FY28
 *     authorization and an FY24 supplemental are simultaneously live. Cycle
 *     identity is therefore (fiscalYear, authorityTrack) — never a scalar year.
 *
 *  2. Authorization and appropriations are independent tracks. A newer HASC mark
 *     may never overwrite an appropriations position and vice versa. Because the
 *     track is part of the cycle identity, "overwrite" is not expressible.
 *
 * A missing or not-filed source is a recorded fact, never zero funding.
 */

export type AuthorityTrack =
  | 'request'
  | 'authorization'
  | 'appropriations'
  | 'alternative_funding'
  | 'execution';

export const AUTHORITY_TRACKS: readonly AuthorityTrack[] = Object.freeze([
  'request',
  'authorization',
  'appropriations',
  'alternative_funding',
  'execution',
]);

/**
 * Lifecycle stages. Conference is a NEW stage carrying its own source evidence,
 * not a mutation of the committee marks that preceded it; enacted is separate
 * from conference unless the governing source proves the values are identical.
 */
export type LifecycleStage =
  // request
  | 'president_budget_request'
  // authorization
  | 'hasc_mark'
  | 'hasc_report'
  | 'house_auth_action'
  | 'sasc_mark'
  | 'sasc_report'
  | 'senate_auth_action'
  | 'auth_conference'
  | 'auth_enacted'
  // appropriations
  | 'hac_d_mark'
  | 'hac_d_report'
  | 'house_appr_action'
  | 'sac_d_mark'
  | 'sac_d_report'
  | 'senate_appr_action'
  | 'appr_conference_or_jes'
  | 'appr_enacted'
  // alternative funding
  | 'supplemental'
  | 'emergency_supplemental'
  | 'reconciliation'
  | 'continuing_resolution'
  | 'rescission'
  | 'transfer'
  | 'reprogramming'
  // execution
  | 'allocation'
  | 'obligation'
  | 'award';

export const LIFECYCLE_STAGES: readonly LifecycleStage[] = Object.freeze([
  'president_budget_request',
  'hasc_mark',
  'hasc_report',
  'house_auth_action',
  'sasc_mark',
  'sasc_report',
  'senate_auth_action',
  'auth_conference',
  'auth_enacted',
  'hac_d_mark',
  'hac_d_report',
  'house_appr_action',
  'sac_d_mark',
  'sac_d_report',
  'senate_appr_action',
  'appr_conference_or_jes',
  'appr_enacted',
  'supplemental',
  'emergency_supplemental',
  'reconciliation',
  'continuing_resolution',
  'rescission',
  'transfer',
  'reprogramming',
  'allocation',
  'obligation',
  'award',
]);

/** Which track each stage belongs to. A stage may never appear in two tracks. */
export const STAGE_TRACK: Readonly<Record<LifecycleStage, AuthorityTrack>> = Object.freeze({
  president_budget_request: 'request',
  hasc_mark: 'authorization',
  hasc_report: 'authorization',
  house_auth_action: 'authorization',
  sasc_mark: 'authorization',
  sasc_report: 'authorization',
  senate_auth_action: 'authorization',
  auth_conference: 'authorization',
  auth_enacted: 'authorization',
  hac_d_mark: 'appropriations',
  hac_d_report: 'appropriations',
  house_appr_action: 'appropriations',
  sac_d_mark: 'appropriations',
  sac_d_report: 'appropriations',
  senate_appr_action: 'appropriations',
  appr_conference_or_jes: 'appropriations',
  appr_enacted: 'appropriations',
  supplemental: 'alternative_funding',
  emergency_supplemental: 'alternative_funding',
  reconciliation: 'alternative_funding',
  continuing_resolution: 'alternative_funding',
  rescission: 'alternative_funding',
  transfer: 'alternative_funding',
  reprogramming: 'alternative_funding',
  allocation: 'execution',
  obligation: 'execution',
  award: 'execution',
});

/**
 * Monotonic rank WITHIN a track. Used only to refuse regression (a mark may not
 * be recorded as if it advanced past an enacted stage); never to collapse two
 * stages into one value. Ranks are intentionally not comparable across tracks.
 */
export const STAGE_RANK: Readonly<Record<LifecycleStage, number>> = Object.freeze({
  president_budget_request: 0,

  hasc_mark: 10,
  hasc_report: 11,
  house_auth_action: 12,
  sasc_mark: 13,
  sasc_report: 14,
  senate_auth_action: 15,
  auth_conference: 16,
  auth_enacted: 17,

  hac_d_mark: 10,
  hac_d_report: 11,
  house_appr_action: 12,
  sac_d_mark: 13,
  sac_d_report: 14,
  senate_appr_action: 15,
  appr_conference_or_jes: 16,
  appr_enacted: 17,

  supplemental: 0,
  emergency_supplemental: 0,
  reconciliation: 0,
  continuing_resolution: 0,
  rescission: 0,
  transfer: 0,
  reprogramming: 0,

  allocation: 0,
  obligation: 1,
  award: 2,
});

export type Chamber = 'house' | 'senate' | 'joint' | null;

export type BudgetComponent =
  | 'ARMY'
  | 'NAVY'
  | 'USMC'
  | 'AF'
  | 'SF'
  | 'DW'
  | null;

/**
 * Expected source families. These name the KIND of official document, never a
 * URL: URLs and discovery rules change without changing canonical semantics.
 */
export type SourceFamily =
  // President's Budget / DoD exhibits
  | 'pb_overview'
  | 'pb_r1'
  | 'pb_r2'
  | 'pb_r2a'
  | 'pb_r3'
  | 'pb_r4'
  | 'pb_p1'
  | 'pb_p_series'
  | 'pb_o1'
  | 'pb_op5'
  | 'pb_milcon_c1'
  | 'pb_dd1391'
  // Authorization
  | 'auth_committee_mark'
  | 'auth_committee_report'
  | 'auth_chamber_action'
  | 'auth_conference_report'
  | 'auth_public_law'
  // Appropriations
  | 'appr_committee_mark'
  | 'appr_committee_report'
  | 'appr_chamber_action'
  | 'appr_conference_jes'
  | 'appr_public_law'
  // Alternative funding
  | 'alt_supplemental'
  | 'alt_reconciliation'
  | 'alt_continuing_resolution'
  | 'alt_rescission'
  | 'alt_transfer'
  | 'alt_reprogramming'
  // Execution
  | 'exec_allocation'
  | 'exec_obligation'
  | 'exec_award';

/**
 * Governed expected-source states (Session 7 assignment §"Expected source
 * states"). NOT_FILED / UNAVAILABLE / WITHDRAWN are recorded facts, never zero.
 */
export type ExpectedSourceState =
  | 'expected'
  | 'not_filed'
  | 'published'
  | 'superseded'
  | 'withdrawn'
  | 'unavailable'
  | 'review_required';

export const EXPECTED_SOURCE_STATES: readonly ExpectedSourceState[] = Object.freeze([
  'expected',
  'not_filed',
  'published',
  'superseded',
  'withdrawn',
  'unavailable',
  'review_required',
]);

/** Operational watcher observation states. */
export type ObservationState =
  | 'discovered'
  | 'downloaded'
  | 'unchanged'
  | 'changed'
  | 'classified'
  | 'review_required'
  | 'queued'
  | 'ingested'
  | 'blocked'
  | 'superseded'
  | 'withdrawn';

export const OBSERVATION_STATES: readonly ObservationState[] = Object.freeze([
  'discovered',
  'downloaded',
  'unchanged',
  'changed',
  'classified',
  'review_required',
  'queued',
  'ingested',
  'blocked',
  'superseded',
  'withdrawn',
]);

/**
 * Observation states that must never be enqueued for governed ingestion. The
 * database enforces the same rule via a composite foreign key so an ambiguous
 * source cannot be advanced by application code either.
 */
export const NON_QUEUEABLE_OBSERVATION_STATES: readonly ObservationState[] = Object.freeze([
  'review_required',
  'blocked',
  'withdrawn',
]);

export type CycleStatus = 'draft' | 'active' | 'closed';

export type CycleBootstrapOrigin = 'discovery' | 'template' | 'operator';

export interface BudgetCycleIdentity {
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
}

export interface ExpectedSourceIdentity extends BudgetCycleIdentity {
  readonly sourceFamily: SourceFamily;
  readonly stage: LifecycleStage;
  readonly chamber: Chamber;
  readonly committee: string | null;
  readonly component: BudgetComponent;
}
