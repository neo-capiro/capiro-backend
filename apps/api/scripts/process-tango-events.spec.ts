import type { PrismaClient } from '@prisma/client';
import { enqueuePendingDeliveries, parseArgs, readResourceRefs } from './process-tango-events.js';

/**
 * Funding Opportunities P48 — the drain CLI's own argument and payload parsing.
 *
 * The processing logic itself is proven in
 * `src/funding-opportunities/tango-event-processor.spec.ts` against in-memory
 * doubles. This file covers only what lives in the script: flag parsing, and
 * reading a resource reference out of a payload whose shape the provider does
 * not contractually fix.
 */

/** The first ref, for the many cases that assert a single-event body. */
function first(payload: unknown, eventType: string) {
  const refs = readResourceRefs(payload, eventType);
  const head = refs[0];
  if (!head) throw new Error('readResourceRefs returned nothing');
  return { resourceType: head.resourceType, externalId: head.externalId };
}

describe('readResourceRefs — EVERY event in a batch (re-review N1)', () => {
  // The re-review reproduced this: a delivery carrying two events queued ONE
  // outbox row, resolved events[0]'s opportunity, and marked itself done. The
  // second event's opportunity — its own critical deadline change — was
  // accepted with a 202 and silently discarded. The earlier "fix" only
  // narrowed the bug from "any batch" to "any batch with more than one event",
  // and its own test enshrined the discard by asserting the first id.

  it('returns ONE ref PER EVENT, in order', () => {
    const refs = readResourceRefs(
      {
        timestamp: '2026-08-08T00:00:00Z',
        events: [
          { event_type: 'opportunity.updated', opportunity_id: 'OPP-1' },
          { event_type: 'opportunity.updated', opportunity_id: 'OPP-2' },
          { event_type: 'opportunity.updated', opportunity_id: 'OPP-3' },
        ],
      },
      'opportunity.updated',
    );
    expect(refs.map((r) => r.externalId)).toEqual(['OPP-1', 'OPP-2', 'OPP-3']);
    expect(refs.map((r) => r.eventIndex)).toEqual([0, 1, 2]);
  });

  it("classifies each event on ITS OWN type, not the delivery's (re-review NEW-2)", () => {
    // A THIRD review reproduced this end to end: a delivery whose own
    // `event_type` was 'opportunity.updated' — the realistic, always-non-empty
    // case; `tango_webhook_delivery_event_type_chk` forbids a blank one, and
    // `readEnvelope` never lets it through empty — carried three events typed
    // opportunity/forecast/entity, and ALL THREE were classified 'opportunity'.
    // The original test asserting this worked passed `eventType: ''`, an input
    // production cannot generate, so it never caught that the precedence was
    // backwards. This one uses the real, non-empty delivery type.
    const refs = readResourceRefs(
      {
        events: [
          { event_type: 'opportunity.updated', id: 'OPP-1' },
          { event_type: 'forecast.published', id: 'F-1' },
          { event_type: 'entity.updated', id: 'E-1' },
        ],
      },
      'opportunity.updated', // the delivery-level type — REALISTIC, non-empty
    );
    expect(refs.map((r) => r.resourceType)).toEqual(['opportunity', 'forecast', 'entity']);
  });

  it('a single-event body with NO type key of its own still falls back to the delivery type', () => {
    // The fallback this fix must not break: a bare body carrying only an id has
    // nothing to classify on except what the delivery itself states.
    expect(readResourceRefs({ opportunity_id: 'OPP-bare' }, 'forecast.published')[0]).toMatchObject(
      { resourceType: 'forecast' },
    );
  });

  it('event_index is the position WITHIN THE DELIVERY, not within the filtered list (re-review NEW-4)', () => {
    // A prior version filtered non-object entries out before indexing, so
    // `['junk', {...}]` numbered the real event 0 instead of 1 — silently
    // violating the documented contract on a column that is part of the
    // idempotency key.
    const refs = readResourceRefs(
      { events: ['junk', { event_type: 'opportunity.updated', id: 'OPP-real' }] },
      'opportunity.updated',
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ eventIndex: 1, externalId: 'OPP-real' });
  });

  it('an event with no id yields a null ref rather than shifting the others', () => {
    const refs = readResourceRefs(
      { events: [{ event_type: 'ping' }, { event_type: 'opportunity.updated', id: 'OPP-2' }] },
      'opportunity.updated',
    );
    expect(refs).toHaveLength(2);
    expect(refs[0]?.externalId).toBeNull();
    expect(refs[1]?.externalId).toBe('OPP-2');
    expect(refs[1]?.eventIndex).toBe(1);
  });

  it('a single-event body is still exactly one ref at index 0', () => {
    const refs = readResourceRefs({ opportunity_id: 'OPP-solo' }, 'opportunity.updated');
    expect(refs).toEqual([{ eventIndex: 0, resourceType: 'opportunity', externalId: 'OPP-solo' }]);
  });

  it('the envelope fills only what an event omits', () => {
    const refs = readResourceRefs(
      { opportunity_id: 'FROM-ENVELOPE', events: [{ event_type: 'opportunity.updated' }] },
      'opportunity.updated',
    );
    expect(refs[0]?.externalId).toBe('FROM-ENVELOPE');
  });
});

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ commit: false, limit: 50, leaseSeconds: 300 });
  });

  it('reads --commit', () => {
    expect(parseArgs(['--commit']).commit).toBe(true);
  });

  it('does not treat --commit-nothing as --commit', () => {
    expect(parseArgs(['--commit-nothing']).commit).toBe(false);
  });

  it('reads a numeric limit', () => {
    expect(parseArgs(['--limit=200']).limit).toBe(200);
  });

  it.each([
    ['a non-numeric limit', '--limit=lots'],
    ['a zero limit', '--limit=0'],
    ['a negative limit', '--limit=-5'],
  ])('falls back to the default on %s rather than draining nothing (or everything)', (_l, arg) => {
    expect(parseArgs([arg]).limit).toBe(50);
  });

  it('truncates a fractional limit rather than passing it to SQL', () => {
    expect(parseArgs(['--limit=10.9']).limit).toBe(10);
  });

  it('reads a lease length', () => {
    expect(parseArgs(['--lease-seconds=60']).leaseSeconds).toBe(60);
  });
});

describe('readResourceRef', () => {
  it('reads a top-level opportunity_id', () => {
    expect(first({ opportunity_id: 'opp-1' }, 'opportunity.updated')).toEqual({
      resourceType: 'opportunity',
      externalId: 'opp-1',
    });
  });

  it('reads through a `data` envelope', () => {
    expect(first({ data: { opportunity_id: 'opp-2' } }, 'opportunity.updated')).toEqual({
      resourceType: 'opportunity',
      externalId: 'opp-2',
    });
  });

  it('accepts the camelCase spelling too', () => {
    expect(first({ opportunityId: 'opp-3' }, 'opportunity.updated').externalId).toBe('opp-3');
  });

  it('falls back through resource_id / id / external_id', () => {
    expect(first({ id: 'opp-4' }, 'opportunity.updated').externalId).toBe('opp-4');
    expect(first({ external_id: 'opp-5' }, 'opportunity.updated').externalId).toBe('opp-5');
  });

  it('classifies a forecast event', () => {
    expect(first({ id: 'f-1' }, 'forecast.published').resourceType).toBe('forecast');
  });

  it('classifies an entity event', () => {
    expect(first({ id: 'e-1' }, 'entity.updated').resourceType).toBe('entity');
  });

  it('RETURNS NULL rather than guessing when no id is present', () => {
    // A null external id completes as a no-op. Guessing one would mean retrying
    // forever against an identifier that was never in the payload.
    expect(first({ note: 'nothing useful here' }, 'opportunity.updated')).toEqual({
      resourceType: 'opportunity',
      externalId: null,
    });
  });

  it('treats a blank id as absent', () => {
    expect(first({ id: '   ' }, 'opportunity.updated').externalId).toBeNull();
  });

  it('trims a padded id rather than passing whitespace into a query', () => {
    expect(first({ id: '  opp-6 ' }, 'opportunity.updated').externalId).toBe('opp-6');
  });

  it('survives a non-object payload', () => {
    expect(first(null, 'opportunity.updated').externalId).toBeNull();
    expect(first([1, 2, 3], 'opportunity.updated').externalId).toBeNull();
    expect(first('a string', 'opportunity.updated').externalId).toBeNull();
  });

  it('ignores a non-string id rather than stringifying an object into a key', () => {
    expect(first({ id: { nested: true } }, 'opportunity.updated').externalId).toBeNull();
  });
});

describe('readResourceRef — BATCH deliveries (review finding F3)', () => {
  // The receiver deliberately ACCEPTS the provider's `{timestamp, events:[...]}`
  // shape. This function only looked at the top level and `data`, so a batch
  // resolved to externalId: null — which the processor treats as a legitimate
  // no-op and marks DONE. The delivery was accepted with a 202, queued, and
  // silently discarded. Accepting a shape at one layer and dropping it at the
  // next is worse than rejecting it outright.

  it('resolves the resource id from the FIRST event of a batch', () => {
    expect(
      first(
        {
          timestamp: '2026-08-08T00:00:00Z',
          events: [
            { event_type: 'opportunity.updated', opportunity_id: 'opp-batch' },
            { event_type: 'opportunity.updated', opportunity_id: 'opp-other' },
          ],
        },
        'opportunity.updated',
      ),
    ).toEqual({ resourceType: 'opportunity', externalId: 'opp-batch' });
  });

  it("each EVENT's own id wins over the envelope's", () => {
    // Reversed deliberately. The earlier precedence (envelope over event) was
    // part of the single-ref design: with one ref per delivery it did not
    // matter much, but with one ref PER EVENT it is actively wrong — an
    // envelope-level id would override every event and collapse a whole batch
    // onto one resource, which is the bug this replaced.
    //
    // The envelope still fills what an event omits; see the test of that name.
    expect(
      first(
        { opportunity_id: 'from-envelope', events: [{ opportunity_id: 'from-event' }] },
        'opportunity.updated',
      ).externalId,
    ).toBe('from-event');
  });

  it('classifies a batch forecast event from the EVENT type when the envelope has none', () => {
    expect(
      first({ events: [{ event_type: 'forecast.published', id: 'f-1' }] }, '').resourceType,
    ).toBe('forecast');
  });

  it('an EMPTY events array falls back to the top level rather than throwing', () => {
    expect(first({ events: [], id: 'opp-x' }, 'opportunity.updated').externalId).toBe('opp-x');
  });

  it('a non-object inside events is ignored, not spread', () => {
    expect(first({ events: ['nope'], id: 'opp-y' }, 'opportunity.updated').externalId).toBe(
      'opp-y',
    );
  });

  it('a batch naming no resource still returns null — a no-op, not a guess', () => {
    expect(first({ events: [{ event_type: 'ping' }] }, 'ping').externalId).toBeNull();
  });

  it('the receiver and the processor agree on the same batch payload', () => {
    // The regression in one sentence: these two must not disagree about
    // whether a delivery is actionable.
    const batch = {
      timestamp: '2026-08-08T00:00:00Z',
      events: [
        { delivery_id: 'dlv-1', event_type: 'opportunity.updated', opportunity_id: 'opp-agree' },
      ],
    };
    expect(first(batch, 'opportunity.updated').externalId).toBe('opp-agree');
  });
});

// ── enqueuePendingDeliveries — ATOMICITY (re-review NEW-1) ───────────────────

interface FakeOutboxRow {
  deliveryId: string;
  eventIndex: number;
  eventType: string;
  resourceType: string;
  externalId: string | null;
}

interface PendingDeliveryRow {
  delivery_id: string;
  event_type: string;
  payload: unknown;
}

/**
 * A fake Prisma client whose `$transaction` has REAL rollback semantics: if
 * the callback throws, nothing it inserted is kept; if it resolves, all of it
 * is. That distinction is the entire point of the fix under test, so a fake
 * that could not fail partway through would prove nothing — the whole prior
 * bug (re-review NEW-1) was that a crash mid-batch left SOME of a delivery's
 * rows committed and the rest lost forever. `failAfter` lets a test put the
 * crash exactly where it matters: between two `INSERT`s of the same delivery.
 */
function makeFakePrisma(pending: PendingDeliveryRow[]) {
  const committed: FakeOutboxRow[] = [];
  const seen = new Set<string>(); // "deliveryId|eventIndex" already committed
  let failAfter: number | null = null;
  let insertAttempts = 0;

  const fake = {
    async $queryRaw() {
      return pending;
    },
    async $transaction(
      run: (tx: { $executeRaw: (...args: unknown[]) => Promise<void> }) => Promise<void>,
    ) {
      const stagedInThisTx: FakeOutboxRow[] = [];
      const tx = {
        $executeRaw: async (_strings: unknown, ...values: unknown[]) => {
          insertAttempts += 1;
          if (failAfter !== null && insertAttempts > failAfter) {
            throw new Error('simulated crash mid-transaction');
          }
          const [deliveryId, eventIndex, eventType, resourceType, externalId] = values as [
            string,
            number,
            string,
            string,
            string | null,
          ];
          const key = `${deliveryId}|${eventIndex}`;
          if (!seen.has(key))
            stagedInThisTx.push({ deliveryId, eventIndex, eventType, resourceType, externalId });
        },
      };
      // A throw here propagates OUT of $transaction before this loop ever
      // runs — that is the rollback. Nothing staged is kept.
      await run(tx);
      for (const row of stagedInThisTx) {
        seen.add(`${row.deliveryId}|${row.eventIndex}`);
        committed.push(row);
      }
    },
    get rows() {
      return committed;
    },
    /** Throw on the (1-indexed) insert attempt AFTER this many succeed. Null = never. */
    setFailAfter(n: number | null) {
      failAfter = n;
    },
  };
  return fake;
}

function threeEventBatch(deliveryId: string) {
  return {
    delivery_id: deliveryId,
    event_type: 'opportunity.updated',
    payload: {
      events: [
        { event_type: 'opportunity.updated', id: 'A' },
        { event_type: 'opportunity.updated', id: 'B' },
        { event_type: 'opportunity.updated', id: 'C' },
      ],
    },
  };
}

describe('enqueuePendingDeliveries — ATOMICITY (re-review NEW-1)', () => {
  it('a delivery crashing mid-batch leaves ZERO rows for it, never a partial set', async () => {
    // This is the exact defect the third review reproduced: a prior version
    // inserted each event as an independent statement, so a crash after event
    // 0 but before events 1 and 2 left event 0 committed and the "already
    // enqueued" check (one row exists) meant 1 and 2 were never revisited —
    // silent, permanent loss.
    const fake = makeFakePrisma([threeEventBatch('DLV-CRASH')]);
    fake.setFailAfter(1); // event 0 succeeds, event 1 throws

    await expect(
      enqueuePendingDeliveries(fake as unknown as PrismaClient, true, 50),
    ).rejects.toThrow('simulated crash mid-transaction');

    expect(fake.rows).toHaveLength(0);
  });

  it('a delivery that crashes is retried FROM SCRATCH on the next pass, not resumed', async () => {
    const fake = makeFakePrisma([threeEventBatch('DLV-RETRY')]);
    fake.setFailAfter(0); // every insert in the first attempt fails

    await expect(
      enqueuePendingDeliveries(fake as unknown as PrismaClient, true, 50),
    ).rejects.toThrow();
    expect(fake.rows).toHaveLength(0);

    // "the process restarted" — no more injected failure.
    fake.setFailAfter(null);
    const enqueued = await enqueuePendingDeliveries(fake as unknown as PrismaClient, true, 50);

    expect(enqueued).toBe(3);
    expect(fake.rows.map((r) => r.externalId)).toEqual(['A', 'B', 'C']);
  });

  it('a delivery that succeeds commits ALL of its events, never a subset', async () => {
    const fake = makeFakePrisma([threeEventBatch('DLV-OK')]);
    const enqueued = await enqueuePendingDeliveries(fake as unknown as PrismaClient, true, 50);

    expect(enqueued).toBe(3);
    expect(fake.rows.map((r) => r.externalId)).toEqual(['A', 'B', 'C']);
    expect(fake.rows.every((r) => r.deliveryId === 'DLV-OK')).toBe(true);
  });

  it('one delivery crashing does not corrupt an UNRELATED delivery in the same run', async () => {
    // One transaction PER DELIVERY — a later delivery's own transaction must
    // not be caught up in an earlier one's rollback.
    const fake = makeFakePrisma([threeEventBatch('DLV-BAD'), threeEventBatch('DLV-GOOD')]);
    fake.setFailAfter(1); // fails during DLV-BAD's second insert

    await expect(
      enqueuePendingDeliveries(fake as unknown as PrismaClient, true, 50),
    ).rejects.toThrow();

    // DLV-BAD is the one being processed when the throw happens, so the run
    // stops there; DLV-GOOD, never reached, is untouched — also zero, not
    // corrupted. This documents the current stop-on-first-failure behaviour
    // rather than a partial-success-with-skip behaviour, which is the
    // conservative choice: continuing past an unexplained transaction failure
    // risks compounding whatever broke it.
    expect(fake.rows.filter((r) => r.deliveryId === 'DLV-BAD')).toHaveLength(0);
    expect(fake.rows.filter((r) => r.deliveryId === 'DLV-GOOD')).toHaveLength(0);
  });

  it('a dry run never opens a transaction at all', async () => {
    const fake = makeFakePrisma([
      {
        delivery_id: 'DLV-DRY',
        event_type: 'opportunity.updated',
        payload: { opportunity_id: 'D1' },
      },
    ]);
    const count = await enqueuePendingDeliveries(fake as unknown as PrismaClient, false, 50);

    expect(count).toBe(1); // reports what WOULD be enqueued
    expect(fake.rows).toHaveLength(0);
  });

  it('a REPLAY of an already-fully-enqueued delivery commits nothing new', async () => {
    // Same fake, same delivery, presented a second time — as if the enqueue
    // SELECT's own "already has a row" filter had somehow not excluded it.
    // `ON CONFLICT DO NOTHING` means every insert is still attempted, but none
    // of them land, because `seen` already holds all three keys.
    const fake = makeFakePrisma([threeEventBatch('DLV-REPLAY')]);
    await enqueuePendingDeliveries(fake as unknown as PrismaClient, true, 50);
    expect(fake.rows).toHaveLength(3);

    await enqueuePendingDeliveries(fake as unknown as PrismaClient, true, 50);
    expect(fake.rows).toHaveLength(3);
  });
});
