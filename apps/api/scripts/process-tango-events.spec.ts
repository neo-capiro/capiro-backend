import { parseArgs, readResourceRefs } from './process-tango-events.js';

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

  it("classifies each event on ITS OWN type, not the envelope's", () => {
    const refs = readResourceRefs(
      {
        events: [
          { event_type: 'opportunity.updated', id: 'OPP-1' },
          { event_type: 'forecast.published', id: 'F-1' },
        ],
      },
      '',
    );
    expect(refs.map((r) => r.resourceType)).toEqual(['opportunity', 'forecast']);
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
