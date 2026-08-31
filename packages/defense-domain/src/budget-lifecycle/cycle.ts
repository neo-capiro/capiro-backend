/**
 * Annual Defense Budget Cycle Controller — pure domain half.
 *
 * The controller's job is that an unseen fiscal year needs no engineer. Given a
 * fiscal year and a governed template version it produces the complete expected
 * source set, with stable dedup keys, so FY28/FY29/FY30 bootstrap identically.
 */

import { createHash } from 'node:crypto';

import {
  DEFENSE_BUDGET_CYCLE_TEMPLATE_VERSION,
  resolveCycleTemplate,
  type ExpectedSourceTemplate,
} from './templates.js';
import {
  AUTHORITY_TRACKS,
  STAGE_TRACK,
  type AuthorityTrack,
  type BudgetComponent,
  type BudgetCycleIdentity,
  type Chamber,
  type CycleBootstrapOrigin,
  type ExpectedSourceState,
  type LifecycleStage,
  type SourceFamily,
} from './types.js';

/** Deterministic, key-sorted JSON so a dedup key never depends on key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class InvalidFiscalYearError extends Error {
  constructor(readonly fiscalYear: unknown) {
    super(`Invalid defense budget fiscal year: ${String(fiscalYear)}`);
    this.name = 'InvalidFiscalYearError';
  }
}

export function assertFiscalYear(fiscalYear: number): number {
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 2200) {
    throw new InvalidFiscalYearError(fiscalYear);
  }
  return fiscalYear;
}

/** A US federal fiscal year begins on 1 October of the preceding calendar year. */
export function fiscalYearStart(fiscalYear: number): Date {
  assertFiscalYear(fiscalYear);
  return new Date(Date.UTC(fiscalYear - 1, 9, 1, 0, 0, 0));
}

export function fiscalYearOfInstant(instantIso: string): number {
  const date = new Date(instantIso);
  if (Number.isNaN(date.getTime())) throw new InvalidFiscalYearError(instantIso);
  // October, November, December belong to the NEXT fiscal year.
  return date.getUTCMonth() >= 9 ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
}

function addMonthsUtc(base: Date, months: number): Date {
  const next = new Date(base.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

export interface RollingHorizonOptions {
  /** Completed cycles kept warm for corrections. */
  readonly priorYears?: number;
  /** Future cycles pre-created so a first discovery has a home. */
  readonly upcomingYears?: number;
}

/**
 * Rolling prior/current/upcoming horizon. The watcher never needs a human to say
 * "FY28 exists now"; the horizon moves with the clock.
 */
export function rollingCycleHorizon(
  nowIso: string,
  options: RollingHorizonOptions = {},
): readonly number[] {
  const priorYears = options.priorYears ?? 1;
  const upcomingYears = options.upcomingYears ?? 1;
  if (priorYears < 0 || upcomingYears < 0) {
    throw new RangeError('rollingCycleHorizon requires non-negative bounds');
  }
  const current = fiscalYearOfInstant(nowIso);
  const years: number[] = [];
  for (let year = current - priorYears; year <= current + upcomingYears; year += 1) {
    years.push(assertFiscalYear(year));
  }
  return Object.freeze(years);
}

export interface BudgetCyclePlan extends BudgetCycleIdentity {
  readonly status: 'draft';
  readonly templateVersion: string;
  readonly bootstrapOrigin: CycleBootstrapOrigin;
  readonly dedupKey: string;
}

export function budgetCycleDedupKey(identity: BudgetCycleIdentity): string {
  return sha256Hex(
    canonicalJson({
      kind: 'defense_budget_cycle_v1',
      fiscalYear: assertFiscalYear(identity.fiscalYear),
      authorityTrack: identity.authorityTrack,
    }),
  );
}

export interface ExpectedSourcePlan {
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
  readonly sourceFamily: SourceFamily;
  readonly stage: LifecycleStage;
  readonly chamber: Chamber;
  readonly committee: string | null;
  readonly component: BudgetComponent;
  readonly adapterId: string;
  readonly label: string;
  readonly expectedState: ExpectedSourceState;
  readonly optional: boolean;
  readonly templateVersion: string;
  /** Inclusive window bounds, ISO-8601 UTC. Advisory scheduling hints only. */
  readonly expectedFrom: string;
  readonly expectedTo: string;
  readonly dedupKey: string;
}

export function expectedSourceDedupKey(input: {
  fiscalYear: number;
  authorityTrack: AuthorityTrack;
  sourceFamily: SourceFamily;
  stage: LifecycleStage;
  chamber: Chamber;
  committee: string | null;
  component: BudgetComponent;
}): string {
  return sha256Hex(
    canonicalJson({
      kind: 'defense_budget_expected_source_v1',
      fiscalYear: assertFiscalYear(input.fiscalYear),
      authorityTrack: input.authorityTrack,
      sourceFamily: input.sourceFamily,
      stage: input.stage,
      chamber: input.chamber ?? null,
      committee: input.committee ?? null,
      component: input.component ?? null,
    }),
  );
}

export class StageTrackMismatchError extends Error {
  constructor(readonly stage: LifecycleStage, readonly authorityTrack: AuthorityTrack) {
    super(
      `Stage ${stage} belongs to the ${STAGE_TRACK[stage]} track and cannot be recorded on ${authorityTrack}`,
    );
    this.name = 'StageTrackMismatchError';
  }
}

export function assertStageBelongsToTrack(
  stage: LifecycleStage,
  authorityTrack: AuthorityTrack,
): void {
  if (STAGE_TRACK[stage] !== authorityTrack) {
    throw new StageTrackMismatchError(stage, authorityTrack);
  }
}

function planFromTemplate(
  fiscalYear: number,
  entry: ExpectedSourceTemplate,
  templateVersion: string,
): ExpectedSourcePlan {
  assertStageBelongsToTrack(entry.stage, entry.authorityTrack);
  const start = fiscalYearStart(fiscalYear);
  return Object.freeze({
    fiscalYear,
    authorityTrack: entry.authorityTrack,
    sourceFamily: entry.sourceFamily,
    stage: entry.stage,
    chamber: entry.chamber,
    committee: entry.committee,
    component: entry.component,
    adapterId: entry.adapterId,
    label: entry.label.replace(/\{FY\}/g, String(fiscalYear)),
    // Nothing has been observed yet. `expected` is the ONLY correct starting
    // state; it is not a claim that the document exists, and it is not zero.
    expectedState: 'expected' as ExpectedSourceState,
    optional: entry.optional,
    templateVersion,
    expectedFrom: addMonthsUtc(start, entry.windowFromMonths).toISOString(),
    expectedTo: addMonthsUtc(start, entry.windowToMonths).toISOString(),
    dedupKey: expectedSourceDedupKey({
      fiscalYear,
      authorityTrack: entry.authorityTrack,
      sourceFamily: entry.sourceFamily,
      stage: entry.stage,
      chamber: entry.chamber,
      committee: entry.committee,
      component: entry.component,
    }),
  });
}

export interface BootstrapCycleResult {
  readonly fiscalYear: number;
  readonly templateVersion: string;
  readonly bootstrapOrigin: CycleBootstrapOrigin;
  readonly cycles: readonly BudgetCyclePlan[];
  readonly expectedSources: readonly ExpectedSourcePlan[];
}

/**
 * Bootstrap every track of a fiscal year from governed templates. No bespoke
 * per-year manifest, no cloned URLs from last year, no hand editing.
 */
export function bootstrapFiscalYearCycle(options: {
  fiscalYear: number;
  templateVersion?: string;
  bootstrapOrigin?: CycleBootstrapOrigin;
  /** Restrict to specific tracks; defaults to all five. */
  tracks?: readonly AuthorityTrack[];
}): BootstrapCycleResult {
  const fiscalYear = assertFiscalYear(options.fiscalYear);
  const templateVersion = options.templateVersion ?? DEFENSE_BUDGET_CYCLE_TEMPLATE_VERSION;
  const template = resolveCycleTemplate(templateVersion);
  const tracks = options.tracks ?? AUTHORITY_TRACKS;
  const trackSet = new Set(tracks);

  const cycles = tracks.map((authorityTrack) =>
    Object.freeze({
      fiscalYear,
      authorityTrack,
      status: 'draft' as const,
      templateVersion,
      bootstrapOrigin: options.bootstrapOrigin ?? 'template',
      dedupKey: budgetCycleDedupKey({ fiscalYear, authorityTrack }),
    }),
  );

  const expectedSources = template.entries
    .filter((entry) => trackSet.has(entry.authorityTrack))
    .map((entry) => planFromTemplate(fiscalYear, entry, templateVersion));

  const seen = new Set<string>();
  for (const source of expectedSources) {
    if (seen.has(source.dedupKey)) {
      throw new Error(
        `Template ${templateVersion} produces a duplicate expected-source identity for FY${fiscalYear}: ` +
          `${source.authorityTrack}/${source.stage}/${source.sourceFamily}/${source.component ?? 'all'}`,
      );
    }
    seen.add(source.dedupKey);
  }

  return Object.freeze({
    fiscalYear,
    templateVersion,
    bootstrapOrigin: options.bootstrapOrigin ?? 'template',
    cycles: Object.freeze(cycles),
    expectedSources: Object.freeze(expectedSources),
  });
}

/**
 * Bootstrap the whole rolling horizon in one call. This is what a scheduled
 * controller run does: it never asks which years exist.
 */
export function bootstrapRollingHorizon(options: {
  nowIso: string;
  templateVersion?: string;
  horizon?: RollingHorizonOptions;
}): readonly BootstrapCycleResult[] {
  return Object.freeze(
    rollingCycleHorizon(options.nowIso, options.horizon).map((fiscalYear) =>
      bootstrapFiscalYearCycle({
        fiscalYear,
        templateVersion: options.templateVersion,
        bootstrapOrigin: 'template',
      }),
    ),
  );
}

/**
 * A first authoritative source for an unseen FY creates that FY's cycle. This is
 * the discovery-driven half of automatic bootstrap: no operator action needed.
 */
export function bootstrapCycleFromFirstDiscovery(options: {
  fiscalYear: number;
  authorityTrack: AuthorityTrack;
  templateVersion?: string;
}): BootstrapCycleResult {
  return bootstrapFiscalYearCycle({
    fiscalYear: options.fiscalYear,
    templateVersion: options.templateVersion,
    bootstrapOrigin: 'discovery',
  });
}

/**
 * Missing / not-filed / withdrawn / unavailable funding position.
 *
 * This function exists so no caller can reach for `0`. There is no numeric
 * branch: an unpublished expected source has NO known amount, and that is a
 * different fact from an amount of zero.
 */
export type ExpectedSourceFundingPosition =
  | { readonly known: false; readonly reason: ExpectedSourceState }
  | { readonly known: 'source_published'; readonly reason: 'requires_governed_ingestion' };

export function expectedSourceFundingPosition(
  state: ExpectedSourceState,
): ExpectedSourceFundingPosition {
  if (state === 'published') {
    // Even a published source carries no dollars until governed Session 6
    // ingestion binds amounts to source evidence.
    return Object.freeze({ known: 'source_published' as const, reason: 'requires_governed_ingestion' as const });
  }
  return Object.freeze({ known: false as const, reason: state });
}

/** States in which reporting a funding amount of any kind would be a lie. */
export const NEVER_ZERO_EXPECTED_STATES: readonly ExpectedSourceState[] = Object.freeze([
  'expected',
  'not_filed',
  'withdrawn',
  'unavailable',
  'review_required',
  // A bundle with at least one verified member but required members still
  // missing (Phase 10B-18) has NO trustworthy whole-family amount yet —
  // exactly the same "no dollars until governed ingestion of the full
  // family" rule `published` itself is already subject to below.
  'partially_published',
]);

/**
 * Resolve an expected source's state when nothing has been observed. An optional
 * family past its window is `not_filed`; a required family past its window is
 * `review_required` so a human looks at it. Neither becomes zero.
 */
export function resolveUnobservedExpectedState(input: {
  plan: Pick<ExpectedSourcePlan, 'optional' | 'expectedTo'>;
  nowIso: string;
}): ExpectedSourceState {
  const now = new Date(input.nowIso);
  if (Number.isNaN(now.getTime())) throw new RangeError(`Invalid instant: ${input.nowIso}`);
  const windowClosed = now.getTime() > new Date(input.plan.expectedTo).getTime();
  if (!windowClosed) return 'expected';
  return input.plan.optional ? 'not_filed' : 'review_required';
}
