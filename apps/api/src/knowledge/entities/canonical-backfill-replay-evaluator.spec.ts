import { describe, expect, test } from '@jest/globals';
import {
  evaluateCanonicalBackfillReplay,
  type CanonicalBackfillReplaySnapshot,
} from './canonical-backfill-replay-evaluator.js';

function snapshot(
  overrides: Partial<CanonicalBackfillReplaySnapshot> = {},
): CanonicalBackfillReplaySnapshot {
  return {
    entityIds: ['entity-1'],
    aliasKeys: ['entity-1|alias|rtx'],
    identifierKeys: ['entity-1|uei|ABCDEF123456'],
    resolutions: [{ key: 'client-1', selectedEntityId: 'entity-1' }],
    cursor: 'client-1',
    ...overrides,
  };
}

describe('canonical backfill replay evaluator', () => {
  test('passes an idempotent bounded replay', () => {
    const report = evaluateCanonicalBackfillReplay(snapshot(), snapshot());
    expect(report).toEqual(
      expect.objectContaining({
        addedEntityIds: [],
        addedAliasKeys: [],
        addedIdentifierKeys: [],
        changedSelections: [],
        cursorStable: true,
        pass: true,
      }),
    );
  });

  test('fails when replay creates duplicate identity material', () => {
    const second = snapshot({
      entityIds: ['entity-1', 'entity-2'],
      aliasKeys: ['entity-1|alias|rtx', 'entity-1|alias|rtx'],
    });
    const report = evaluateCanonicalBackfillReplay(snapshot(), second);

    expect(report.pass).toBe(false);
    expect(report.addedEntityIds).toEqual(['entity-2']);
    expect(report.duplicateAliasKeys).toEqual(['entity-1|alias|rtx']);
  });

  test('fails when the same source deterministically selects another entity', () => {
    const report = evaluateCanonicalBackfillReplay(
      snapshot(),
      snapshot({
        resolutions: [{ key: 'client-1', selectedEntityId: 'entity-2' }],
      }),
    );

    expect(report.pass).toBe(false);
    expect(report.changedSelections).toEqual([
      {
        key: 'client-1',
        firstSelectedEntityId: 'entity-1',
        secondSelectedEntityId: 'entity-2',
      },
    ]);
  });

  test('fails when the replay advances a supposedly identical cursor', () => {
    const report = evaluateCanonicalBackfillReplay(
      snapshot(),
      snapshot({ cursor: 'client-2' }),
    );
    expect(report.pass).toBe(false);
    expect(report.cursorStable).toBe(false);
  });
});
