import { describe, expect, it } from '@jest/globals';
import {
  decideMemoryDedup,
  memoryTextSimilarity,
  normalizedMemoryIdentity,
  type MemoryDedupCandidate,
} from './memory-dedup.helpers.js';

const existing = (over: Partial<MemoryDedupCandidate> = {}): MemoryDedupCandidate => ({
  id: 'item-1',
  kind: 'item',
  key: 'authorized ask',
  value: 'Seek $10 million in FY 2028 RDT&E funding.',
  memoryClass: 'client_steering',
  scope: 'client',
  clientId: 'client-a',
  ownerUserId: null,
  status: 'active',
  ...over,
});

describe('memory candidate deduplication', () => {
  it('normalizes identity without blending clients or owners', () => {
    expect(
      normalizedMemoryIdentity({
        key: ' Authorized   Ask ',
        value: 'ignored',
        memoryClass: 'client_steering',
        scope: 'client',
        clientId: 'CLIENT-A',
      }),
    ).toBe('client_steering|client|client-a||authorized ask');
    expect(
      normalizedMemoryIdentity({
        key: 'Authorized Ask',
        value: 'ignored',
        memoryClass: 'client_steering',
        scope: 'client',
        clientId: 'client-b',
      }),
    ).not.toBe('client_steering|client|client-a||authorized ask');
  });

  it('detects exact duplicate content', () => {
    expect(
      decideMemoryDedup(
        {
          ...existing(),
          value: '  seek $10 MILLION in FY 2028 RDT&E funding. ',
        },
        [existing()],
      ),
    ).toEqual({ duplicateId: 'item-1', conflictId: null, similarity: 1, reason: 'exact_identity' });
  });

  it('creates a semantic duplicate instead of updating the existing item', () => {
    // Token Jaccard similarity of these two fixture strings is 8/11 ≈ 0.727
    // (8 shared tokens, 11 in the union); the override must sit below that
    // for this case to exercise the semantic_duplicate branch at all.
    const result = decideMemoryDedup(
      {
        ...existing(),
        value: 'Seek $10 million in FY 2028 RDT&E funding for the program.',
      },
      [existing()],
      { duplicate: 0.7 },
    );
    expect(result.reason).toBe('semantic_duplicate');
    expect(result.duplicateId).toBe('item-1');
    expect(result.conflictId).toBeNull();
  });

  it('creates a conflict when an active item with the same identity materially differs', () => {
    const result = decideMemoryDedup(
      {
        ...existing(),
        value: 'Do not seek funding until FY 2030.',
      },
      [existing()],
    );
    expect(result.reason).toBe('semantic_conflict');
    expect(result.conflictId).toBe('item-1');
    expect(result.duplicateId).toBeNull();
  });

  it('never matches another client or user scope', () => {
    expect(
      decideMemoryDedup(
        { ...existing(), clientId: 'client-b' },
        [existing()],
      ).reason,
    ).toBe('none');
    expect(
      decideMemoryDedup(
        {
          ...existing(),
          memoryClass: 'user_preference',
          scope: 'user_private',
          clientId: null,
          ownerUserId: 'user-2',
        },
        [
          existing({
            memoryClass: 'user_preference',
            scope: 'user_private',
            clientId: null,
            ownerUserId: 'user-1',
          }),
        ],
      ).reason,
    ).toBe('none');
  });

  it('has deterministic bounded similarity', () => {
    expect(memoryTextSimilarity('alpha beta gamma', 'alpha beta delta')).toBeCloseTo(0.5);
    expect(memoryTextSimilarity('', '')).toBe(1);
    expect(memoryTextSimilarity('alpha', '')).toBe(0);
  });
});
