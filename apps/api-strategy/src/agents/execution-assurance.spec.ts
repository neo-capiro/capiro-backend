import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { assessGeneratedDocumentForRelease } from './execution-assurance.js';

const healthy = {
  status: 'ok' as const,
  missingRequired: [],
  omittedOptional: [],
  openMaterialConflicts: [],
};

function withEnvelope<T extends Record<string, unknown>>(
  doc: T,
  opts: { decision?: 'deliver' | 'repair' | 'hold'; held?: boolean; tamper?: boolean } = {},
): T {
  const decision = opts.decision ?? 'deliver';
  const core = {
    version: 'ga-assurance-envelope-v1',
    surface: 'strategy',
    operatingFrame: {},
    evidencePlan: {},
    claimLedger: { hash: 'ledger-hash' },
    findings: [],
    releaseDecision: decision,
    blockers: [],
    warnings: [],
    verifierVersion: 'ga-verifier-test',
    contextPacketId: null,
    policyBinding: null,
    generatedAt: '2026-07-31T20:00:00.000Z',
  };
  const envelope = {
    ...core,
    hash: createHash('sha256').update(stableStringify(core)).digest('hex'),
  };
  if (opts.tamper) envelope.releaseDecision = 'hold';
  return {
    ...doc,
    assurance: {
      held: opts.held ?? false,
      blockers: opts.held ? ['Unsupported high-risk claims: section-1.'] : [],
      decision,
      ledgerHash: 'ledger-hash',
      envelope,
    },
  } as T;
}

describe('assessGeneratedDocumentForRelease', () => {
  it('holds when generation is unavailable or has no sections', () => {
    expect(assessGeneratedDocumentForRelease(null).releaseable).toBe(false);
    expect(
      assessGeneratedDocumentForRelease(
        withEnvelope({
          title: null,
          summary: null,
          sections: [],
          model: 'model',
          groundingHealth: healthy,
        }) as never,
      ).blockers,
    ).toContain('The generation response contained no usable sections.');
  });

  it('holds degraded, conflicted, or incomplete client context', () => {
    const result = assessGeneratedDocumentForRelease(
      withEnvelope({
        title: 'Draft',
        summary: 'Summary',
        model: 'model',
        groundingHealth: {
          status: 'conflicted',
          missingRequired: ['authorized ask'],
          omittedOptional: [],
          openMaterialConflicts: [{ id: 'c1', factAId: 'a', factBId: 'b', factA: 'A', factB: 'B' }],
        },
        sections: [
          {
            heading: 'Ask',
            html: '<p>Draft</p>',
            sources: [{ section: 'Client context facts (Steward)', ref: 'fact:a' }],
          },
        ],
      }) as never,
    );
    expect(result.releaseable).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        'Context health is conflicted.',
        'Required client context is missing: authorized ask.',
        '1 material client-context conflict(s) remain unresolved.',
      ]),
    );
  });

  it('holds any section without explicit provenance', () => {
    const result = assessGeneratedDocumentForRelease(
      withEnvelope({
        title: 'Draft',
        summary: 'Summary',
        model: 'model',
        groundingHealth: healthy,
        sections: [
          { heading: 'Background', html: '<p>Grounded.</p>', sources: [] },
          {
            heading: 'Ask',
            html: '<p>Grounded.</p>',
            sources: [{ section: 'Client Context Pack' }],
          },
        ],
      }) as never,
    );
    expect(result.releaseable).toBe(false);
    expect(result.blockers).toContain('Section "Background" has no provenance.');
  });

  it('releases a healthy, model-identified, source-mapped document with an intact envelope', () => {
    const result = assessGeneratedDocumentForRelease(
      withEnvelope({
        title: 'Draft',
        summary: 'Summary',
        model: 'claude-test',
        groundingHealth: healthy,
        sections: [
          {
            heading: 'Background',
            html: '<p>Grounded.</p>',
            sources: [{ section: 'Client context facts (Steward)', ref: 'fact:f1' }],
          },
          {
            heading: 'Recommendation',
            html: '<p>Grounded.</p>',
            sources: [{ section: 'Client Context Pack', ref: 'Strategy brief' }],
          },
        ],
      }) as never,
    );
    expect(result.releaseable).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.groundedFactRefs).toEqual(['fact:f1']);
    expect(result.envelopeHash).toHaveLength(64);
  });

  const structurallyPerfect = {
    title: 'Draft',
    summary: 'Summary',
    model: 'claude-test',
    groundingHealth: healthy,
    sections: [
      {
        heading: 'Background',
        html: '<p>PE 0604270F received $412.5M in FY27.</p>',
        sources: [{ section: 'Client Context Pack' }],
      },
    ],
  };

  it('refuses a missing envelope even when the shape is otherwise perfect', () => {
    const result = assessGeneratedDocumentForRelease(structurallyPerfect);
    expect(result.releaseable).toBe(false);
    expect(result.blockers).toContain('Assurance envelope: missing.');
  });

  it('holds when the server-owned envelope blocks the claims', () => {
    const result = assessGeneratedDocumentForRelease(
      withEnvelope(structurallyPerfect, { decision: 'hold', held: true }) as never,
    );
    expect(result.releaseable).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        'Claim verification: Unsupported high-risk claims: section-1.',
        'Assurance envelope release decision is hold.',
      ]),
    );
  });

  it('detects a forged verified outcome by recomputing the envelope hash', () => {
    const result = assessGeneratedDocumentForRelease(
      withEnvelope(structurallyPerfect, { decision: 'deliver', tamper: true }) as never,
    );
    expect(result.releaseable).toBe(false);
    expect(result.blockers).toContain('Assurance envelope: hash mismatch.');
  });
});

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}
