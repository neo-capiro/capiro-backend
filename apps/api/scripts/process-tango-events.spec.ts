import { parseArgs, readResourceRef } from './process-tango-events.js';

/**
 * Funding Opportunities P48 — the drain CLI's own argument and payload parsing.
 *
 * The processing logic itself is proven in
 * `src/funding-opportunities/tango-event-processor.spec.ts` against in-memory
 * doubles. This file covers only what lives in the script: flag parsing, and
 * reading a resource reference out of a payload whose shape the provider does
 * not contractually fix.
 */

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
    expect(readResourceRef({ opportunity_id: 'opp-1' }, 'opportunity.updated')).toEqual({
      resourceType: 'opportunity',
      externalId: 'opp-1',
    });
  });

  it('reads through a `data` envelope', () => {
    expect(readResourceRef({ data: { opportunity_id: 'opp-2' } }, 'opportunity.updated')).toEqual({
      resourceType: 'opportunity',
      externalId: 'opp-2',
    });
  });

  it('accepts the camelCase spelling too', () => {
    expect(readResourceRef({ opportunityId: 'opp-3' }, 'opportunity.updated').externalId).toBe(
      'opp-3',
    );
  });

  it('falls back through resource_id / id / external_id', () => {
    expect(readResourceRef({ id: 'opp-4' }, 'opportunity.updated').externalId).toBe('opp-4');
    expect(readResourceRef({ external_id: 'opp-5' }, 'opportunity.updated').externalId).toBe(
      'opp-5',
    );
  });

  it('classifies a forecast event', () => {
    expect(readResourceRef({ id: 'f-1' }, 'forecast.published').resourceType).toBe('forecast');
  });

  it('classifies an entity event', () => {
    expect(readResourceRef({ id: 'e-1' }, 'entity.updated').resourceType).toBe('entity');
  });

  it('RETURNS NULL rather than guessing when no id is present', () => {
    // A null external id completes as a no-op. Guessing one would mean retrying
    // forever against an identifier that was never in the payload.
    expect(readResourceRef({ note: 'nothing useful here' }, 'opportunity.updated')).toEqual({
      resourceType: 'opportunity',
      externalId: null,
    });
  });

  it('treats a blank id as absent', () => {
    expect(readResourceRef({ id: '   ' }, 'opportunity.updated').externalId).toBeNull();
  });

  it('trims a padded id rather than passing whitespace into a query', () => {
    expect(readResourceRef({ id: '  opp-6 ' }, 'opportunity.updated').externalId).toBe('opp-6');
  });

  it('survives a non-object payload', () => {
    expect(readResourceRef(null, 'opportunity.updated').externalId).toBeNull();
    expect(readResourceRef([1, 2, 3], 'opportunity.updated').externalId).toBeNull();
    expect(readResourceRef('a string', 'opportunity.updated').externalId).toBeNull();
  });

  it('ignores a non-string id rather than stringifying an object into a key', () => {
    expect(readResourceRef({ id: { nested: true } }, 'opportunity.updated').externalId).toBeNull();
  });
});
