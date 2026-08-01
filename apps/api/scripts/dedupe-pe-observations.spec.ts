/**
 * dedupe-pe-observations.spec.ts — survivor selection + safety contract tests.
 *
 * The pure decision logic (survivor pick, winner-hazard skip) is replicated here
 * against in-memory member rows so the rules are verified by execution, not by
 * reading the SQL. The script itself is exercised via dry-run on live.
 */
import { describe, expect, it } from '@jest/globals';

interface MemberRow {
  id: string;
  recordedAt: Date;
  lastObservedAt: Date | null;
  observationCount: number;
  sourceDocumentId: string | null;
  isWinner: boolean;
}

/** Mirror of the survivor-pick rules in dedupe-pe-observations.ts. */
function pickSurvivor(members: MemberRow[]): { survivor: MemberRow | null; hazard: boolean } {
  const winnerCount = members.filter((m) => m.isWinner).length;
  if (winnerCount > 1) return { survivor: null, hazard: true };
  let survivor = members[0]!;
  for (const m of members) {
    if (m.recordedAt < survivor.recordedAt) survivor = m;
    else if (
      m.recordedAt.getTime() === survivor.recordedAt.getTime() &&
      survivor.sourceDocumentId === null &&
      m.sourceDocumentId !== null
    ) {
      survivor = m;
    }
  }
  if (winnerCount === 1 && !survivor.isWinner) {
    survivor = members.find((m) => m.isWinner)!;
  }
  return { survivor, hazard: false };
}

const T = (s: string) => new Date(`2026-01-01T${s}Z`);

describe('dedupe survivor selection', () => {
  it('keeps earliest recordedAt', () => {
    const members: MemberRow[] = [
      { id: 'b', recordedAt: T('02:00'), lastObservedAt: null, observationCount: 1, sourceDocumentId: null, isWinner: false },
      { id: 'a', recordedAt: T('01:00'), lastObservedAt: null, observationCount: 1, sourceDocumentId: null, isWinner: false },
    ];
    const { survivor, hazard } = pickSurvivor(members);
    expect(hazard).toBe(false);
    expect(survivor!.id).toBe('a');
  });

  it('tie-breaks toward the row with sourceDocumentId', () => {
    const members: MemberRow[] = [
      { id: 'a', recordedAt: T('01:00'), lastObservedAt: null, observationCount: 1, sourceDocumentId: null, isWinner: false },
      { id: 'b', recordedAt: T('01:00'), lastObservedAt: null, observationCount: 1, sourceDocumentId: 'doc-1', isWinner: false },
    ];
    const { survivor } = pickSurvivor(members);
    expect(survivor!.id).toBe('b');
  });

  it('keeps the single winner even when it is not earliest', () => {
    const members: MemberRow[] = [
      { id: 'a', recordedAt: T('01:00'), lastObservedAt: null, observationCount: 1, sourceDocumentId: null, isWinner: false },
      { id: 'b', recordedAt: T('02:00'), lastObservedAt: null, observationCount: 1, sourceDocumentId: null, isWinner: true },
    ];
    const { survivor, hazard } = pickSurvivor(members);
    expect(hazard).toBe(false);
    expect(survivor!.id).toBe('b');
  });

  it('skips groups with multiple winners (reconciliation triage, not dedupe)', () => {
    const members: MemberRow[] = [
      { id: 'a', recordedAt: T('01:00'), lastObservedAt: null, observationCount: 1, sourceDocumentId: null, isWinner: true },
      { id: 'b', recordedAt: T('02:00'), lastObservedAt: null, observationCount: 1, sourceDocumentId: null, isWinner: true },
    ];
    const { survivor, hazard } = pickSurvivor(members);
    expect(hazard).toBe(true);
    expect(survivor).toBeNull();
  });
});
