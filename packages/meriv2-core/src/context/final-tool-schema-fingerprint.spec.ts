import { fingerprintMeriFinalToolSchemas } from './final-tool-schema-fingerprint';

describe('fingerprintMeriFinalToolSchemas', () => {
  it('is deterministic across object-key ordering while preserving tool-array order', () => {
    const a = [{ type: 'function', name: 'lookup', parameters: { z: 1, a: { y: true, x: null } } }];
    const b = [{ parameters: { a: { x: null, y: true }, z: 1 }, name: 'lookup', type: 'function' }];
    expect(fingerprintMeriFinalToolSchemas(a)).toBe(fingerprintMeriFinalToolSchemas(b));
    expect(fingerprintMeriFinalToolSchemas([{ ...a[0]!, name: 'changed' }])).not.toBe(fingerprintMeriFinalToolSchemas(a));
    const pair = [a[0]!, { ...a[0]!, name: 'second' }];
    expect(fingerprintMeriFinalToolSchemas(pair)).not.toBe(fingerprintMeriFinalToolSchemas([...pair].reverse()));
    expect(fingerprintMeriFinalToolSchemas(a, 'v2')).not.toBe(fingerprintMeriFinalToolSchemas(a));
  });

  it('rejects values outside JSON-safe data', () => {
    expect(() => fingerprintMeriFinalToolSchemas([{ bad: Number.NaN }])).toThrow('meri_schema_not_json');
  });
});
