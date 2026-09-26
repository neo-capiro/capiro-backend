import { resolveScanCheckpoint, scanScopeHash } from './bizdev-watch-checkpoint.js';
import type { BizDevWatchBaseline, BizDevWatchScanCheckpoint } from './bizdev-watch.types.js';

/** Independent boundary tests: persisted JSON is data, not a trusted TS type. */
describe('watch checkpoint trust boundary', () => {
  const scopeHash = 'a'.repeat(64);
  const lowId = '00000000-0000-4000-8000-000000000001';
  const highId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

  function checkpoint(): BizDevWatchScanCheckpoint {
    return {
      version: 1,
      scopeHash,
      phase: 'initial',
      cursorId: lowId,
      fenceId: highId,
      pagesDone: 1,
      stagedRecords: {
        CONT_A: {
          recordId: 'CONT_A',
          fingerprint: 'b'.repeat(64),
          semanticSequence: 0,
          sourceRevision: null,
          effectiveAt: null,
          publishedAt: null,
          material: { amount: '0.00' },
        },
      },
    };
  }

  function baseline(scan: unknown = checkpoint()): BizDevWatchBaseline {
    return {
      initialized: false,
      establishedAt: '2026-09-26T00:00:00.000Z',
      effectiveFloorAt: null,
      records: {},
      scan: scan as BizDevWatchScanCheckpoint,
    };
  }

  test('valid initial progress survives unchanged', () => {
    const doc = baseline();
    expect(resolveScanCheckpoint(doc, scopeHash, false)).toEqual(doc.scan);
  });

  test('legacy initialized empty baseline starts established reconciliation, not a quiet reset', () => {
    const doc: BizDevWatchBaseline = {
      initialized: true,
      establishedAt: '2026-09-25T00:00:00.000Z',
      records: {},
    };
    const scan = resolveScanCheckpoint(doc, scopeHash, true);
    expect(scan.phase).toBe('cycle');
    expect(scan.cursorId).toBeNull();
    expect(scan.stagedRecords).toEqual({});
  });

  test.each([
    ['unknown version', { version: 2 }],
    ['fractional page counter', { pagesDone: 1.5 }],
    ['unsafe page counter', { pagesDone: Number.MAX_SAFE_INTEGER + 1 }],
    ['empty identity scope', { scopeHash: '' }],
    ['non-hash identity scope', { scopeHash: 'same-company' }],
    ['missing cursor property', { cursorId: undefined }],
    ['cursor without fence', { fenceId: null }],
    ['cursor past inclusive fence', { cursorId: highId, fenceId: lowId }],
    ['non-object exposure', { exposure: 'complete' }],
    [
      'malformed exposure agency list',
      {
        exposure: { cursorId: null, fenceId: highId, complete: true, agencies: 'Defense' },
      },
    ],
    [
      'non-string exposure agency',
      {
        exposure: { cursorId: null, fenceId: highId, complete: true, agencies: [42] },
      },
    ],
    [
      'invalid exposure completeness',
      {
        exposure: { cursorId: lowId, fenceId: highId, complete: 'yes', agencies: ['Defense'] },
      },
    ],
    [
      'exposure cursor past its own fence',
      {
        exposure: { cursorId: highId, fenceId: lowId, complete: false, agencies: ['Defense'] },
      },
    ],
    ['null staged record', { stagedRecords: { CONT_A: null } }],
    [
      'staged key-record mismatch',
      {
        stagedRecords: { CONT_A: { recordId: 'CONT_B', fingerprint: 'b'.repeat(64) } },
      },
    ],
    [
      'invalid staged fingerprint',
      {
        stagedRecords: { CONT_A: { recordId: 'CONT_A', fingerprint: 'not-a-fingerprint' } },
      },
    ],
    [
      'negative semantic sequence',
      {
        stagedRecords: {
          CONT_A: { recordId: 'CONT_A', fingerprint: 'b'.repeat(64), semanticSequence: -1 },
        },
      },
    ],
  ])('rejects %s without mutating stored progress', (_label, patch) => {
    const doc = baseline({ ...checkpoint(), ...patch });
    const before = JSON.stringify(doc);
    expect(() => resolveScanCheckpoint(doc, scopeHash, false)).toThrow();
    expect(JSON.stringify(doc)).toBe(before);
  });

  test('a reconciliation checkpoint cannot turn an uninitialized baseline into established state', () => {
    const doc = baseline({ ...checkpoint(), phase: 'cycle', stagedRecords: {} });
    expect(() => resolveScanCheckpoint(doc, scopeHash, false)).toThrow();
  });

  test('initial checkpoint on initialized baseline cannot silently reset accepted fingerprints', () => {
    const doc = { ...baseline(), initialized: true };
    expect(() => resolveScanCheckpoint(doc, scopeHash, true)).toThrow();
  });

  test('established checkpoint must not carry leftover quiet staged fingerprints', () => {
    const doc = { ...baseline({ ...checkpoint(), phase: 'cycle' }), initialized: true };
    expect(() => resolveScanCheckpoint(doc, scopeHash, true)).toThrow();
  });

  test('null baseline starts quiet, but malformed non-null baseline fails closed', () => {
    expect(resolveScanCheckpoint(null, scopeHash, false).phase).toBe('initial');
    for (const invalid of [[], 'bad', 42, {}, { initialized: 'yes', records: {} }]) {
      expect(() =>
        resolveScanCheckpoint(invalid as unknown as BizDevWatchBaseline, scopeHash, false),
      ).toThrow();
    }
  });
});

describe('watch scope hash follows the actual source relationship', () => {
  const anchor = { resolved: true, uei: 'UEI123456789', exactNames: ['ACME CORP'] };
  test.each(['federal_award', 'federal_assistance_award', 'sam_opportunity', 'tango_resource'])(
    '%s must not quiet-reset unchanged exact-UEI evidence when an alias is added',
    (family) => {
      expect(scanScopeHash(family, anchor)).toBe(
        scanScopeHash(family, { ...anchor, exactNames: ['ACME CORP', 'ACME LLC'] }),
      );
      expect(scanScopeHash(family, anchor)).not.toBe(
        scanScopeHash(family, { ...anchor, uei: 'OTHERUEI1234' }),
      );
    },
  );

  test('LDA name-scope expansion changes scope, whereas alias ordering does not', () => {
    const expanded = { ...anchor, exactNames: ['ACME CORP', 'ACME LLC'] };
    expect(scanScopeHash('lda_filing', anchor)).not.toBe(scanScopeHash('lda_filing', expanded));
    expect(scanScopeHash('lda_filing', expanded)).toBe(
      scanScopeHash('lda_filing', { ...expanded, exactNames: [...expanded.exactNames].reverse() }),
    );
  });
});
