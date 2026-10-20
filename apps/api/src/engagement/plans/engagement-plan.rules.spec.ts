import { describe, expect, it } from '@jest/globals';
import {
  deriveReviewFreshness,
  normalizeCreatePlan,
  normalizeCreateWave,
  normalizeHistoryQuery,
  normalizeListQuery,
  normalizePatchPlan,
  normalizePatchWave,
  normalizeReorderWaves,
  normalizeReview,
  PlanInputError,
  PlanRuleError,
  planTransition,
  type PlanLifecycle,
  type PlanTransition,
} from './engagement-plan.rules.js';

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TARGET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOW = new Date('2026-10-15T12:00:00Z');
const plan = { clientId: CLIENT, requestId: REQUEST, title: 'Fall outreach' };
const wave = { requestId: REQUEST, expectedPlanVersion: 1, title: 'DC visit' };
const window = {
  startDate: '2027-03-13',
  endDateExclusive: '2027-03-15',
  timeZone: 'America/New_York',
};
const reference = { targetId: TARGET, officeKey: `manual:${TARGET}` };
const uniqueIds = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `eeeeeeee-eeee-4eee-8eee-${index.toString(16).padStart(12, '0')}`,
  );

function inputError(run: () => unknown) {
  try {
    run();
    throw new Error('expected input rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(PlanInputError);
    expect(error).toMatchObject({ code: 'PLAN_INPUT_INVALID', status: 400 });
  }
}

describe('manual Engagement plan authoring inputs', () => {
  it('normalizes stable UUID/text identities, supplies defaults, and leaves the caller unchanged', () => {
    const input = { ...plan, clientId: CLIENT.toUpperCase(), title: '  Fall outreach  ' };
    expect(normalizeCreatePlan(input)).toEqual({ ...plan, officeReferences: [], objective: null });
    expect(input.title).toBe('  Fall outreach  ');
    expect(
      normalizeCreatePlan({
        ...plan,
        officeReferences: [reference],
        objective: {
          objectiveId: OTHER.toUpperCase(),
          objectiveVersion: 2,
        },
      }),
    ).toMatchObject({
      officeReferences: [reference],
      objective: { objectiveId: OTHER, objectiveVersion: 2 },
    });
  });

  it.each([
    null,
    [],
    'input',
    3,
    new Date(),
    { ...plan, tenantId: OTHER },
    { ...plan, clientId: 'clerk_user' },
    { ...plan, requestId: null },
    { ...plan, title: null },
    { ...plan, title: 12 },
    { ...plan, title: '   ' },
    { ...plan, title: 'x'.repeat(201) },
    { ...plan, officeReferences: null },
    { ...plan, objective: { objectiveId: OTHER, objectiveVersion: 0 } },
    { ...plan, objective: { objectiveId: OTHER, objectiveVersion: 1, revisionId: REQUEST } },
  ])('rejects malformed/protected create fields: %p', (input) =>
    inputError(() => normalizeCreatePlan(input)),
  );

  it.each([
    undefined,
    null,
    0,
    -1,
    1.5,
    '1',
    Number.NaN,
    Infinity,
    2147483648,
    Number.MAX_SAFE_INTEGER,
  ])('rejects unsafe body versions without coercion: %p', (expectedPlanVersion) => {
    inputError(() => normalizePatchPlan({ expectedPlanVersion, title: 'Update' }));
    inputError(() => normalizeCreateWave({ ...wave, expectedPlanVersion }));
  });

  it('accepts positive int32 limits and does not invent omitted patch changes', () => {
    expect(normalizePatchPlan({ expectedPlanVersion: 2147483647 })).toEqual({
      expectedPlanVersion: 2147483647,
    });
    expect(
      normalizePatchPlan({ expectedPlanVersion: 1, objective: null, officeReferences: [] }),
    ).toEqual({ expectedPlanVersion: 1, objective: null, officeReferences: [] });
  });

  it.each(['activate', 'deactivate', 'archive', 'restore'] as const)(
    'admits an isolated %s command',
    (action) => {
      expect(normalizePatchPlan({ expectedPlanVersion: 2, action })).toEqual({
        expectedPlanVersion: 2,
        action,
      });
      inputError(() => normalizePatchPlan({ expectedPlanVersion: 2, action, title: 'Mixed' }));
      inputError(() =>
        normalizePatchPlan({ expectedPlanVersion: 2, action, officeReferences: [] }),
      );
      inputError(() => normalizePatchPlan({ expectedPlanVersion: 2, action, objective: null }));
    },
  );

  it('rejects unknown actions/fields and explicit undefined rather than dropping mutation inputs', () => {
    for (const extra of [
      { action: 'approve' },
      { lifecycle: 'active' },
      { clientId: OTHER },
      { title: undefined },
    ])
      inputError(() => normalizePatchPlan({ expectedPlanVersion: 1, ...extra }));
    inputError(() => normalizeCreatePlan({ ...plan, objective: undefined }));
  });

  it('canonicalizes UUID key suffixes and rejects duplicate targets or office identities', () => {
    expect(
      normalizeCreatePlan({
        ...plan,
        officeReferences: [
          { targetId: TARGET.toUpperCase(), officeKey: `manual:${TARGET.toUpperCase()}` },
        ],
      }).officeReferences,
    ).toEqual([reference]);
    for (const refs of [
      [reference, { ...reference, targetId: TARGET.toUpperCase() }],
      [reference, { ...reference, targetId: OTHER }],
      [{ ...reference, officeKey: 'member:staff' }],
      [{ ...reference, officeKey: 'directory:' }],
      [{ ...reference, officeKey: 'directory:bad identity' }],
      [{ ...reference, metadata: {} }],
      Array.from({ length: 201 }, () => reference),
    ])
      inputError(() => normalizeCreatePlan({ ...plan, officeReferences: refs }));
    expect(
      normalizeCreatePlan({
        ...plan,
        officeReferences: [{ ...reference, officeKey: 'directory:member-123' }],
      }).officeReferences[0]?.officeKey,
    ).toBe('directory:member-123');
  });
});

describe('wave windows, references and reorder', () => {
  it('keeps DST-crossing windows as date-only intervals without inferring instants or duration', () => {
    expect(
      normalizeCreateWave({
        ...wave,
        window,
        formatLabel: '  Call or video  ',
        officeTargetIds: [TARGET.toUpperCase()],
      }),
    ).toEqual({ ...wave, window, formatLabel: 'Call or video', officeTargetIds: [TARGET] });
    expect(normalizeCreateWave(wave)).toEqual({
      ...wave,
      window: null,
      formatLabel: null,
      officeTargetIds: [],
    });
    expect(normalizePatchWave({ expectedPlanVersion: 2, window: null, formatLabel: ' ' })).toEqual({
      expectedPlanVersion: 2,
      window: null,
      formatLabel: null,
    });
  });

  it.each([
    { ...window, startDate: '2027-02-29' },
    { ...window, startDate: '2028-02-30' },
    { ...window, startDate: '2027-3-01' },
    { ...window, startDate: '0000-01-01' },
    { ...window, endDateExclusive: '2027-03-13' },
    { ...window, endDateExclusive: '2027-03-12' },
    { ...window, startDate: '2027-03-13T00:00:00Z' },
    { ...window, timeZone: '+02:00' },
    { ...window, timeZone: 'Invented/Zone' },
    { ...window, startsAt: '2027-03-13T12:00:00Z' },
  ])(
    'rejects impossible dates, implicit instants, reversed windows or invalid zones: %p',
    (badWindow) => {
      inputError(() => normalizeCreateWave({ ...wave, window: badWindow }));
    },
  );

  it('accepts a real leap day and explicit IANA zone aliases', () => {
    expect(
      normalizeCreateWave({
        ...wave,
        window: { startDate: '2028-02-29', endDateExclusive: '2028-03-01', timeZone: 'UTC' },
      }).window,
    ).toEqual({ startDate: '2028-02-29', endDateExclusive: '2028-03-01', timeZone: 'UTC' });
  });

  it('rejects duplicate and oversized reference/order lists after UUID normalization', () => {
    inputError(() =>
      normalizeCreateWave({ ...wave, officeTargetIds: [TARGET, TARGET.toUpperCase()] }),
    );
    inputError(() => normalizeCreateWave({ ...wave, officeTargetIds: Array(201).fill(TARGET) }));
    inputError(() =>
      normalizeReorderWaves({ expectedPlanVersion: 1, waveIds: [TARGET, TARGET.toUpperCase()] }),
    );
    inputError(() =>
      normalizeReorderWaves({ expectedPlanVersion: 1, waveIds: Array(1001).fill(TARGET) }),
    );
    expect(
      normalizeReorderWaves({ expectedPlanVersion: 1, waveIds: [OTHER.toUpperCase(), TARGET] }),
    ).toEqual({ expectedPlanVersion: 1, waveIds: [OTHER, TARGET] });
    expect(normalizeReorderWaves({ expectedPlanVersion: 1, waveIds: [] }).waveIds).toEqual([]);
  });

  it('accepts the exact operational list bounds and refuses the next unique entry', () => {
    const targets = uniqueIds(201);
    const offices = targets.map((targetId) => ({ targetId, officeKey: `manual:${targetId}` }));
    expect(
      normalizeCreatePlan({ ...plan, officeReferences: offices.slice(0, 200) }).officeReferences,
    ).toHaveLength(200);
    inputError(() => normalizeCreatePlan({ ...plan, officeReferences: offices }));
    expect(
      normalizeCreateWave({ ...wave, officeTargetIds: targets.slice(0, 200) }).officeTargetIds,
    ).toHaveLength(200);
    inputError(() => normalizeCreateWave({ ...wave, officeTargetIds: targets }));
    const waveIds = uniqueIds(1001);
    expect(
      normalizeReorderWaves({ expectedPlanVersion: 1, waveIds: waveIds.slice(0, 1000) }).waveIds,
    ).toHaveLength(1000);
    inputError(() => normalizeReorderWaves({ expectedPlanVersion: 1, waveIds }));
  });

  it('restricts wave actions and cannot combine them with authoring edits', () => {
    for (const action of ['archive', 'restore']) {
      expect(normalizePatchWave({ expectedPlanVersion: 2, action })).toEqual({
        expectedPlanVersion: 2,
        action,
      });
      for (const extra of [
        { title: 'Mixed' },
        { window: null },
        { formatLabel: null },
        { officeTargetIds: [] },
      ])
        inputError(() => normalizePatchWave({ expectedPlanVersion: 2, action, ...extra }));
    }
    for (const extra of [
      { action: 'activate' },
      { planId: OTHER },
      { officeTargetIds: null },
      { formatLabel: 3 },
      { formatLabel: 'x'.repeat(121) },
    ])
      inputError(() => normalizePatchWave({ expectedPlanVersion: 2, ...extra }));
    inputError(() =>
      normalizeReorderWaves({ expectedPlanVersion: 1, waveIds: [], clientId: CLIENT }),
    );
  });
});

describe('explicit review and lifecycle facts', () => {
  it('requires a future explicit offset instant and canonicalizes it for the receipt', () => {
    expect(
      normalizeReview({ expectedPlanVersion: 1, reviewDueAt: '2026-10-15T09:00:00-04:00' }, NOW),
    ).toEqual({ expectedPlanVersion: 1, reviewDueAt: '2026-10-15T13:00:00.000Z' });
  });

  it.each([
    '2026-10-16',
    '2026-10-16T12:00:00',
    '2026-02-30T12:00:00Z',
    '2026-10-16T24:00:00Z',
    '2026-10-16T12:00:00+24:00',
    '2026-10-16T12:00:00+01:60',
    '2026-10-15T12:00:00Z',
    '2026-10-15T11:59:59Z',
    null,
    1792152000000,
  ])('rejects invented/expired review deadlines: %p', (reviewDueAt) =>
    inputError(() => normalizeReview({ expectedPlanVersion: 1, reviewDueAt }, NOW)),
  );

  it('rejects unknown review fields and invalid supplied clocks', () => {
    inputError(() =>
      normalizeReview(
        { expectedPlanVersion: 1, reviewDueAt: '2027-01-01T00:00:00Z', reviewerUserId: OTHER },
        NOW,
      ),
    );
    inputError(() =>
      normalizeReview(
        { expectedPlanVersion: 1, reviewDueAt: '2027-01-01T00:00:00Z' },
        new Date('invalid'),
      ),
    );
  });

  it.each<[PlanLifecycle, PlanTransition, PlanLifecycle]>([
    ['draft', 'activate', 'active'],
    ['active', 'deactivate', 'draft'],
    ['draft', 'archive', 'archived'],
    ['active', 'archive', 'archived'],
    ['archived', 'restore', 'draft'],
    ['active', 'activate', 'active'],
    ['draft', 'deactivate', 'draft'],
    ['archived', 'archive', 'archived'],
    ['draft', 'restore', 'draft'],
  ])('resolves %s + %s as %s without owning service version checks', (current, action, next) => {
    expect(planTransition(current, action)).toBe(next);
  });

  it.each([
    ['archived', 'activate'],
    ['archived', 'deactivate'],
    ['active', 'restore'],
    ['constructor', 'archive'],
    ['draft', 'toString'],
  ])('rejects an invalid lifecycle edge %s + %s', (current, action) => {
    expect(() => planTransition(current as PlanLifecycle, action as PlanTransition)).toThrow(
      PlanRuleError,
    );
    try {
      planTransition(current as PlanLifecycle, action as PlanTransition);
    } catch (error) {
      expect(error).toMatchObject({ code: 'PLAN_INVALID_LIFECYCLE', status: 409 });
    }
  });

  it('derives review-only freshness, including exact deadline and later activation versions', () => {
    const reviewed = { version: 2, reviewedPlanVersion: 2, reviewDueAt: '2026-10-16T12:00:00Z' };
    expect(deriveReviewFreshness({ ...reviewed, reviewedPlanVersion: null }, NOW)).toMatchObject({
      status: 'unknown',
      reason: 'not_reviewed',
    });
    expect(deriveReviewFreshness(reviewed, NOW)).toMatchObject({
      status: 'current',
      reason: 'review_current',
      checkedAt: NOW.toISOString(),
    });
    expect(deriveReviewFreshness(reviewed, new Date(reviewed.reviewDueAt))).toMatchObject({
      status: 'stale',
      reason: 'review_expired',
    });
    // Create V1 -> explicit review receipt V2 -> activation receipt V3; service owns the increments.
    expect(planTransition('draft', 'activate')).toBe('active');
    expect(deriveReviewFreshness({ ...reviewed, version: 3 }, NOW)).toMatchObject({
      status: 'stale',
      reason: 'plan_changed',
    });
    expect(deriveReviewFreshness({ ...reviewed, reviewedPlanVersion: 4 }, NOW)).toMatchObject({
      status: 'unknown',
      reason: 'invalid_review_basis',
    });
    expect(deriveReviewFreshness({ ...reviewed, reviewDueAt: 'not a date' }, NOW)).toMatchObject({
      status: 'unknown',
      reason: 'invalid_review_basis',
    });
    expect(
      deriveReviewFreshness({ ...reviewed, reviewDueAt: new Date('2026-10-16T12:00:00Z') }, NOW)
        .status,
    ).toBe('current');
  });
});

describe('bounded opaque list/history queries', () => {
  it('uses bounded defaults, accepts URL decimal limits and preserves opaque cursors byte-for-byte', () => {
    expect(normalizeListQuery({})).toEqual({ limit: 25 });
    expect(
      normalizeListQuery({
        clientId: CLIENT.toUpperCase(),
        cursor: 'opaque+/= token',
        limit: '100',
      }),
    ).toEqual({ clientId: CLIENT, cursor: 'opaque+/= token', limit: 100 });
    expect(normalizeHistoryQuery({ beforeVersion: '2147483647', limit: '1' })).toEqual({
      beforeVersion: 2147483647,
      limit: 1,
    });
    expect(normalizeHistoryQuery({})).toEqual({ limit: 25 });
  });

  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.1 },
    { limit: '1e2' },
    { limit: null },
    { cursor: '' },
    { cursor: 'x'.repeat(513) },
    { cursor: 1 },
    { clientId: null },
    { tenantId: CLIENT },
  ])('rejects malformed list scope/bounds: %p', (input) =>
    inputError(() => normalizeListQuery(input)),
  );

  it('does not allow malformed history versions or unsupported filters', () => {
    for (const input of [
      { beforeVersion: 0 },
      { beforeVersion: '1.5' },
      { beforeVersion: 2147483648 },
      { cursor: 'opaque' },
    ])
      inputError(() => normalizeHistoryQuery(input));
  });
});
