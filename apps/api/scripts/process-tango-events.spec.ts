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
 * A fake Prisma client that models the ONE property the fix depends on: a
 * single SQL statement either applies in full or not at all. Postgres gives
 * that by construction, so the fake gives it by construction too — there is
 * no code path here that can stage a partial set, because there is no code
 * path in the real thing either.
 *
 * The fake ALSO fails loudly if the code under test opens an interactive
 * transaction (`$transaction`). That is not pedantry: the previous version of
 * this fix wrapped N per-event inserts in `$transaction`, and a fourth review
 * found that Prisma's default 5-second interactive-transaction timeout made a
 * large-but-legal delivery fail identically on every retry — permanently
 * jamming every delivery queued behind it. Reintroducing `$transaction` here
 * would reintroduce that cliff, so the fake treats it as a hard error rather
 * than letting it pass quietly.
 */
function makeFakePrisma(pending: PendingDeliveryRow[]) {
  const committed: FakeOutboxRow[] = [];
  const seen = new Set<string>(); // "deliveryId|eventIndex" already committed
  let failNextStatement = false;
  let statements = 0;

  const fake = {
    async $queryRaw() {
      return pending;
    },
    async $transaction() {
      throw new Error(
        'enqueuePendingDeliveries must NOT open an interactive transaction — ' +
          'its 5s default timeout is the D-59 queue-jamming defect. One statement per delivery.',
      );
    },
    async $executeRaw(_strings: unknown, ...values: unknown[]) {
      statements += 1;
      if (failNextStatement) {
        failNextStatement = false;
        // A statement that fails writes NOTHING. Not "writes what it got to".
        throw new Error('simulated statement failure');
      }
      const [deliveryIds, eventIndexes, eventTypes, resourceTypes, externalIds] = values as [
        string[],
        number[],
        string[],
        string[],
        (string | null)[],
      ];
      // Five parallel arrays, one row each — exactly what `unnest` expands.
      deliveryIds.forEach((deliveryId, i) => {
        const eventIndex = eventIndexes[i] as number;
        const key = `${deliveryId}|${eventIndex}`;
        if (seen.has(key)) return; // ON CONFLICT DO NOTHING
        seen.add(key);
        committed.push({
          deliveryId,
          eventIndex,
          eventType: eventTypes[i] as string,
          resourceType: resourceTypes[i] as string,
          externalId: externalIds[i] ?? null,
        });
      });
    },
    get rows() {
      return committed;
    },
    /** How many SQL statements were issued — one per delivery, never one per event. */
    get statementCount() {
      return statements;
    },
    failNext() {
      failNextStatement = true;
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

describe('enqueuePendingDeliveries — ATOMICITY (re-review NEW-1, D-59)', () => {
  it('issues exactly ONE statement per delivery, regardless of event count', async () => {
    // The load-bearing assertion of this whole fix. Two earlier versions failed
    // here in opposite directions: N independent statements (a crash between
    // them lost events permanently), then N statements inside one interactive
    // transaction (whose 5s default timeout jammed the queue on a large but
    // perfectly legal delivery). One statement is what makes atomicity free
    // and makes cost independent of N.
    const fake = makeFakePrisma([threeEventBatch('DLV-ONE-STMT')]);
    await enqueuePendingDeliveries(fake as unknown as PrismaClient, true, 50);

    expect(fake.statementCount).toBe(1);
    expect(fake.rows).toHaveLength(3);
  });

  it('a 5000-event delivery is still ONE statement — no size at which this breaks', async () => {
    // 5000 events is past BOTH prior cliffs: the ~3000-statement interactive
    // transaction timeout, and the ~13k-row ceiling a multi-row VALUES would
    // have hit against Postgres's 65535 bound-parameter cap. Passing five
    // ARRAYS binds five parameters total, so N does not enter into it.
    const fake = makeFakePrisma([
      {
        delivery_id: 'DLV-HUGE',
        event_type: 'opportunity.updated',
        payload: {
          events: Array.from({ length: 5000 }, (_, i) => ({
            event_type: 'opportunity.updated',
            id: `OPP-${i}`,
          })),
        },
      },
    ]);
    const enqueued = await enqueuePendingDeliveries(fake as unknown as PrismaClient, true, 50);

    expect(enqueued).toBe(5000);
    expect(fake.statementCount).toBe(1);
    expect(fake.rows).toHaveLength(5000);
    expect(fake.rows[4999]).toMatchObject({ eventIndex: 4999, externalId: 'OPP-4999' });
  });

  it('a statement that fails leaves ZERO rows for that delivery, never a partial set', async () => {
    // The third review's defect: a prior version inserted each event
    // independently, so a failure after event 0 left it committed while the
    // "already enqueued" check (a row exists) meant 1 and 2 were never
    // revisited — silent, permanent loss.
    const fake = makeFakePrisma([threeEventBatch('DLV-CRASH')]);
    fake.failNext();

    await expect(
      enqueuePendingDeliveries(fake as unknown as PrismaClient, true, 50),
    ).rejects.toThrow('simulated statement failure');

    expect(fake.rows).toHaveLength(0);
  });

  it('a delivery that fails is retried FROM SCRATCH on the next pass, not resumed', async () => {
    const fake = makeFakePrisma([threeEventBatch('DLV-RETRY')]);
    fake.failNext();

    await expect(
      enqueuePendingDeliveries(fake as unknown as PrismaClient, true, 50),
    ).rejects.toThrow();
    expect(fake.rows).toHaveLength(0);

    // "the process restarted" — no more injected failure.
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

  it('one delivery failing does not corrupt an UNRELATED delivery in the same run', async () => {
    // Nothing wraps ACROSS deliveries, so a later delivery can never be rolled
    // back by an earlier one's failure.
    const fake = makeFakePrisma([threeEventBatch('DLV-BAD'), threeEventBatch('DLV-GOOD')]);
    fake.failNext(); // fails on DLV-BAD's statement

    await expect(
      enqueuePendingDeliveries(fake as unknown as PrismaClient, true, 50),
    ).rejects.toThrow();

    // DLV-BAD is the one being processed when the throw happens, so the run
    // stops there; DLV-GOOD, never reached, is untouched — zero, not
    // corrupted. This documents the current stop-on-first-failure behaviour
    // rather than partial-success-with-skip, which is the conservative choice:
    // continuing past an unexplained failure risks compounding what broke it.
    expect(fake.rows.filter((r) => r.deliveryId === 'DLV-BAD')).toHaveLength(0);
    expect(fake.rows.filter((r) => r.deliveryId === 'DLV-GOOD')).toHaveLength(0);
  });

  it('a dry run issues no statement at all', async () => {
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
    expect(fake.statementCount).toBe(0);
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
