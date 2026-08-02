import { canonicalJsonStringify, sha256CanonicalJson } from './canonical-json.js';

describe('canonicalJsonStringify', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJsonStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('produces no insignificant whitespace', () => {
    expect(canonicalJsonStringify({ a: [1, { b: 'x' }] })).toBe('{"a":[1,{"b":"x"}]}');
  });

  it('handles primitives', () => {
    expect(canonicalJsonStringify(null)).toBe('null');
    expect(canonicalJsonStringify(true)).toBe('true');
    expect(canonicalJsonStringify('a"b')).toBe('"a\\"b"');
    expect(canonicalJsonStringify(1.5)).toBe('1.5');
  });

  it('rejects undefined values', () => {
    expect(() =>
      canonicalJsonStringify({ a: undefined } as unknown as Parameters<
        typeof canonicalJsonStringify
      >[0]),
    ).toThrow(/undefined/);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJsonStringify(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalJsonStringify(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });

  it('rejects cyclic values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      canonicalJsonStringify(cyclic as unknown as Parameters<typeof canonicalJsonStringify>[0]),
    ).toThrow(/cyclic/);
  });

  it('is deterministic across key insertion orders', () => {
    const first = canonicalJsonStringify({ a: 1, b: 2, c: { y: 1, z: 2 } });
    const second = canonicalJsonStringify({ c: { z: 2, y: 1 }, b: 2, a: 1 });
    expect(first).toBe(second);
  });
});

describe('sha256CanonicalJson', () => {
  it('produces a lowercase 64-char hex digest', () => {
    expect(sha256CanonicalJson({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is stable across key insertion orders', () => {
    expect(sha256CanonicalJson({ a: 1, b: 2 })).toBe(sha256CanonicalJson({ b: 2, a: 1 }));
  });

  it('differs for different values', () => {
    expect(sha256CanonicalJson({ a: 1 })).not.toBe(sha256CanonicalJson({ a: 2 }));
  });
});
