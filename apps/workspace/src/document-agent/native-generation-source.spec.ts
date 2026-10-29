import { describe, it, expect } from '@jest/globals';
import {
  nativeGenerationSourceSnapshot,
  nativeGenerationSourceWire,
} from './native-generation-source.js';
import { nativeGenerationRequestId } from './native-generation.bridge.js';

const exact = {
  tenantId: 'tenant',
  actorId: 'actor',
  draftId: 'draft',
  clientId: null,
  phase: 'document' as const,
  expectedRevision: 1,
};

describe('selected native source snapshots', () => {
  it('binds exact bytes and section order while retaining legacy ID-only order independence', () => {
    const one = { id: 'one', kind: 'outline-section' },
      two = { id: 'two', kind: 'outline-section' };
    const id = (sources: Parameters<typeof nativeGenerationRequestId>[0]['sources']) =>
      nativeGenerationRequestId({ ...exact, sources });
    expect(id([one, two])).toBe(id([two, one]));
    const source = nativeGenerationSourceSnapshot('v1', 'saved-source', 'original');
    expect(id([source, one, two])).not.toBe(id([source, two, one]));
    expect(id([source, one])).not.toBe(
      id([nativeGenerationSourceSnapshot('v1', 'saved-source', 'changed'), one]),
    );
    expect(nativeGenerationSourceWire(source)).toEqual(source);
  });

  it('refuses missing digest pairs, changed bytes and multibyte overflows', () => {
    const source = nativeGenerationSourceSnapshot('v1', 'saved-source', 'original');
    expect(() => nativeGenerationSourceWire({ ...source, text: 'changed' })).toThrow();
    expect(() =>
      nativeGenerationSourceWire({ id: 'v1', kind: 'saved-source', text: 'orphan' } as never),
    ).toThrow();
    expect(() => nativeGenerationSourceSnapshot('v1', 'saved-source', 'é'.repeat(24577))).toThrow();
    expect(() => nativeGenerationSourceSnapshot('v1', 'saved-source', '')).toThrow();
  });
});
