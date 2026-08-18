import type { CoverageAwareContextPacketV2 } from '@capiro/meriv2-core';

/**
 * Compile-time contract sentinel. If a required Phase 17 field is removed or
 * weakened, this file stops type-checking even before runtime tests execute.
 */
type RequiredPhase17Fields = Pick<
  CoverageAwareContextPacketV2,
  | 'resolvedEntities'
  | 'subjectScope'
  | 'coverageManifest'
  | 'sourceHealth'
  | 'sourceFreshness'
  | 'retrievalCompleteness'
  | 'retrievalStopReason'
  | 'evidenceRefs'
>;

const contract: RequiredPhase17Fields = {
  resolvedEntities: [],
  subjectScope: { kind: 'general', source: 'default_general', clientIds: [] },
  coverageManifest: null,
  sourceHealth: {},
  sourceFreshness: {},
  retrievalCompleteness: 'not_requested',
  retrievalStopReason: 'retrieval_not_requested',
  evidenceRefs: [],
};

describe('Phase 17 ContextPacket V2 field contract', () => {
  test('keeps the exact required coverage-aware fields typed', () => {
    expect(Object.keys(contract).sort()).toEqual(
      [
        'coverageManifest',
        'evidenceRefs',
        'resolvedEntities',
        'retrievalCompleteness',
        'retrievalStopReason',
        'sourceFreshness',
        'sourceHealth',
        'subjectScope',
      ].sort(),
    );
  });
});
