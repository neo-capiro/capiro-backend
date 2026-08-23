/**
 * Phase 10B-1 — pure decision-logic tests for the governed observation
 * ingestion bridge's eligibility gate, exercised via the published
 * `@capiro/defense-domain` package (same import path
 * `observation-ingestion-bridge.service.ts` uses). No database, no I/O:
 * exactly the posture `assertObservationQueueable` in the domain package's
 * `watcher.ts` already uses for its own decision logic.
 */
import { evaluateBridgeEligibility, compareObservedShaToPersisted } from '@capiro/defense-domain';

describe('evaluateBridgeEligibility', () => {
  it('marks review_required as ineligible', () => {
    expect(evaluateBridgeEligibility('review_required')).toEqual({
      kind: 'ineligible',
      reason: expect.stringContaining('review_required'),
    });
  });

  it('marks blocked as ineligible', () => {
    expect(evaluateBridgeEligibility('blocked').kind).toBe('ineligible');
  });

  it('marks withdrawn as ineligible', () => {
    expect(evaluateBridgeEligibility('withdrawn').kind).toBe('ineligible');
  });

  it('marks changed as eligible', () => {
    expect(evaluateBridgeEligibility('changed')).toEqual({ kind: 'eligible' });
  });

  it('marks ingested as an idempotent replay, not a failure', () => {
    expect(evaluateBridgeEligibility('ingested')).toEqual({ kind: 'idempotent_replay' });
  });

  it('treats every other declared ObservationState as ineligible by default (fail-closed)', () => {
    for (const state of ['discovered', 'downloaded', 'classified', 'queued', 'unchanged', 'superseded'] as const) {
      expect(evaluateBridgeEligibility(state).kind).toBe('ineligible');
    }
  });
});

describe('compareObservedShaToPersisted', () => {
  it('matches when the fetched sha256 equals the persisted sha256', () => {
    const sha = 'a'.repeat(64);
    expect(compareObservedShaToPersisted({ persistedContentSha256: sha, fetchedContentSha256: sha })).toEqual({
      matches: true,
    });
  });

  it('does not match when bytes changed at the source', () => {
    expect(
      compareObservedShaToPersisted({
        persistedContentSha256: 'a'.repeat(64),
        fetchedContentSha256: 'b'.repeat(64),
      }),
    ).toEqual({ matches: false });
  });
});
