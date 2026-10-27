import {
  compareBudgetAmounts,
  type BudgetAmount,
} from '../../../../packages/shared/src/legiwatch-phase8.js';
import {
  compareResearchVersions,
  type ResearchVersion,
} from '../../../../packages/shared/src/legislative-research.js';
import {
  parseBudgetComparison,
  parseVersionComparison,
  receiveBudgetComparison,
  receiveVersionComparison,
} from './legislative-comparison.contract.js';

const pair = {
  clientId: null,
  leftId: 'left',
  leftRevision: 'r1',
  rightId: 'right',
  rightRevision: 'r2',
};
const amount: BudgetAmount = {
  id: 'left',
  projectId: 'project',
  fiscalYear: '2027',
  periodStart: '2026-07-01',
  periodEnd: '2027-06-30',
  currency: 'USD',
  fund: 'General Revenue',
  basis: 'recurring',
  measure: 'money',
  minorUnits: '900719925474099300',
  state: 'amount',
  stage: 'request',
  chamber: 'house',
  offer: null,
  sourceRevision: 'r1',
  documentId: 'doc',
  locator: 'page 2',
  unitMultiplier: '1',
  allocationBasis: 'project',
  qualified: true,
};
const version: ResearchVersion = {
  id: 'left',
  billId: 'bill',
  jurisdiction: 'FL',
  sessionKey: '2027',
  revision: 'r1',
  contentHash: 'hash-left',
  extractorVersion: 'extractor-1',
  sourceUrl: 'https://example.test/source',
  kind: 'bill_text',
  publishedDate: null,
  observedAt: '2026-10-27T00:00:00.000Z',
  complete: true,
  sections: [{ locator: 'page 1', text: 'line 😀\nold', hash: 'section' }],
};
const rightVersion = {
  ...version,
  id: 'right',
  revision: 'r2',
  contentHash: 'hash-right',
  sections: [{ locator: 'page 2', text: 'line 😀\nnew', hash: 'other' }],
};
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const legislative = (
  input = parseVersionComparison({ ...pair, jurisdiction: 'FL', sessionKey: '2027' }),
) => ({
  input,
  raw: {
    ...json(compareResearchVersions(version, rightVersion)),
    scope: { clientId: null, folderId: null, jurisdiction: 'FL', sessionKey: '2027' },
  },
});

describe('native comparison receiving contracts with canonical producer helpers', () => {
  it('preserves exact large amounts and all budget qualifiers, without a lossy number conversion', () => {
    const input = parseBudgetComparison(pair);
    const raw = compareBudgetAmounts(amount, {
      ...amount,
      id: 'right',
      sourceRevision: 'r2',
      minorUnits: '900719925474099301',
    });
    const page = receiveBudgetComparison(input, raw);
    expect(page.data).toEqual(raw);
    expect(page.data.deltaMinorUnits).toBe('1');
    expect(page.data.left.minorUnits).toBe('900719925474099300');
  });
  it('preserves incompatible FY and veto basis as refusals to calculate', () => {
    const raw = compareBudgetAmounts(amount, {
      ...amount,
      id: 'right',
      sourceRevision: 'r2',
      fiscalYear: '2028',
      valueRole: 'vetoed_amount',
    });
    const { data } = receiveBudgetComparison(parseBudgetComparison(pair), raw);
    expect(data.comparable).toBe(false);
    expect(data.reasons).toEqual(
      expect.arrayContaining(['INCOMPATIBLE_fiscalYear', 'INCOMPATIBLE_VALUE_ROLE']),
    );
    expect(data.deltaMinorUnits).toBeNull();
  });
  it('preserves zero-baseline percentage unavailability', () => {
    const raw = compareBudgetAmounts(
      { ...amount, minorUnits: '0' },
      { ...amount, id: 'right', sourceRevision: 'r2', minorUnits: '1' },
    );
    expect(receiveBudgetComparison(parseBudgetComparison(pair), raw).data.percentage).toBeNull();
    expect(raw.reasons).toEqual(['ZERO_BASELINE_PERCENTAGE_UNDEFINED']);
  });
  it('rejects a stale/swapped source revision or numeric amount result', () => {
    const raw = compareBudgetAmounts(amount, { ...amount, id: 'right', sourceRevision: 'r2' });
    expect(() =>
      receiveBudgetComparison(parseBudgetComparison(pair), {
        ...raw,
        left: { ...raw.left, sourceRevision: 'stale' },
      }),
    ).toThrow();
    expect(() =>
      receiveBudgetComparison(parseBudgetComparison(pair), { ...raw, deltaMinorUnits: 0 }),
    ).toThrow();
  });
  it('preserves actual producer ranges, source metadata, classification and legal-effect warning', () => {
    const { input, raw } = legislative();
    const page = receiveVersionComparison(input, raw);
    expect(page.data).toEqual(raw);
    expect(page.data.changes[0]!.left!.end).toBe('line 😀'.length);
    expect(page.data.classification).toBe('textual_change');
    expect(page.data.warning).toContain('does not establish adoption');
  });
  it('requires explicit cross-bill and right-session intent', () => {
    expect(() =>
      parseVersionComparison({
        ...pair,
        jurisdiction: 'FL',
        sessionKey: '2027',
        rightSessionKey: '2028',
      }),
    ).toThrow();
    const input = parseVersionComparison({
      ...pair,
      jurisdiction: 'FL',
      sessionKey: '2027',
      allowCrossBill: true,
      rightSessionKey: '2028',
    });
    const raw = {
      ...json(
        compareResearchVersions(
          version,
          { ...rightVersion, billId: 'another', sessionKey: '2028' },
          true,
        ),
      ),
      scope: { clientId: null, folderId: null, jurisdiction: 'FL', sessionKey: '2027' },
    };
    expect(receiveVersionComparison(input, raw).data.right.sessionKey).toBe('2028');
    expect(() => receiveVersionComparison({ ...input, allowCrossBill: false }, raw)).toThrow();
  });
  it('rejects stale revisions, incorrect offsets, wrong line sides and invented output fields', () => {
    const { input, raw } = legislative();
    expect(() =>
      receiveVersionComparison(input, { ...raw, left: { ...raw.left, revision: 'stale' } }),
    ).toThrow();
    const wrongOffset = json(raw);
    wrongOffset.changes[0]!.left!.end--;
    expect(() => receiveVersionComparison(input, wrongOffset)).toThrow();
    const wrongSide = json(raw);
    wrongSide.changes[0]!.left = null;
    expect(() => receiveVersionComparison(input, wrongSide)).toThrow();
    expect(() =>
      receiveVersionComparison(input, { ...raw, authoritativeLegalEffect: true }),
    ).toThrow();
  });
  it('binds selected client/folder while preserving the owner-resolved General folder association', () => {
    const { input, raw } = legislative();
    const clientId = '10000000-0000-4000-8000-000000000001';
    expect(
      receiveVersionComparison(
        { ...input, folderId: 'folder' },
        { ...raw, scope: { ...raw.scope, folderId: 'folder', clientId } },
      ).data.scope.clientId,
    ).toBe(clientId);
    expect(() => receiveVersionComparison({ ...input, clientId }, raw)).toThrow();
    expect(() => receiveVersionComparison({ ...input, folderId: 'folder' }, raw)).toThrow();
  });
  it('rejects extra authority/effect arguments and invalid closed selections', () => {
    expect(() => parseBudgetComparison({ ...pair, tenantId: 'invented' })).toThrow();
    expect(() =>
      parseVersionComparison({ ...pair, jurisdiction: 'FL', sessionKey: '2027', apply: true }),
    ).toThrow();
    expect(() => parseBudgetComparison({ ...pair, jurisdiction: 'GA' })).toThrow();
  });
});
