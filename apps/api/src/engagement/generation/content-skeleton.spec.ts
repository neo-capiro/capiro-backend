import { describe, expect, it } from '@jest/globals';
import {
  assembleSkeletonBody,
  extractSkeletonSlotKeys,
  parseSkeletonDraft,
  renderSkeletonInstruction,
  SKELETON_SECTIONS_EXEMPLAR,
  skeletonDraftJsonSchema,
  validateContentSkeleton,
  type ContentSkeleton,
} from './content-skeleton.js';

/** The real meeting-request skeleton this feature was built for. */
function meetingRequestSkeleton(): ContentSkeleton {
  return {
    subject: 'Meeting request: {{topic_line}} briefing',
    body: [
      'Dear {{salutation}},',
      '',
      '{{opening}}',
      '',
      'Why this matters to your office',
      '{{why_it_matters}}',
      '',
      'What we’d cover',
      '{{what_wed_cover}}',
      '',
      'Availability',
      '{{availability}}',
      '',
      'Thank you for considering this request.',
    ].join('\n'),
    slots: [
      { key: 'topic_line', label: 'Topic', instruction: 'The campaign topic.', required: true },
      { key: 'salutation', label: 'Salutation', instruction: 'Recipient name.', required: true },
      { key: 'opening', label: 'Opening', instruction: 'Who is writing and why.', required: true },
      {
        key: 'why_it_matters',
        label: 'Why this matters',
        instruction: 'One concrete supported connection.',
        required: true,
      },
      {
        key: 'what_wed_cover',
        label: 'What we’d cover',
        instruction: 'The agenda in one or two sentences.',
        required: true,
      },
      {
        key: 'availability',
        label: 'Availability',
        instruction: 'Proposed windows.',
        required: false,
      },
    ],
  };
}

describe('extractSkeletonSlotKeys', () => {
  it('finds tokens across subject and body in first-seen order', () => {
    expect(extractSkeletonSlotKeys(meetingRequestSkeleton())).toEqual([
      'topic_line',
      'salutation',
      'opening',
      'why_it_matters',
      'what_wed_cover',
      'availability',
    ]);
  });

  it('deduplicates a token used more than once', () => {
    expect(
      extractSkeletonSlotKeys({ subject: '{{a}}', body: '{{a}} and again {{a}} plus {{b}}' }),
    ).toEqual(['a', 'b']);
  });

  it('ignores single-brace campaign-variable syntax', () => {
    // {key} belongs to substituteOutreachTemplateVariables, a different resolver
    // at a different time. Colliding on it would let one silently eat the other.
    expect(extractSkeletonSlotKeys({ subject: '', body: 'Hello {client}, re {{topic}}' })).toEqual([
      'topic',
    ]);
  });
});

describe('validateContentSkeleton', () => {
  it('accepts the real meeting-request skeleton', () => {
    expect(validateContentSkeleton(meetingRequestSkeleton())).toEqual([]);
  });

  it('rejects a token with no declared slot — it would ship literal {{braces}} to a recipient', () => {
    const skeleton = meetingRequestSkeleton();
    skeleton.body += '\n{{ghost_section}}';
    const codes = validateContentSkeleton(skeleton).map((i) => i.code);
    expect(codes).toContain('SKELETON_SLOT_UNDECLARED');
  });

  it('rejects a declared slot never placed in the template', () => {
    const skeleton = meetingRequestSkeleton();
    skeleton.slots.push({
      key: 'orphan',
      label: 'Orphan',
      instruction: 'Never rendered.',
      required: true,
    });
    const issue = validateContentSkeleton(skeleton).find(
      (i) => i.code === 'SKELETON_SLOT_UNUSED',
    );
    expect(issue?.subject).toBe('orphan');
  });

  it('rejects an empty body', () => {
    const codes = validateContentSkeleton({ subject: 'x', body: '   ', slots: [] }).map(
      (i) => i.code,
    );
    expect(codes).toContain('SKELETON_BODY_EMPTY');
  });

  it('rejects a body with no sections at all — every recipient would get identical text', () => {
    const codes = validateContentSkeleton({
      subject: 'Hello',
      body: 'A completely static email with no personalization.',
      slots: [],
    }).map((i) => i.code);
    expect(codes).toContain('SKELETON_NO_SLOTS');
  });

  it('rejects a duplicate slot key', () => {
    const skeleton = meetingRequestSkeleton();
    skeleton.slots.push({
      key: 'opening',
      label: 'Dupe',
      instruction: 'Second declaration.',
      required: true,
    });
    const codes = validateContentSkeleton(skeleton).map((i) => i.code);
    expect(codes).toContain('SKELETON_SLOT_DUPLICATE');
  });

  it('rejects an invalid key shape', () => {
    const codes = validateContentSkeleton({
      subject: '',
      body: 'text {{Bad-Key}}',
      slots: [{ key: 'Bad-Key', label: 'x', instruction: 'y', required: true }],
    }).map((i) => i.code);
    expect(codes).toContain('SKELETON_SLOT_KEY_INVALID');
  });

  it('requires a label and an instruction on every slot', () => {
    const codes = validateContentSkeleton({
      subject: '',
      body: '{{a}}',
      slots: [{ key: 'a', label: '  ', instruction: '  ', required: true }],
    }).map((i) => i.code);
    expect(codes).toContain('SKELETON_SLOT_LABEL_EMPTY');
    expect(codes).toContain('SKELETON_SLOT_INSTRUCTION_EMPTY');
  });

  it('reports every problem at once rather than stopping at the first', () => {
    // This backs an editor; five round-trips to fix five problems is a worse UX.
    const issues = validateContentSkeleton({
      subject: '',
      body: '{{undeclared_one}} {{undeclared_two}}',
      slots: [{ key: 'unused', label: '', instruction: '', required: true }],
    });
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });
});

describe('assembleSkeletonBody', () => {
  const fullValues = {
    topic_line: 'shipbuilding industrial base',
    salutation: 'Ms. Reyes',
    opening: 'I am writing on behalf of Career Start to request a short meeting.',
    why_it_matters: 'Your office leads on the submarine industrial base.',
    what_wed_cover: 'A focused 15-minute conversation on workforce capacity.',
    availability: 'Mornings the week of September 15 work well on our end.',
  };

  it('preserves the author’s headings, wording and order byte-exactly', () => {
    const { subject, body } = assembleSkeletonBody(meetingRequestSkeleton(), fullValues);
    expect(subject).toBe('Meeting request: shipbuilding industrial base briefing');
    expect(body).toBe(
      [
        'Dear Ms. Reyes,',
        '',
        'I am writing on behalf of Career Start to request a short meeting.',
        '',
        'Why this matters to your office',
        'Your office leads on the submarine industrial base.',
        '',
        'What we’d cover',
        'A focused 15-minute conversation on workforce capacity.',
        '',
        'Availability',
        'Mornings the week of September 15 work well on our end.',
        '',
        'Thank you for considering this request.',
      ].join('\n'),
    );
  });

  it('is the whole point: section ORDER cannot drift, unlike a prompt instruction', () => {
    const { body } = assembleSkeletonBody(meetingRequestSkeleton(), fullValues);
    const why = body.indexOf('Why this matters');
    const cover = body.indexOf('What we’d cover');
    const avail = body.indexOf('Availability');
    expect(why).toBeGreaterThan(-1);
    expect(why).toBeLessThan(cover);
    expect(cover).toBeLessThan(avail);
  });

  it('drops an empty OPTIONAL section instead of leaving a hole', () => {
    const { body, omittedSlots, missingRequiredSlots } = assembleSkeletonBody(
      meetingRequestSkeleton(),
      { ...fullValues, availability: '' },
    );
    expect(omittedSlots).toEqual(['availability']);
    expect(missingRequiredSlots).toEqual([]);
    expect(body).not.toMatch(/\n{3,}/);
    // The heading is still there (it is skeleton text, not slot content) but no
    // stranded blank line follows it.
    expect(body).toContain('Availability\n\nThank you for considering');
  });

  it('reports a missing REQUIRED section rather than shipping a gap', () => {
    const { missingRequiredSlots } = assembleSkeletonBody(meetingRequestSkeleton(), {
      ...fullValues,
      why_it_matters: '   ',
    });
    expect(missingRequiredSlots).toEqual(['why_it_matters']);
  });

  it('trims model-supplied leading newlines that would double a paragraph break', () => {
    const { body } = assembleSkeletonBody(meetingRequestSkeleton(), {
      ...fullValues,
      opening: '\n\n  I am writing on behalf of Career Start.  \n',
    });
    expect(body).toContain('\n\nI am writing on behalf of Career Start.\n\n');
    expect(body).not.toMatch(/\n{3,}/);
  });

  it('treats a slot the model omitted entirely the same as an empty one', () => {
    const values = { ...fullValues } as Record<string, string>;
    delete values.availability;
    const { omittedSlots } = assembleSkeletonBody(meetingRequestSkeleton(), values);
    expect(omittedSlots).toEqual(['availability']);
  });

  it('substitutes a repeated token everywhere it appears', () => {
    const skeleton: ContentSkeleton = {
      subject: 'Re: {{topic}}',
      body: 'About {{topic}}. Again: {{topic}}.',
      slots: [{ key: 'topic', label: 'Topic', instruction: 'x', required: true }],
    };
    const { subject, body } = assembleSkeletonBody(skeleton, { topic: 'NDAA' });
    expect(subject).toBe('Re: NDAA');
    expect(body).toBe('About NDAA. Again: NDAA.');
  });

  it('never leaves a literal token in the output even when the value is missing', () => {
    const skeleton: ContentSkeleton = {
      subject: '{{a}}',
      body: 'Start {{a}} end',
      slots: [{ key: 'a', label: 'A', instruction: 'x', required: false }],
    };
    const { subject, body } = assembleSkeletonBody(skeleton, {});
    expect(subject).toBe('');
    expect(body).toBe('Start  end');
    expect(body).not.toContain('{{');
  });
});

describe('parseSkeletonDraft', () => {
  it('maps a sections array to a slot record', () => {
    const parsed = parseSkeletonDraft(
      JSON.stringify({
        sections: [
          { key: 'opening', text: 'Hello.' },
          { key: 'why_it_matters', text: 'Because.' },
        ],
        contextNote: 'note',
      }),
    );
    expect(parsed).toEqual({
      sections: { opening: 'Hello.', why_it_matters: 'Because.' },
      contextNote: 'note',
    });
  });

  it('discards an invented section rather than failing the generation', () => {
    // Losing a whole draft over a harmless extra key would trade a cosmetic
    // problem for a real one; unknown keys can never reach the recipient.
    const parsed = parseSkeletonDraft(
      JSON.stringify({ sections: [{ key: 'made_up', text: 'x' }], contextNote: '' }),
    );
    expect(parsed?.sections).toEqual({ made_up: 'x' });
    const assembled = assembleSkeletonBody(meetingRequestSkeleton(), parsed!.sections);
    expect(assembled.body).not.toContain('made_up');
  });

  it('returns null on non-JSON', () => {
    expect(parseSkeletonDraft('not json at all')).toBeNull();
  });

  it('returns null when sections is missing or not an array', () => {
    expect(parseSkeletonDraft(JSON.stringify({ contextNote: 'x' }))).toBeNull();
    expect(parseSkeletonDraft(JSON.stringify({ sections: 'nope' }))).toBeNull();
  });

  it('skips malformed rows without discarding the good ones', () => {
    const parsed = parseSkeletonDraft(
      JSON.stringify({
        sections: [{ key: 'ok', text: 'good' }, { key: 5, text: 'bad' }, null, { key: 'x' }],
        contextNote: '',
      }),
    );
    expect(parsed?.sections).toEqual({ ok: 'good' });
  });

  it('defaults a missing contextNote to empty rather than failing', () => {
    expect(parseSkeletonDraft(JSON.stringify({ sections: [] }))?.contextNote).toBe('');
  });
});

describe('skeletonDraftJsonSchema', () => {
  it('is exhaustively strict, which is what makes provider structured output enforce it', () => {
    const schema = skeletonDraftJsonSchema() as Record<string, any>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['sections', 'contextNote']);
    expect(schema.properties.sections.items.additionalProperties).toBe(false);
    expect(schema.properties.sections.items.required).toEqual(['key', 'text']);
  });
});

describe('SKELETON_SECTIONS_EXEMPLAR', () => {
  /**
   * The exemplar's whole job is to demonstrate the rules the prose already
   * states. These tests pin the specific demonstrations, because an exemplar
   * that quietly loses one of them still looks fine in review while teaching
   * the wrong shape.
   */
  it('demonstrates the sections array shape the schema requires', () => {
    expect(SKELETON_SECTIONS_EXEMPLAR).toContain('"sections"');
    expect(SKELETON_SECTIONS_EXEMPLAR).toContain('"key"');
    expect(SKELETON_SECTIONS_EXEMPLAR).toContain('"text"');
  });

  it('shows an empty string for an unsupported optional slot', () => {
    // The single most important demonstration: returning "" is CORRECT, not a
    // failure to try harder. Told only in prose, models pad the section.
    expect(SKELETON_SECTIONS_EXEMPLAR).toContain('"why_it_matters","text":""');
    expect(SKELETON_SECTIONS_EXEMPLAR).toMatch(/EMPTY STRING/);
  });

  it('shows a heading present in the template but absent from the section prose', () => {
    // The exemplar template contains "Why this matters"; no section VALUE may
    // repeat it, because that duplication is the failure this teaches against.
    // Assert on the extracted "text" values specifically — the prose notes below
    // the JSON legitimately mention the heading while explaining not to repeat
    // it, so slicing by position would fail for the wrong reason.
    expect(SKELETON_SECTIONS_EXEMPLAR).toContain('Why this matters');
    const sectionValues = [...SKELETON_SECTIONS_EXEMPLAR.matchAll(/"text":"([^"]*)"/g)].map(
      (m) => m[1]!,
    );
    expect(sectionValues.length).toBeGreaterThan(2);
    for (const value of sectionValues) {
      expect(value).not.toContain('Why this matters');
      expect(value).not.toContain('Dear ');
      expect(value).not.toContain('Thank you for your time');
    }
  });

  it('shows a salutation with no greeting word, since the template supplies it', () => {
    expect(SKELETON_SECTIONS_EXEMPLAR).toContain('"salutation","text":"Ms. Example"');
  });

  it('tells the model to ignore the example topic, so it cannot bleed into the draft', () => {
    expect(SKELETON_SECTIONS_EXEMPLAR).toMatch(/Ignore its topic entirely/);
    expect(SKELETON_SECTIONS_EXEMPLAR).toMatch(/SHAPE of the response, not the content/);
  });

  it('contains NO specimen facts — an example fact becomes an asserted fact', () => {
    // Same discipline the starter templates get. Anything concrete here is
    // something a draft will eventually state as true.
    expect(SKELETON_SECTIONS_EXEMPLAR).not.toMatch(/\$[\d,]/);
    expect(SKELETON_SECTIONS_EXEMPLAR).not.toMatch(/\bFY20\d\d\b/);
    expect(SKELETON_SECTIONS_EXEMPLAR).not.toMatch(/\b(?:H\.R\.|S\.)\s?\d+/);
    expect(SKELETON_SECTIONS_EXEMPLAR).not.toMatch(/\b\d{1,2}:\d{2}\s?(?:ET|am|pm)/i);
    expect(SKELETON_SECTIONS_EXEMPLAR).not.toMatch(/\b(?:Senator|Representative|Congressman)\b/);
    // No real agencies or committees.
    expect(SKELETON_SECTIONS_EXEMPLAR).not.toMatch(
      /\b(?:Department of|Pentagon|DoD|NASA|Appropriations Committee|Armed Services)\b/,
    );
  });

  it('is a throwaway template, not one of the shipped ones', () => {
    // If it drifted into being a real template, an author editing that template
    // would silently change what every OTHER campaign's model sees as correct.
    expect(SKELETON_SECTIONS_EXEMPLAR).toContain('{{topic}}');
    expect(SKELETON_SECTIONS_EXEMPLAR).not.toContain('Why this matters to your office');
    expect(SKELETON_SECTIONS_EXEMPLAR).not.toContain('What we’d cover');
  });

  it('stays small enough to be worth its place in the cached prefix', () => {
    expect(SKELETON_SECTIONS_EXEMPLAR.length).toBeLessThan(2_000);
  });
});

describe('renderSkeletonInstruction', () => {
  it('tells the model not to reproduce the template, which would duplicate every heading', () => {
    const rendered = renderSkeletonInstruction(meetingRequestSkeleton());
    expect(rendered).toContain('You are NOT writing a whole email');
    expect(rendered).toMatch(/do NOT reproduce/i);
  });

  it('labels optional sections as safely omittable so the model does not invent filler', () => {
    const rendered = renderSkeletonInstruction(meetingRequestSkeleton());
    expect(rendered).toMatch(/key="availability".*OPTIONAL/);
    expect(rendered).toMatch(/key="why_it_matters".*REQUIRED/);
  });

  it('carries every slot instruction through to the model', () => {
    const rendered = renderSkeletonInstruction(meetingRequestSkeleton());
    for (const slot of meetingRequestSkeleton().slots) {
      expect(rendered).toContain(slot.instruction);
    }
  });

  it('shows the skeleton so slot prose reads naturally against surrounding words', () => {
    const rendered = renderSkeletonInstruction(meetingRequestSkeleton());
    expect(rendered).toContain('Why this matters to your office');
  });

  it('keeps the plan binding — a skeleton must not become a way to assert new facts', () => {
    expect(renderSkeletonInstruction(meetingRequestSkeleton())).toContain(
      'VALIDATED MESSAGE PLAN',
    );
  });
});
