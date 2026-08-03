import {
  canonicalJsonStringify,
  sha256CanonicalJson,
  sha256Hex,
  sha256Bytes,
} from './canonical-json.js';

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

describe('sha256Hex', () => {
  it('produces a lowercase 64-char hex digest', () => {
    expect(sha256Hex('hello')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for the same input', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
  });
});

describe('sha256Bytes', () => {
  it('produces a lowercase 64-char hex digest', () => {
    expect(sha256Bytes(Buffer.from('hello', 'utf8'))).toMatch(/^[a-f0-9]{64}$/);
  });

  it('matches sha256Hex for the same UTF-8 content', () => {
    const text = 'hello world';
    expect(sha256Bytes(Buffer.from(text, 'utf8'))).toBe(sha256Hex(text));
  });

  it('correctly hashes non-ASCII bytes (PDF with binary content)', () => {
    // Use bytes with 0xFF which is invalid UTF-8 — this is the case where
    // sha256Bytes differs from sha256Hex(toString('binary')) and sha256Hex(toString('utf8')).
    // This simulates a PDF with raw binary content that is not valid UTF-8.
    const pdfBytes = Buffer.from([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xff, 0xfe, 0x00,
    ]);
    const hash = sha256Bytes(pdfBytes);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // The hash must NOT equal the hash of the binary string representation
    // (toString('binary') corrupts bytes > 0x7F into Latin-1 code points,
    // which then get re-encoded as multi-byte UTF-8 sequences)
    expect(hash).not.toBe(sha256Hex(pdfBytes.toString('binary')));
  });

  it('one-byte mutation changes the SHA', () => {
    const original = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    const mutated = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x06]);
    expect(sha256Bytes(original)).not.toBe(sha256Bytes(mutated));
  });

  it('accepts Uint8Array', () => {
    const arr = new Uint8Array([1, 2, 3]);
    const buf = Buffer.from([1, 2, 3]);
    expect(sha256Bytes(arr)).toBe(sha256Bytes(buf));
  });
});
