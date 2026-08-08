import { canonicalAnalysisJson, sha256CanonicalAnalysisJson } from './meri-analysis-provenance.js';

describe('Meri analysis provenance hashing', () => {
  test('object insertion order does not change canonical bytes or hash', () => {
    const left = {
      findings: { delta: -22.7, stage: 'HAC-D' },
      table: [{ stage: 'Request', amount: 192.2 }],
    };
    const right = {
      table: [{ amount: 192.2, stage: 'Request' }],
      findings: { stage: 'HAC-D', delta: -22.7 },
    };

    expect(canonicalAnalysisJson(left)).toBe(canonicalAnalysisJson(right));
    expect(sha256CanonicalAnalysisJson(left)).toBe(sha256CanonicalAnalysisJson(right));
    expect(sha256CanonicalAnalysisJson(left)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('array order remains significant because chart row/series order is meaningful', () => {
    expect(sha256CanonicalAnalysisJson([1, 2, 3])).not.toBe(sha256CanonicalAnalysisJson([3, 2, 1]));
  });

  test('matches JSON omission/null semantics for unsupported values', () => {
    expect(canonicalAnalysisJson({ keep: 1, omit: undefined })).toBe('{"keep":1}');
    expect(canonicalAnalysisJson([1, undefined, Number.NaN])).toBe('[1,null,null]');
  });
});
