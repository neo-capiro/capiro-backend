import {
  DEFAULT_UNSUPPORTED_THRESHOLD,
  parseVerifierClaims,
  summarizeVerification,
} from './verifier-claims';

describe('parseVerifierClaims', () => {
  it('parses claims from clean JSON', () => {
    const text = JSON.stringify({
      claims: [
        { claim: 'HR1 passed committee', supported: true, sourceIds: [1] },
        { claim: 'It will pass the floor', supported: false, sourceIds: [] },
      ],
    });
    expect(parseVerifierClaims(text)).toEqual([
      { claim: 'HR1 passed committee', supported: true, sourceIds: [1] },
      { claim: 'It will pass the floor', supported: false, sourceIds: [] },
    ]);
  });

  it('tolerates code fences and surrounding prose', () => {
    const text =
      'Here is the result:\n```json\n{"claims":[{"claim":"x","supported":true,"sourceIds":["2","2","abc"]}]}\n```\nDone.';
    expect(parseVerifierClaims(text)).toEqual([{ claim: 'x', supported: true, sourceIds: [2] }]);
  });

  it('treats missing/invalid supported as false and dedupes/cleans sourceIds', () => {
    const text = '{"claims":[{"claim":"y","sourceIds":[1,1,0,-3,"4"]}]}';
    expect(parseVerifierClaims(text)).toEqual([
      { claim: 'y', supported: false, sourceIds: [1, 4] },
    ]);
  });

  it('returns [] for unparseable or empty input', () => {
    expect(parseVerifierClaims('no json here')).toEqual([]);
    expect(parseVerifierClaims('')).toEqual([]);
    expect(parseVerifierClaims('{bad json')).toEqual([]);
    expect(parseVerifierClaims('{"claims":"nope"}')).toEqual([]);
  });

  it('drops claim entries without a claim string', () => {
    expect(
      parseVerifierClaims('{"claims":[{"supported":true},{"claim":"  "},{"claim":"ok"}]}'),
    ).toEqual([{ claim: 'ok', supported: false, sourceIds: [] }]);
  });
});

describe('summarizeVerification', () => {
  const claims = [
    { claim: 'a', supported: true, sourceIds: [1] },
    { claim: 'b', supported: true, sourceIds: [2] },
    { claim: 'c', supported: true, sourceIds: [] },
    { claim: 'd', supported: false, sourceIds: [] },
  ];

  it('computes ratio and stays confident at/under the threshold (1/4 = 0.25 with default 0.2 => low)', () => {
    const r = summarizeVerification(claims);
    expect(r.totalCount).toBe(4);
    expect(r.unsupportedCount).toBe(1);
    expect(r.unsupportedRatio).toBeCloseTo(0.25, 5);
    expect(r.lowConfidence).toBe(true); // 0.25 > 0.2
  });

  it('is confident when unsupported ratio is within threshold', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      claim: `c${i}`,
      supported: i > 0,
      sourceIds: [],
    }));
    // 1 of 10 unsupported = 0.1, not > 0.2
    expect(summarizeVerification(many).lowConfidence).toBe(false);
  });

  it('treats an empty claim set as confident', () => {
    const r = summarizeVerification([]);
    expect(r).toEqual({
      claims: [],
      totalCount: 0,
      unsupportedCount: 0,
      unsupportedRatio: 0,
      lowConfidence: false,
    });
  });

  it('honors a custom threshold', () => {
    const half = [
      { claim: 'a', supported: true, sourceIds: [] },
      { claim: 'b', supported: false, sourceIds: [] },
    ];
    expect(summarizeVerification(half, 0.5).lowConfidence).toBe(false); // 0.5 not > 0.5
    expect(summarizeVerification(half, 0.49).lowConfidence).toBe(true);
  });

  it('exposes a sane default threshold', () => {
    expect(DEFAULT_UNSUPPORTED_THRESHOLD).toBe(0.2);
  });
});
