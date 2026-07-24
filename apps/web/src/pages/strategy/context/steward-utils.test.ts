/*
 * Stage E Steward normalizers — pure-logic coverage matching the Stage D
 * context-utils idiom. The review page renders exclusively from these shapes,
 * so envelope/field tolerance is verified here rather than via a jsdom render.
 */
import { describe, expect, it } from 'vitest';
import {
  clip,
  normalizeConflicts,
  normalizeContextHealth,
  normalizeExtractResult,
  normalizeFacts,
} from './context-utils.js';

describe('normalizeFacts', () => {
  const fact = {
    id: 'f1',
    documentId: 'd1',
    clientId: 'c1',
    fact: 'The client-approved ask is $25,000,000.',
    sourceRef: 'row:Primary ask:1',
    authority: 'client_approved',
    asOf: '2026-06-01',
    confidence: 0.92,
    state: 'active',
    citation: '| ASK-001 | … | $25,000,000 | …',
    documentTitle: 'Ask and options',
    templateKey: '03_ask_and_options',
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
  };

  it('accepts a bare array and a { facts: […] } envelope', () => {
    expect(normalizeFacts([fact])).toHaveLength(1);
    expect(normalizeFacts({ facts: [fact] })).toHaveLength(1);
    expect(normalizeFacts({ items: [fact] })).toHaveLength(1);
    expect(normalizeFacts(null)).toEqual([]);
  });

  it('lifts document title/templateKey from a nested document when not denormalized', () => {
    const nested = {
      ...fact,
      documentTitle: undefined,
      templateKey: undefined,
      document: { id: 'd1', title: 'Nested title', templateKey: '03_ask_and_options' },
    };
    const [out] = normalizeFacts([nested]);
    expect(out!.documentTitle).toBe('Nested title');
    expect(out!.templateKey).toBe('03_ask_and_options');
  });

  it('defaults an unknown state to active and drops rows without id/fact', () => {
    const [out] = normalizeFacts([{ ...fact, state: 'bogus' }]);
    expect(out!.state).toBe('active');
    expect(normalizeFacts([{ id: 'x' }, { fact: 'y' }, 42])).toEqual([]);
  });
});

describe('normalizeConflicts', () => {
  it('keeps embedded factA/factB objects with their meta', () => {
    const [out] = normalizeConflicts({
      conflicts: [
        {
          id: 'k1',
          factAId: 'f1',
          factBId: 'f2',
          material: true,
          state: 'open',
          resolutionNote: null,
          factA: { id: 'f1', fact: 'Ask $25M', authority: 'client_approved', asOf: '2026-06-01', documentTitle: 'Brief', clientId: 'c1' },
          factB: { id: 'f2', fact: 'Ask $40M', authority: 'client_approved', asOf: '2026-07-10', documentTitle: 'Ask doc', clientId: 'c1' },
          createdAt: '2026-07-24T00:00:00.000Z',
        },
      ],
    });
    expect(out!.material).toBe(true);
    expect(out!.factA?.fact).toBe('Ask $25M');
    expect(out!.factB?.documentTitle).toBe('Ask doc');
    expect(out!.clientId).toBe('c1'); // derived from the embedded facts
  });

  it('tolerates the LEGACY server shape: bare-string factA/factB + top-level clientId', () => {
    // steward.service listConflicts now embeds full fact objects; the bare
    // string fallback stays for older payloads (metadata renders as unknown).
    const [out] = normalizeConflicts([
      {
        id: 'k2',
        factAId: 'f1',
        factBId: 'f2',
        clientId: 'c9',
        material: false,
        state: 'open',
        factA: 'A text',
        factB: 'B text',
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    ]);
    expect(out!.factA?.fact).toBe('A text');
    expect(out!.factB?.fact).toBe('B text');
    expect(out!.clientId).toBe('c9');
  });

  it('tolerates …Text echoes; unknown state → open', () => {
    const [out] = normalizeConflicts([
      { id: 'k3', factAId: 'f1', factBId: 'f2', factAText: 'A text', factBText: 'B text', state: 'weird' },
    ]);
    expect(out!.factA?.fact).toBe('A text');
    expect(out!.factB?.fact).toBe('B text');
    expect(out!.state).toBe('open');
    expect(out!.clientId).toBeNull();
  });
});

describe('normalizeContextHealth', () => {
  it('passes through status/missingRequired/stale count/open material conflicts', () => {
    const h = normalizeContextHealth({
      status: 'conflicted',
      missingRequired: ['02_client_constraints', 7],
      staleDocuments: 3,
      openMaterialConflicts: [
        { id: 'k1', factAId: 'f1', factBId: 'f2', factA: 'Ask $25M', factB: 'Ask $40M' },
        { id: 'bad' }, // no fact texts → dropped
      ],
    });
    expect(h.status).toBe('conflicted');
    expect(h.missingRequired).toEqual(['02_client_constraints']);
    expect(h.staleDocuments).toBe(3);
    expect(h.openMaterialConflicts).toHaveLength(1);
    expect(h.openMaterialConflicts[0]!.factB).toBe('Ask $40M');
  });

  it('counts the SERVER shape: staleDocs as an ARRAY of stale documents', () => {
    // steward.service health returns staleDocs: [{id,title,templateKey,validUntil}].
    const h = normalizeContextHealth({
      status: 'degraded',
      missingRequired: ['strategy_brief'],
      staleDocs: [{ id: 'd1' }, { id: 'd2' }],
      openMaterialConflicts: [],
    });
    expect(h.status).toBe('degraded');
    expect(h.staleDocuments).toBe(2);
  });

  it('degrades unknown shapes to a healthy default', () => {
    expect(normalizeContextHealth(null)).toEqual({
      status: 'ok',
      missingRequired: [],
      staleDocuments: 0,
      openMaterialConflicts: [],
    });
  });
});

describe('normalizeExtractResult', () => {
  it('reads the server counts (droppedRefs is a NUMBER) and tolerates array echoes', () => {
    expect(
      normalizeExtractResult({ inserted: 4, droppedRefs: 2, conflicts: 1, summary: 'ok' }),
    ).toEqual({ inserted: 4, droppedRefs: 2, conflicts: 1, summary: 'ok' });
    expect(normalizeExtractResult({ facts: [{}, {}], droppedRefs: ['row:X:9'], conflicts: [{}] })).toEqual({
      inserted: 2,
      droppedRefs: 1,
      conflicts: 1,
      summary: null,
    });
    // The server returns summary: '' when the model gave none — degrade to null.
    expect(normalizeExtractResult({ inserted: 0, droppedRefs: 0, conflicts: 0, summary: '' }).summary).toBeNull();
  });
});

describe('clip (banner truncation)', () => {
  it('returns short strings unchanged and hard-caps long ones at the limit', () => {
    expect(clip('short fact')).toBe('short fact');
    const long = 'x'.repeat(300);
    expect(clip(long).length).toBe(120);
    expect(clip(long).endsWith('…')).toBe(true);
  });
});
