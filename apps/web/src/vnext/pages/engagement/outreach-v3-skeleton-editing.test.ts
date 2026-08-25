import { describe, expect, it } from 'vitest';
import {
  blankSkeletonSlot,
  extractSlotKeys,
  previewSkeleton,
  starterSkeletonDraft,
  suggestSlotKey,
  validateSkeletonDraft,
} from './outreach-v3-skeleton-editing.js';
import type { OutreachContentSkeleton } from './outreach-v3-template-api.js';

function skeleton(): OutreachContentSkeleton {
  return {
    subject: 'Meeting request: {{topic}}',
    body: [
      'Dear {{salutation}},',
      '',
      '{{opening}}',
      '',
      'Why this matters',
      '{{why_it_matters}}',
      '',
      'Thanks.',
    ].join('\n'),
    slots: [
      { key: 'topic', label: 'Topic', instruction: 'The topic.', required: true },
      { key: 'salutation', label: 'Salutation', instruction: 'Their name.', required: true },
      { key: 'opening', label: 'Opening', instruction: 'Who and why.', required: true },
      {
        key: 'why_it_matters',
        label: 'Why this matters',
        instruction: 'One connection.',
        required: false,
      },
    ],
  };
}

describe('extractSlotKeys', () => {
  it('finds tokens across subject and body, deduplicated, in first-seen order', () => {
    expect(extractSlotKeys('{{a}}', '{{b}} {{a}} {{c}}')).toEqual(['a', 'b', 'c']);
  });

  it('ignores single-brace campaign-variable syntax', () => {
    // {key} belongs to the template-variable resolver, a different mechanism at
    // a different time. Sharing syntax would let one silently consume the other.
    expect(extractSlotKeys('', 'Hi {client}, about {{topic}}')).toEqual(['topic']);
  });
});

describe('validateSkeletonDraft', () => {
  it('accepts a well-formed skeleton', () => {
    expect(validateSkeletonDraft(skeleton())).toEqual([]);
  });

  it('flags a token with no matching section — it would ship literal braces', () => {
    const draft = skeleton();
    draft.body += '\n{{ghost}}';
    const issues = validateSkeletonDraft(draft);
    expect(issues.some((i) => i.field === 'body' && i.slotKey === 'ghost')).toBe(true);
  });

  it('flags a section that is defined but never placed', () => {
    const draft = skeleton();
    draft.slots.push({ key: 'orphan', label: 'Orphan', instruction: 'x', required: true });
    const issue = validateSkeletonDraft(draft).find((i) => i.slotKey === 'orphan');
    expect(issue?.field).toBe('slots');
    expect(issue?.message).toContain('never placed');
  });

  it('flags an empty body', () => {
    expect(
      validateSkeletonDraft({ subject: '', body: '  ', slots: [] }).some((i) => i.field === 'body'),
    ).toBe(true);
  });

  it('flags a body with no sections — every recipient would get identical text', () => {
    const issues = validateSkeletonDraft({
      subject: 'Hi',
      body: 'A totally static email.',
      slots: [],
    });
    expect(issues.some((i) => i.message.includes('identical text'))).toBe(true);
  });

  it('flags a missing label and a missing instruction separately', () => {
    const issues = validateSkeletonDraft({
      subject: '',
      body: '{{a}}',
      slots: [{ key: 'a', label: '  ', instruction: '  ', required: true }],
    });
    expect(issues.some((i) => i.message.includes('needs a name'))).toBe(true);
    expect(issues.some((i) => i.message.includes('needs an instruction'))).toBe(true);
  });

  it('flags a duplicate section key', () => {
    const draft = skeleton();
    draft.slots.push({ key: 'topic', label: 'Dupe', instruction: 'x', required: true });
    expect(
      validateSkeletonDraft(draft).some((i) => i.message.includes('more than once')),
    ).toBe(true);
  });

  it('returns every issue at once so the editor can list them all', () => {
    const issues = validateSkeletonDraft({
      subject: '',
      body: '{{one}} {{two}}',
      slots: [{ key: 'unused', label: '', instruction: '', required: true }],
    });
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });
});

describe('previewSkeleton', () => {
  it('substitutes slot labels and keeps the author’s structure', () => {
    const { subject, body } = previewSkeleton(skeleton());
    expect(subject).toBe('Meeting request: [Topic]');
    expect(body).toContain('Dear [Salutation],');
    expect(body).toContain('Why this matters\n[Why this matters]');
    expect(body).not.toContain('{{');
  });

  it('omitOptional drops optional sections and leaves no stranded blank lines', () => {
    // This is the mode that catches layout mistakes an author never thinks to
    // check: what a thin-evidence recipient actually receives.
    const { body } = previewSkeleton(skeleton(), { omitOptional: true });
    expect(body).not.toContain('[Why this matters]');
    expect(body).toContain('Why this matters'); // the heading is skeleton text
    expect(body).not.toMatch(/\n{3,}/);
  });

  it('matches the server’s collapsing rules, so the preview is not misleading', () => {
    // A preview that lays out differently from the assembled email would be
    // worse than no preview, because layout is the thing being promised.
    const { body } = previewSkeleton(
      {
        subject: '',
        body: 'A\n\n{{gone}}\n\nB',
        slots: [{ key: 'gone', label: 'Gone', instruction: 'x', required: false }],
      },
      { omitOptional: true },
    );
    expect(body).toBe('A\n\nB');
  });
});

describe('suggestSlotKey', () => {
  it('slugifies a label', () => {
    expect(suggestSlotKey('Why this matters to your office', [])).toBe(
      'why_this_matters_to_your_office',
    );
  });

  it('avoids colliding with an existing key', () => {
    expect(suggestSlotKey('Opening', ['opening'])).toBe('opening_2');
    expect(suggestSlotKey('Opening', ['opening', 'opening_2'])).toBe('opening_3');
  });

  it('produces a valid key from an unusable label', () => {
    expect(suggestSlotKey('!!!', [])).toBe('section');
    expect(suggestSlotKey('2024 outlook', [])).toMatch(/^[a-z]/);
  });
});

describe('blankSkeletonSlot', () => {
  it('starts required, since a new section is normally wanted', () => {
    const slot = blankSkeletonSlot('Availability', []);
    expect(slot).toMatchObject({ key: 'availability', label: 'Availability', required: true });
    expect(slot.instruction).toBe('');
  });
});

describe('starterSkeletonDraft', () => {
  it('is immediately valid, so "create your own" does not open onto errors', () => {
    expect(validateSkeletonDraft(starterSkeletonDraft())).toEqual([]);
  });

  it('is a working example rather than an empty textarea', () => {
    const draft = starterSkeletonDraft();
    expect(draft.slots.length).toBeGreaterThan(2);
    expect(draft.body).toContain('{{');
  });
});
