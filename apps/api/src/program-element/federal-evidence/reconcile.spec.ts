import {
  reconcileFederalEvidence,
  type FederalEvidenceState,
  type FederalTextObservation,
} from './reconcile.js';

const EMPTY: FederalEvidenceState = { revisions: [], mentions: [] };
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const CODE_MAP = new Map([['0604256F', '0604256F']]);

function observation(overrides: Partial<FederalTextObservation> = {}): FederalTextObservation {
  return {
    billId: '119-hr-42',
    provider: 'govinfo',
    versionCode: 'BILLS-119hr42ih',
    sourceUrl: 'https://www.govinfo.gov/app/details/BILLS-119hr42ih',
    contentHash: HASH_A,
    observedAt: '2026-09-24T12:00:00.000Z',
    text: 'Sec. 402. Funding for 0604256F.',
    inventoryComplete: true,
    mentions: [
      {
        locator: 'section:402/mention:1',
        rawCode: '0604256F',
        canonicalCode: null,
        quote: '0604256F',
      },
    ],
    ...overrides,
  };
}

describe('reconcileFederalEvidence', () => {
  it('treats an identical retry as a no-op and returns the same initial outbox identity', () => {
    const first = reconcileFederalEvidence(EMPTY, observation(), CODE_MAP);
    const retry = reconcileFederalEvidence(first.state, observation(), CODE_MAP);

    expect(first.events.map((event) => event.kind)).toEqual(['text_revision_added', 'mention_added']);
    expect(retry.events).toEqual([]);
    expect(first.outbox.map((item) => item.dedupeKey)).toEqual([
      ...first.events.map((event) => `federal-evidence:${event.eventKey}`),
    ]);
    expect(new Set(first.outbox.map((item) => item.dedupeKey)).size).toBe(first.outbox.length);
  });

  it('retains a second immutable revision when language changes under the same version code', () => {
    const first = reconcileFederalEvidence(EMPTY, observation(), CODE_MAP);
    const changedObservation = observation({
      contentHash: HASH_B,
      text: 'Sec. 402. Revised funding for 0604256F.',
      mentions: [
        {
          locator: 'section:402/mention:1',
          rawCode: '0604256F',
          canonicalCode: null,
          quote: 'Revised funding for 0604256F',
        },
      ],
    });
    const changed = reconcileFederalEvidence(
      first.state,
      changedObservation,
      CODE_MAP,
    );
    const replay = reconcileFederalEvidence(first.state, changedObservation, CODE_MAP);
    const retry = reconcileFederalEvidence(changed.state, changedObservation, CODE_MAP);

    expect(changed.state.revisions).toHaveLength(2);
    expect(changed.state.revisions.map((revision) => revision.versionCode)).toEqual([
      'BILLS-119hr42ih',
      'BILLS-119hr42ih',
    ]);
    expect(changed.events.map((event) => event.kind)).toEqual([
      'text_revision_added',
      'mention_changed',
    ]);
    expect(changed.events[1]).toMatchObject({
      before: { quote: '0604256F' },
      after: { quote: 'Revised funding for 0604256F' },
    });
    expect(changed.events[1]?.eventKey).toBe(replay.events[1]?.eventKey);
    expect(retry.events).toHaveLength(0);
    expect(changed.state.mentions).toHaveLength(1);
  });

  it('plans removal only from complete inventories and reinstatement from a later observation', () => {
    const first = reconcileFederalEvidence(EMPTY, observation(), CODE_MAP);
    const incomplete = reconcileFederalEvidence(
      first.state,
      observation({ mentions: [], inventoryComplete: false }),
      CODE_MAP,
    );
    expect(incomplete.state.mentions[0]?.status).toBe('active');
    expect(incomplete.events).toEqual([]);

    const removed = reconcileFederalEvidence(
      first.state,
      observation({ contentHash: HASH_B, text: 'Sec. 402. Funding provision removed.', mentions: [] }),
      CODE_MAP,
    );
    expect(removed.state.mentions[0]?.status).toBe('removed');
    expect(removed.events.map((event) => event.kind)).toEqual([
      'text_revision_added',
      'mention_removed',
    ]);

    const reinstated = reconcileFederalEvidence(removed.state, observation({ contentHash: HASH_A }), CODE_MAP);
    expect(reinstated.state.mentions[0]?.status).toBe('active');
    expect(reinstated.events.map((event) => event.kind)).toEqual(['mention_reinstated']);
  });

  it('keeps unknown codes pending and emits a stable resolution event on registry replay', () => {
    const unknown = reconcileFederalEvidence(EMPTY, observation(), new Map());
    expect(unknown.state.mentions[0]?.status).toBe('pending_unknown_code');
    expect(unknown.events.map((event) => event.kind)).toEqual(['text_revision_added']);

    const replayed = reconcileFederalEvidence(unknown.state, observation(), CODE_MAP);
    const replayedAgain = reconcileFederalEvidence(replayed.state, observation(), CODE_MAP);
    expect(replayed.state.mentions[0]?.status).toBe('active');
    expect(replayed.events.map((event) => event.kind)).toEqual(['mention_resolved']);
    expect(replayedAgain.events).toEqual([]);
    expect(replayed.outbox[0]?.dedupeKey).toBe(`federal-evidence:${replayed.events[0]?.eventKey}`);
  });
});
