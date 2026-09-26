import {
  decodeFedrampSvelteRouteData,
  FEDRAMP_SVELTE_ROUTE_DATA_SOURCE_ID,
  FedrampSvelteRouteDataError,
} from './fedramp.sveltekit-route-data.js';

const OBSERVED_AT = '2026-09-25T10:30:00.000Z';
const LAST_CHANGE = '2026-09-22T02:27:32.75Z';

function graph() {
  const data: unknown[] = [
    { fedRAMPData: 1 },
    { meta: 2, data: 5 },
    { last_change: 3, produced_by: 4 },
    ['Date', LAST_CHANGE],
    'General Services Administration',
    { Products: 6 },
    [7],
    { id: 8, csp: 9, cso: 10, status: 11, impact_level: 12 },
    'FR260215856',
    'SandboxAQ',
    'AQtive Guard',
    'FedRAMP Certified',
    'Moderate',
  ];
  return {
    data,
    envelope: {
      type: 'data',
      nodes: [
        { type: 'data', data: [{}], uses: [] },
        { type: 'data', data: [null], uses: [] },
        { type: 'data', data: [null], uses: [] },
        { type: 'data', data, uses: [] },
      ],
    },
  };
}

function encode(envelope: unknown): string {
  return JSON.stringify(envelope);
}

describe('dormant FedRAMP SvelteKit route-data decoder', () => {
  it('decodes only the bounded product/core fields and labels the result unverified', () => {
    const { envelope } = graph();
    const snapshot = decodeFedrampSvelteRouteData(encode(envelope), OBSERVED_AT);

    expect(snapshot).toMatchObject({
      sourceId: FEDRAMP_SVELTE_ROUTE_DATA_SOURCE_ID,
      observedAt: OBSERVED_AT,
      lastChange: LAST_CHANGE,
      sourceCount: 1,
      authority: 'unverified-route-snapshot',
      uncertainty: [
        'undocumented-framework-route-data',
        'freshness-and-inventory-completeness-unverified',
        'source-count-is-snapshot-array-length-only',
        'not-suitable-for-negative-claims',
      ],
      products: [{
        id: 'FR260215856',
        csp: 'SandboxAQ',
        cso: 'AQtive Guard',
        status: 'FedRAMP Certified',
        impactLevel: 'Moderate',
      }],
    });
  });

  it('rejects malformed envelopes, invalid timestamps, and missing or ambiguous roots', () => {
    const { envelope } = graph();
    expect(() => decodeFedrampSvelteRouteData('{', OBSERVED_AT)).toThrow('Invalid route-data JSON');
    expect(() => decodeFedrampSvelteRouteData(encode(envelope), 'not-a-date')).toThrow('Invalid observation timestamp');
    expect(() => decodeFedrampSvelteRouteData(encode({ type: 'data', nodes: [] }), OBSERVED_AT))
      .toThrow('Unsupported route-data envelope');

    const missing = graph().envelope;
    missing.nodes[3]!.data[0] = {};
    expect(() => decodeFedrampSvelteRouteData(encode(missing), OBSERVED_AT)).toThrow('Missing or ambiguous fedRAMPData root');

    const ambiguous = graph().envelope;
    ambiguous.nodes.push({ type: 'data', data: [{ fedRAMPData: 1 }], uses: [] });
    expect(() => decodeFedrampSvelteRouteData(encode(ambiguous), OBSERVED_AT)).toThrow('Missing or ambiguous fedRAMPData root');
  });

  it('rejects invalid, tagged, non-scalar, and out-of-range core references without recursion', () => {
    const tagged = graph();
    (tagged.data[7] as Record<string, unknown>).cso = 3;
    expect(() => decodeFedrampSvelteRouteData(encode(tagged.envelope), OBSERVED_AT))
      .toThrow('Invalid, empty, tagged, or non-scalar product.cso');

    const cyclic = graph();
    (cyclic.data[7] as Record<string, unknown>).cso = 7;
    expect(() => decodeFedrampSvelteRouteData(encode(cyclic.envelope), OBSERVED_AT))
      .toThrow('Invalid, empty, tagged, or non-scalar product.cso');

    const outOfRange = graph();
    (outOfRange.data[7] as Record<string, unknown>).id = 999;
    expect(() => decodeFedrampSvelteRouteData(encode(outOfRange.envelope), OBSERVED_AT))
      .toThrow('Invalid or out-of-range product.id graph reference');
  });

  it('accepts only the observed numeric, short, suffixed, and named legacy product IDs', () => {
    for (const id of [
      'F1607067912',
      'FR260215856',
      'FR1923743650A',
      'FR2409863458XL',
      'FR2409863458XM',
      'AGENCYAMAZONEW',
      'AGENCYHUDSAAS',
      'AGENCYNITCIAAS',
      'AGENCYWC2',
      'MSO365MT',
      'MSO365MTA',
      'SOCRATA',
    ]) {
      const fixture = graph();
      fixture.data[8] = id;
      expect(decodeFedrampSvelteRouteData(encode(fixture.envelope), OBSERVED_AT).products[0]!.id).toBe(id);
    }

    const unsupported = graph();
    unsupported.data[8] = 'FR123456789Z';
    expect(() => decodeFedrampSvelteRouteData(encode(unsupported.envelope), OBSERVED_AT))
      .toThrow('Unsupported product ID shape FR123456789Z');

    const unknownNamed = graph();
    unknownNamed.data[8] = 'AGENCYUNKNOWN';
    expect(() => decodeFedrampSvelteRouteData(encode(unknownNamed.envelope), OBSERVED_AT))
      .toThrow('Unsupported product ID shape AGENCYUNKNOWN');
  });

  it('rejects UTC timestamps that Date.parse would normalize to a different calendar date', () => {
    const invalidObservedAt = '2026-02-31T10:30:00.000Z';
    expect(() => decodeFedrampSvelteRouteData(encode(graph().envelope), invalidObservedAt))
      .toThrow('Invalid observation timestamp');

    const invalidLastChange = graph();
    invalidLastChange.data[3] = ['Date', '2026-02-31T02:27:32.750Z'];
    expect(() => decodeFedrampSvelteRouteData(encode(invalidLastChange.envelope), OBSERVED_AT))
      .toThrow('Invalid source meta.last_change Date tag');
  });

  it('rejects duplicate IDs, missing core strings, and unknown status or impact values', () => {
    const duplicate = graph();
    duplicate.data[6] = [7, 7];
    expect(() => decodeFedrampSvelteRouteData(encode(duplicate.envelope), OBSERVED_AT))
      .toThrow('Duplicate product ID FR260215856');

    const missing = graph();
    delete (missing.data[7] as Record<string, unknown>).cso;
    expect(() => decodeFedrampSvelteRouteData(encode(missing.envelope), OBSERVED_AT))
      .toThrow('Invalid or out-of-range product.cso graph reference');

    const unknownStatus = graph();
    unknownStatus.data[13] = 'A status not in the reviewed vocabulary';
    (unknownStatus.data[7] as Record<string, unknown>).status = 13;
    expect(() => decodeFedrampSvelteRouteData(encode(unknownStatus.envelope), OBSERVED_AT))
      .toThrow('Unknown product status for FR260215856');

    const unknownImpact = graph();
    unknownImpact.data[13] = 'Class Q';
    (unknownImpact.data[7] as Record<string, unknown>).impact_level = 13;
    expect(() => decodeFedrampSvelteRouteData(encode(unknownImpact.envelope), OBSERVED_AT))
      .toThrow('Unknown product impact level for FR260215856');
  });

  it('rejects oversized node, graph-slot, and product collections before walking them', () => {
    const tooManyNodes = graph().envelope;
    tooManyNodes.nodes = Array.from({ length: 9 }, () => ({ type: 'data', data: [{}], uses: [] }));
    expect(() => decodeFedrampSvelteRouteData(encode(tooManyNodes), OBSERVED_AT)).toThrow('Unsupported route-data envelope');

    const tooManySlots = graph().envelope;
    tooManySlots.nodes[0]!.data = Array.from({ length: 100_001 }, () => null);
    expect(() => decodeFedrampSvelteRouteData(encode(tooManySlots), OBSERVED_AT)).toThrow('Route-data graph exceeds slot limit');

    const tooManyProducts = graph();
    tooManyProducts.data[6] = Array.from({ length: 2_001 }, () => 7);
    expect(() => decodeFedrampSvelteRouteData(encode(tooManyProducts.envelope), OBSERVED_AT))
      .toThrow('Products is not a bounded, non-empty reference array');
  });

  it('rejects over-sized input before JSON parsing', () => {
    expect(() => decodeFedrampSvelteRouteData(' '.repeat(8 * 1024 * 1024 + 1), OBSERVED_AT))
      .toThrow(FedrampSvelteRouteDataError);
  });
});
