import { describe, expect, it } from '@jest/globals';
import { assessGeneratedDocumentForRelease } from './execution-assurance.js';

const healthy = {
  status: 'ok' as const,
  missingRequired: [],
  openMaterialConflicts: [],
};

describe('assessGeneratedDocumentForRelease', () => {
  it('holds when generation is unavailable or has no sections', () => {
    expect(assessGeneratedDocumentForRelease(null).releaseable).toBe(false);
    expect(
      assessGeneratedDocumentForRelease({
        title: null,
        summary: null,
        sections: [],
        model: 'model',
        groundingHealth: healthy,
      }).blockers,
    ).toContain('The generation response contained no usable sections.');
  });

  it('holds degraded, conflicted, or incomplete client context', () => {
    const result = assessGeneratedDocumentForRelease({
      title: 'Draft',
      summary: 'Summary',
      model: 'model',
      groundingHealth: {
        status: 'conflicted',
        missingRequired: ['authorized ask'],
        openMaterialConflicts: [
          { id: 'c1', factAId: 'a', factBId: 'b', factA: 'A', factB: 'B' },
        ],
      },
      sections: [
        {
          heading: 'Ask',
          html: '<p>Draft</p>',
          sources: [{ section: 'Client context facts (Steward)', ref: 'fact:a' }],
        },
      ],
    });
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
    const result = assessGeneratedDocumentForRelease({
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
    });
    expect(result.releaseable).toBe(false);
    expect(result.blockers).toContain('Section "Background" has no provenance.');
  });

  it('releases a healthy, model-identified, source-mapped document', () => {
    const result = assessGeneratedDocumentForRelease({
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
    });
    expect(result).toEqual({
      releaseable: true,
      blockers: [],
      groundedFactRefs: ['fact:f1'],
    });
  });
});
