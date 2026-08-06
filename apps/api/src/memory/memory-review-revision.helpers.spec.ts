import { describe, expect, it } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { prepareMemoryReviewRevision } from './memory-review-revision.helpers.js';

const payload = {
  key: 'settings-file:firm-soul:firm',
  value: '[{"key":"mission","body":"Original"}]',
  source: 'settings_memory_editor',
  scope: 'firm',
  ownerUserId: null,
  clientId: null,
  canonicalItem: {
    type: 'firm-soul',
    slug: 'firm',
    title: 'Firm Soul',
    sections: [
      { key: 'mission', heading: 'Mission', owner: 'human', body: 'Original' },
      { key: 'voice', heading: 'Voice', owner: 'human', body: 'Measured' },
    ],
  },
  versionProposal: {
    kind: 'correction',
    sourceItemId: '11111111-1111-4111-8111-111111111111',
    targetItemId: null,
  },
};

const revisedSections = [
  { key: 'mission', heading: 'Mission', owner: 'human' as const, body: ' Revised mission. ' },
  { key: 'voice', heading: 'Voice', owner: 'human' as const, body: 'Measured' },
];

describe('prepareMemoryReviewRevision', () => {
  it('replaces only section bodies and preserves canonical/version identity', () => {
    const result = prepareMemoryReviewRevision('settings_sections', payload, {
      sections: revisedSections,
    });

    expect(result.revisionSummary).toEqual({ valueChanged: true, sectionBodiesChanged: 1 });
    expect(result.payload).toMatchObject({
      key: payload.key,
      scope: 'firm',
      clientId: null,
      versionProposal: payload.versionProposal,
      canonicalItem: {
        type: 'firm-soul',
        slug: 'firm',
        title: 'Firm Soul',
        sections: [
          { key: 'mission', heading: 'Mission', owner: 'human', body: 'Revised mission.' },
          { key: 'voice', heading: 'Voice', owner: 'human', body: 'Measured' },
        ],
      },
    });
    expect(JSON.parse(String(result.payload.value))).toEqual([
      { key: 'mission', heading: 'Mission', owner: 'human', body: 'Revised mission.' },
      { key: 'voice', heading: 'Voice', owner: 'human', body: 'Measured' },
    ]);
  });

  it('derives correction text from revised sections without accepting browser value drift', () => {
    const result = prepareMemoryReviewRevision(
      'memory_correction',
      {
        ...payload,
        value: 'Original\n\nMeasured',
        source: 'memory_correction',
      },
      { sections: revisedSections },
    );
    expect(result.payload.value).toBe('Revised mission.\n\nMeasured');
  });

  it('rejects section identity, ordering, and ownership changes', () => {
    for (const sections of [
      [
        { key: 'voice', heading: 'Voice', owner: 'human', body: 'Measured' },
        { key: 'mission', heading: 'Mission', owner: 'human', body: 'Revised' },
      ],
      [
        { key: 'mission', heading: 'Different', owner: 'human', body: 'Revised' },
        { key: 'voice', heading: 'Voice', owner: 'human', body: 'Measured' },
      ],
      [
        { key: 'mission', heading: 'Mission', owner: 'engine', body: 'Revised' },
        { key: 'voice', heading: 'Voice', owner: 'human', body: 'Measured' },
      ],
    ]) {
      expect(() => prepareMemoryReviewRevision('settings_sections', payload, { sections })).toThrow(
        BadRequestException,
      );
    }
  });

  it('rejects incomplete, empty, oversized, and identical revisions', () => {
    expect(() => prepareMemoryReviewRevision('settings_sections', payload, {})).toThrow(
      'A revised value or revised sections are required.',
    );
    expect(() =>
      prepareMemoryReviewRevision('settings_sections', payload, {
        sections: [
          { key: 'mission', heading: 'Mission', owner: 'human', body: 'Original' },
        ],
      }),
    ).toThrow('preserve the complete section structure');
    expect(() =>
      prepareMemoryReviewRevision('settings_sections', payload, {
        sections: [
          { key: 'mission', heading: 'Mission', owner: 'human', body: 'x'.repeat(50_001) },
          { key: 'voice', heading: 'Voice', owner: 'human', body: 'Measured' },
        ],
      }),
    ).toThrow('too large');
    expect(() =>
      prepareMemoryReviewRevision('settings_sections', payload, {
        sections: payload.canonicalItem.sections,
      }),
    ).toThrow('identical');
  });

  it('rejects a second browser-controlled value channel for canonical memory', () => {
    expect(() =>
      prepareMemoryReviewRevision('settings_sections', payload, {
        value: 'Conflicting browser value',
        sections: revisedSections,
      }),
    ).toThrow('accept only the complete section set');
    expect(() =>
      prepareMemoryReviewRevision('settings_sections', payload, { value: 'New' }),
    ).toThrow('accept only the complete section set');
  });

  it('supports value-only revision only for non-canonical candidates', () => {
    const nonCanonical = { key: 'fact', value: 'Old', source: 'conversation', scope: 'firm' };
    expect(
      prepareMemoryReviewRevision('explicit_user', nonCanonical, { value: ' New fact. ' }).payload,
    ).toMatchObject({ value: 'New fact.' });
    expect(() =>
      prepareMemoryReviewRevision('explicit_user', nonCanonical, {
        sections: revisedSections,
      }),
    ).toThrow('does not support section-based revision');
  });
});
