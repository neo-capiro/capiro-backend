import { BadRequestException } from '@nestjs/common';
import { describe, expect, test } from '@jest/globals';
import {
  canonicalTemporalClientRefKeys,
  normalizeTemporalGraphHistoryInput,
  normalizeTemporalGraphWalkInput,
} from './temporal-knowledge-graph.helpers.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ENTITY_ID = '22222222-2222-4222-8222-222222222222';

const partition = {
  sensitivity: 'normal',
  accessScope: { kind: 'tenant' },
  clientRefs: [
    { type: 'client', id: 'b' },
    { type: 'client', id: 'a' },
    { type: 'client', id: 'b', label: 'duplicate display-only label' },
  ],
} as const;

describe('Temporal Knowledge Graph query normalization', () => {
  test('client refs are an order/duplicate-independent canonical set', () => {
    expect(canonicalTemporalClientRefKeys(partition.clientRefs)).toEqual([
      'client:a',
      'client:b',
    ]);
  });

  test('walk defaults are bounded and security partition remains exact', () => {
    const normalized = normalizeTemporalGraphWalkInput({
      tenantId: TENANT_ID,
      canonicalEntityId: ENTITY_ID,
      partition,
      asOf: new Date('2026-08-16T12:00:00Z'),
    });
    expect(normalized).toMatchObject({
      tenantId: TENANT_ID,
      canonicalEntityId: ENTITY_ID,
      sensitivity: 'normal',
      accessScope: { kind: 'tenant' },
      clientRefKeys: ['client:a', 'client:b'],
      maxDepth: 2,
      fanout: 25,
      rowBudget: 500,
      direction: 'both',
      edgeTypes: null,
    });
  });

  test('edge types are normalized, sorted, and deduplicated', () => {
    const normalized = normalizeTemporalGraphWalkInput({
      tenantId: TENANT_ID,
      canonicalEntityId: ENTITY_ID,
      partition,
      asOf: new Date(),
      edgeTypes: ['met', 'funded_by', 'met'],
    });
    expect(normalized.edgeTypes).toEqual(['funded_by', 'met']);
  });

  test('empty access scope fails closed', () => {
    expect(() =>
      normalizeTemporalGraphWalkInput({
        tenantId: TENANT_ID,
        canonicalEntityId: ENTITY_ID,
        partition: { ...partition, accessScope: {} },
        asOf: new Date(),
      }),
    ).toThrow(BadRequestException);
  });

  test('invalid tenant or canonical identity fails before SQL', () => {
    expect(() =>
      normalizeTemporalGraphWalkInput({
        tenantId: 'not-a-uuid',
        canonicalEntityId: ENTITY_ID,
        partition,
        asOf: new Date(),
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      normalizeTemporalGraphWalkInput({
        tenantId: TENANT_ID,
        canonicalEntityId: 'not-a-uuid',
        partition,
        asOf: new Date(),
      }),
    ).toThrow(BadRequestException);
  });

  test('walk resource ceilings cannot be widened by callers', () => {
    for (const partial of [
      { maxDepth: 6 },
      { fanout: 101 },
      { rowBudget: 5001 },
      { maxDepth: 0 },
    ]) {
      expect(() =>
        normalizeTemporalGraphWalkInput({
          tenantId: TENANT_ID,
          canonicalEntityId: ENTITY_ID,
          partition,
          asOf: new Date(),
          ...partial,
        }),
      ).toThrow(BadRequestException);
    }
  });

  test('history requires an ordered validity window', () => {
    expect(() =>
      normalizeTemporalGraphHistoryInput({
        tenantId: TENANT_ID,
        canonicalEntityId: ENTITY_ID,
        partition,
        windowStart: new Date('2026-08-17T00:00:00Z'),
        windowEnd: new Date('2026-08-16T00:00:00Z'),
        observedThrough: new Date('2026-08-17T00:00:00Z'),
      }),
    ).toThrow(BadRequestException);
  });

  test('history retains an explicit transaction-time cutoff', () => {
    const observedThrough = new Date('2026-08-16T00:00:00Z');
    const normalized = normalizeTemporalGraphHistoryInput({
      tenantId: TENANT_ID,
      canonicalEntityId: ENTITY_ID,
      partition,
      windowStart: new Date('2026-01-01T00:00:00Z'),
      windowEnd: new Date('2027-01-01T00:00:00Z'),
      observedThrough,
      direction: 'out',
      rowBudget: 100,
    });
    expect(normalized.observedThrough).toEqual(observedThrough);
    expect(normalized.direction).toBe('out');
    expect(normalized.rowBudget).toBe(100);
  });
});
