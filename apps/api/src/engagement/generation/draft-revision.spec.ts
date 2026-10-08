import { describe, expect, test } from '@jest/globals';
import { applyDraftRevision, REVISION_OUTPUT_CONTRACT } from './draft-revision.js';

export const MIA_DRAFT = {
  subject: 'Meeting with Amalgent Therapeutics',
  body: `Hi Hannah,
My name is Mia LaPinta, -- I work with a government affairs firm here in D.C. and wanted to reach out on behalf of Amalgent Therapeutics, a company focused on repurposing existing drugs to develop safer pain management alternatives.
Given your health policy portfolio and your office's seat on the House Veterans' Affairs Committee Health Subcommittee, I thought this work might be of interest. I've attached a one-pager with more detail on their approach.
Would you be available for a brief in-person meeting on October 22 or 23? Happy to work around your schedule if neither date works.
Thanks for your time — I look forward to hearing from you.
Best,`,
};

export const MIA_EDITS = [
  { field: 'body', find: ', -- ', replacement: ', ', occurrence: 1 },
  { field: 'body', find: 'government affairs firm', replacement: 'Lobbying Firm', occurrence: 1 },
  { field: 'body', find: ' — ', replacement: '. ', occurrence: 1 },
];

const output = (edits: unknown[]) => JSON.stringify({ edits, contextNote: '' });

describe('targeted draft revisions', () => {
  test('the output contract defers to the user’s entire phrase instead of suggesting a partial replacement', () => {
    expect(REVISION_OUTPUT_CONTRACT).toContain('ENTIRE source phrase');
    expect(REVISION_OUTPUT_CONTRACT).toContain('from the latest editing instruction');
    expect(REVISION_OUTPUT_CONTRACT).toContain('Preserve unrelated hyphens');
    expect(REVISION_OUTPUT_CONTRACT).not.toContain('government affairs');
    expect(REVISION_OUTPUT_CONTRACT).not.toContain('Lobbying Firm');
  });
  test('Mia: removes harsh dashes and uses Lobbying Firm without regenerating the email', () => {
    const revised = applyDraftRevision(output(MIA_EDITS), MIA_DRAFT);
    expect(revised).toEqual({
      subject: MIA_DRAFT.subject,
      body: MIA_DRAFT.body
        .replace(', -- ', ', ')
        .replace('government affairs firm', 'Lobbying Firm')
        .replace(' — ', '. '),
      contextNote: '',
    });
    expect(revised!.body).toContain('October 22 or 23');
    expect(revised!.body).toContain('one-pager');
    expect(revised!.body).not.toMatch(/--|—|government affairs/);
  });

  test('edits repeated text against the original, even if replacements contain the same text', () => {
    const original = { subject: 'Keep', body: 'a — b — c — d' };
    const edits = [3, 1, 2].map((occurrence) => ({
      field: 'body',
      find: ' — ',
      replacement: ', ',
      occurrence,
    }));
    expect(applyDraftRevision(output(edits), original)?.body).toBe('a, b, c, d');
    const repeated = [1, 2].map((occurrence) => ({
      field: 'body',
      find: 'firm',
      replacement: 'Lobbying firm',
      occurrence,
    }));
    expect(applyDraftRevision(output(repeated), { subject: '', body: 'firm and firm' })?.body).toBe(
      'Lobbying firm and Lobbying firm',
    );
  });

  test('keeps HTML, links, paragraph spacing, and subject verbatim outside edited spans', () => {
    const original = {
      subject: '  User subject  ',
      body: '<p>Hi Hannah,</p>\n<p>I work with a <strong>government affairs</strong> firm.</p>\n<p><a href="https://example.com/one-pager">One-pager</a></p>',
    };
    const edits = [
      {
        field: 'body',
        find: '<strong>government affairs</strong> firm',
        replacement: '<strong>Lobbying Firm</strong>',
        occurrence: 1,
      },
    ];
    expect(applyDraftRevision(output(edits), original)).toEqual({
      ...original,
      body: original.body.replace(
        '<strong>government affairs</strong> firm',
        '<strong>Lobbying Firm</strong>',
      ),
      contextNote: '',
    });
  });

  test('allows requested subject edits and insertions without changing unrelated body text', () => {
    const edits = [
      { field: 'subject', find: 'Meeting', replacement: 'Brief meeting', occurrence: 1 },
      {
        field: 'body',
        find: 'Best,',
        replacement: 'Thank you for considering.\nBest,',
        occurrence: 1,
      },
    ];
    const revised = applyDraftRevision(output(edits), MIA_DRAFT)!;
    expect(revised.subject).toBe('Brief meeting with Amalgent Therapeutics');
    expect(revised.body).toBe(MIA_DRAFT.body.replace('Best,', 'Thank you for considering.\nBest,'));
  });

  test.each([
    [{ field: 'body', find: 'missing', replacement: '', occurrence: 1 }],
    [{ field: 'body', find: 'Best,', replacement: '', occurrence: 2 }],
    [{ field: 'body', find: '', replacement: '', occurrence: 1 }],
    [{ field: 'body', find: 'Best,', replacement: '', occurrence: 0 }],
    [{ field: 'body', find: 'Best,', replacement: '', occurrence: 1.5 }],
    [{ field: 'invalid', find: 'Best,', replacement: '', occurrence: 1 }],
    [
      { field: 'body', find: 'Best,', replacement: '', occurrence: 1 },
      { field: 'body', find: 'Best', replacement: 'Thanks', occurrence: 1 },
    ],
    [{ field: 'body', find: 'Best,', replacement: '', occurrence: 1, unexpected: true }],
  ])('rejects a malformed, missing, or overlapping edit atomically: %j', (...edits) => {
    expect(applyDraftRevision(output(edits), MIA_DRAFT)).toBeNull();
    expect(MIA_DRAFT.body).toContain('government affairs firm');
  });

  test('rejects regenerated whole-draft responses instead of replacing the current draft', () => {
    expect(
      applyDraftRevision(
        JSON.stringify({ subject: 'New subject', body: 'New email', contextNote: '' }),
        MIA_DRAFT,
      ),
    ).toBeNull();
  });
});
