import type { SourceFundingPosition } from '../src/sourcedata/source-data.repository.js';
import { harness, installHooks } from './fixtures/bill-dossier-ownership/harness.js';
import {
  billId,
  kpi,
  parentPackage,
  position,
  provision,
} from './fixtures/bill-dossier-ownership/rows.js';

installHooks();

it.each([
  { vehicleId: 'other-vehicle' },
  { fiscalYear: 2026 },
  { stage: 'senate' },
  { vehicleClass: 'authorization' },
  { vehicleTrack: 'authorization' },
  { verificationStatus: 'extracted' },
  { sourceDocumentCurrent: false },
] satisfies Partial<SourceFundingPosition>[])(
  'retains tables but excludes a primary position when authority differs by %j',
  async (difference) => {
    const h = harness({
      results: {
        getBillFundingPositions: [position(difference)],
        getParentBudgetPackage: parentPackage(),
      },
    });
    const result = await h.service.getGlobalDossier(billId, { funding: true });
    expect(result.funding.positions).toHaveLength(1);
    expect(result.funding.positions[0]!.primary).toBe(false);
    expect(kpi(result, 'funding_position').value).toBeNull();
    expect(kpi(result, 'delta_from_request').value).toBeNull();
  },
);

it('prefers verified over reviewed within the same eligible stage and retains input order for otherwise tied positions', async () => {
  const h = harness({
    results: {
      getParentBudgetPackage: parentPackage(),
      getBillFundingPositions: [
        position({ id: 'reviewed', amountMillions: '100' }),
        position({ id: 'verified-first', verificationStatus: 'verified', amountMillions: '120' }),
        position({ id: 'verified-second', verificationStatus: 'verified', amountMillions: '140' }),
      ],
    },
  });
  const result = await h.service.getGlobalDossier(billId, { funding: true });
  expect(
    result.funding.positions
      .filter((row) => row.primary)
      .map((row) => (row as typeof row & { id: string }).id),
  ).toEqual(['verified-first']);
  expect(kpi(result, 'funding_position').value).toBe('$120M');
  expect(result.funding.positions.map((row) => (row as typeof row & { id: string }).id)).toEqual([
    'reviewed',
    'verified-first',
    'verified-second',
  ]);
});

it.each([
  ['reviewed', '[overrides-reconciled]', false],
  ['verified', null, false],
  ['verified', '[OVERRIDES-RECONCILED]', true],
] as const)(
  'requires both verified authority and explicit override attestation for %s/%s',
  async (verificationStatus, note, reconciled) => {
    const h = harness({
      results: {
        getParentBudgetPackage: parentPackage(),
        getBillFundingPositions: [position({ verificationStatus, note })],
        getBillFundingProvisions: [provision()],
      },
    });
    const result = await h.service.getGlobalDossier(billId, { funding: true });
    expect(result.funding.overrideReconciliation).toBe(
      reconciled ? 'reconciled' : 'verification_required',
    );
    expect(result.funding.positions[0]!.primary).toBe(reconciled);
    expect(kpi(result, 'funding_position').value).toBe(reconciled ? '$120M' : null);
    expect(result.funding.guardrail).toBe(
      reconciled
        ? null
        : 'Official provisions explicitly change table amounts, but those overrides have not been numerically reconciled. No topline amount or comparison is shown until verification is complete.',
    );
  },
);

it.each([
  { reviewStatus: 'candidate' },
  { billLinkStatus: 'candidate' },
  { actionType: 'mentions' },
])(
  'does not require override reconciliation for unaccepted/non-numeric provision %j',
  async (change) => {
    const h = harness({
      results: {
        getParentBudgetPackage: parentPackage(),
        getBillFundingPositions: [position()],
        getBillFundingProvisions: [provision(change)],
      },
    });
    const result = await h.service.getGlobalDossier(billId, { funding: true });
    expect(result.funding.overrideReconciliation).toBe('not_required');
    expect(result.funding.positions[0]!.primary).toBe(true);
  },
);

it('uses the first reviewed same-FY/scope request and excludes wrong-FY, stale and authorization comparisons', async () => {
  const request = position({
    id: 'request-first',
    stage: 'president',
    vehicleClass: 'request',
    vehicleTrack: 'request',
    amountMillions: '100',
  });
  const h = harness({
    results: {
      getParentBudgetPackage: parentPackage(),
      getBillFundingPositions: [
        position(),
        position({
          id: 'wrong-year',
          stage: 'president',
          vehicleClass: 'request',
          fiscalYear: 2026,
          amountMillions: '1',
        }),
        request,
        position({
          id: 'request-second',
          stage: 'president',
          vehicleClass: 'request',
          amountMillions: '80',
        }),
        position({
          id: 'stale',
          stage: 'senate',
          sourceDocumentCurrent: false,
          amountMillions: '130',
        }),
        position({
          id: 'authorization',
          stage: 'senate',
          vehicleClass: 'authorization',
          amountMillions: '140',
        }),
        position({
          id: 'senate',
          stage: 'senate',
          vehicleLabel: 'Senate amount',
          amountMillions: '110',
        }),
      ],
    },
  });
  const result = await h.service.getGlobalDossier(billId, { funding: true });
  expect(result.funding.reqCompare).toMatchObject({
    amountMillions: 100,
    deltaMillions: 20,
    pct: 20,
    comparable: true,
  });
  expect(result.funding.comparisons.map((row) => row.amountMillions)).toEqual([100, 80, 110]);
  expect(result.funding.senateCompare).toMatchObject({
    amountMillions: 110,
    deltaMillions: null,
    pct: null,
  });
  expect(kpi(result, 'delta_from_request').value).toBe('+$20M');
});

it('keeps an explicitly sourced zero amount and null percentage denominators without manufacturing missing zeroes', async () => {
  const h = harness({
    results: {
      getParentBudgetPackage: parentPackage(),
      getBillFundingPositions: [
        position({ amountMillions: '0' }),
        position({
          id: 'request',
          stage: 'president',
          vehicleClass: 'request',
          amountMillions: '0',
        }),
      ],
    },
  });
  const result = await h.service.getGlobalDossier(billId, { funding: true });
  expect(kpi(result, 'funding_position').value).toBe('$0M');
  expect(kpi(result, 'delta_from_request').value).toBe('flat');
  expect(result.funding.reqCompare).toMatchObject({
    amountMillions: 0,
    deltaMillions: 0,
    pct: null,
  });
  expect(result.funding.comparisons[0]).toMatchObject({
    amountMillions: 0,
    deltaMillions: 0,
    pct: null,
  });
});

it('preserves raw nonfinite position numeric behavior instead of applying PE numeric normalization', async () => {
  const h = harness({
    results: {
      getParentBudgetPackage: parentPackage(),
      getBillFundingPositions: [position({ amountMillions: 'not-a-number' })],
    },
  });
  const result = await h.service.getGlobalDossier(billId, { funding: true });
  expect(result.funding.positions[0]!.amountMillions).toBeNaN();
  expect(result.funding.positions[0]!.primary).toBe(true);
  expect(kpi(result, 'funding_position').value).toBe('$NaNM');
});

it('keeps provision evidence and parent labels even when no positions or PE links make funding available', async () => {
  const h = harness({
    results: { getParentBudgetPackage: parentPackage(), getBillFundingProvisions: [provision()] },
  });
  const result = await h.service.getGlobalDossier(billId, { funding: true });
  expect(result.funding).toMatchObject({
    available: false,
    parentPackageLabel: 'FY27 Defense',
    positions: [],
    programElementImpacts: [],
  });
  expect(result.funding.provisions).toHaveLength(1);
  expect(kpi(result, 'funding_position').value).toBeNull();
  expect(kpi(result, 'funding_position').unavailableReason).toContain(
    'No reviewed funding positions',
  );
});
