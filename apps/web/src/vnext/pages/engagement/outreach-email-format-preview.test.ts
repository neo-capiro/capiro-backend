import { describe, expect, it } from 'vitest';
import {
  outreachLetterBlocks,
  outreachLetterFacts,
  outreachLetterLayout,
  outreachLetterTableGrid,
} from './outreach-email-format-preview.js';

/**
 * A letter shaped like the real template bodies: an intro paragraph, upper-case
 * section headings, middot-separated rows, numbered actions, and a trailing
 * em-dash rule with source small print under it.
 */
const LETTER = [
  'To: [Firm GA list]',
  '',
  'Bottom line',
  'Six sessions in the next seven days touch watched defense equities.',
  '',
  'HOUSE',
  'Mon Aug 25 · 10:00 ET · HASC Tactical Air & Land',
  'Tue Aug 26 · 14:00 ET · HAC-D',
  '',
  'SENATE',
  'Wed Aug 27 · 09:30 ET · SASC',
  '',
  'Actions',
  '1) Open packets for Mon HASC and Wed SASC',
  '- Generate prep for the owners before Monday',
  '',
  '—',
  'Source: Capiro hearings feed · as-of [timestamp ET]',
].join('\n');

const SUBJECT = 'Week ahead — hearings & markups (Aug 25–29) · 6 on your watch';

describe('outreachLetterBlocks', () => {
  it('drops blank lines instead of turning paragraph spacing into empty rows', () => {
    expect(outreachLetterBlocks('a\n\n\nb')).toEqual([
      { kind: 'para', text: 'a' },
      { kind: 'para', text: 'b' },
    ]);
  });

  it('treats a short all-caps line as a heading and a mixed-case one as prose', () => {
    expect(outreachLetterBlocks('HOUSE').at(0)).toEqual({ kind: 'head', text: 'HOUSE' });
    expect(outreachLetterBlocks('Bottom line').at(0)?.kind).toBe('para');
  });

  it('does not call a line with no letters a heading', () => {
    // The em-dash rule equals its own upper-case form, so the letter test is
    // what keeps a horizontal rule out of the timeline's section list.
    expect(outreachLetterBlocks('—').at(0)?.kind).toBe('para');
    expect(outreachLetterBlocks('· 2026 ·').at(0)?.kind).toBe('para');
    // One lowercase letter is enough to make a figure line prose again.
    expect(outreachLetterBlocks('$24.1M awarded').at(0)?.kind).toBe('para');
  });

  it('reads a lone figure whose unit is capital as a heading, as the prototype does', () => {
    // A quirk worth pinning rather than quietly correcting: "$24.1M" has a
    // letter ("M") and equals its upper-case form, so it classifies as a
    // heading. It only bites a letter that puts a bare figure on its own line,
    // and the alternative — excluding short numeric lines — would also reject
    // real headings like "FY27" and "PE 0603005A".
    expect(outreachLetterBlocks('$24.1M').at(0)?.kind).toBe('head');
  });

  it('does not call a long all-caps line a heading', () => {
    const shouty = 'THIS WHOLE SENTENCE IS SHOUTED AND IT RUNS WELL PAST SIXTY-FOUR CHARACTERS';
    expect(shouty.length).toBeGreaterThan(64);
    expect(outreachLetterBlocks(shouty).at(0)?.kind).toBe('para');
  });

  it('strips dash, bullet and "1) " markers from bullets', () => {
    expect(outreachLetterBlocks('- one').at(0)).toEqual({ kind: 'bullet', text: 'one' });
    expect(outreachLetterBlocks('• two').at(0)).toEqual({ kind: 'bullet', text: 'two' });
    expect(outreachLetterBlocks('3) three').at(0)).toEqual({ kind: 'bullet', text: 'three' });
    // Not a bullet: no space after the marker.
    expect(outreachLetterBlocks('-four').at(0)?.kind).toBe('para');
  });
});

describe('outreachLetterFacts', () => {
  it('takes only subject fields that lead with a figure', () => {
    expect(outreachLetterFacts(SUBJECT)).toEqual([{ value: '6', label: 'on your watch' }]);
  });

  it('reads comparators and units as part of the figure', () => {
    expect(outreachLetterFacts('4 new · 3 closing ≤14d · $24.1M awarded')).toEqual([
      { value: '4', label: 'new' },
      { value: '3', label: 'closing ≤14d' },
    ]);
    expect(outreachLetterFacts('≤7 days to close')).toEqual([
      { value: '≤7', label: 'days to close' },
    ]);
  });

  it('invents nothing when the subject states no figures', () => {
    expect(outreachLetterFacts('Meeting request: [Topic] briefing')).toEqual([]);
    expect(outreachLetterFacts('')).toEqual([]);
  });

  it('shows at most three facts', () => {
    expect(outreachLetterFacts('1 a · 2 b · 3 c · 4 d · 5 e')).toHaveLength(3);
  });
});

describe('outreachLetterLayout', () => {
  const layout = outreachLetterLayout(SUBJECT, LETTER);

  it('keeps source small print out of the body and joins it into a footnote', () => {
    expect(layout.footnote).toBe('Source: Capiro hearings feed · as-of [timestamp ET]');
    expect(layout.blocks.map((b) => b.text)).not.toContain(
      'Source: Capiro hearings feed · as-of [timestamp ET]',
    );
    expect(layout.blocks.map((b) => b.text)).not.toContain('—');
  });

  it('only cuts at the LAST em-dash rule, so a mid-letter source line stays in the body', () => {
    const withInlineSource = ['Alpha said so.', 'Source: the committee print', '—', 'Real footnote'].join(
      '\n',
    );
    const parsed = outreachLetterLayout('', withInlineSource);
    expect(parsed.blocks.map((b) => b.text)).toContain('Source: the committee print');
    expect(parsed.footnote).toBe('Real footnote');
  });

  it('has no footnote when the letter has no em-dash rule', () => {
    const parsed = outreachLetterLayout('', 'Just a body.');
    expect(parsed.footnote).toBe('');
    expect(parsed.blocks).toHaveLength(1);
  });

  it('builds table rows only from lines that carry separated fields', () => {
    expect(layout.tableRows).toEqual([
      { item: 'Mon Aug 25', detail: '10:00 ET', note: 'HASC Tactical Air & Land' },
      { item: 'Tue Aug 26', detail: '14:00 ET', note: 'HAC-D' },
      { item: 'Wed Aug 27', detail: '09:30 ET', note: 'SASC' },
    ]);
    expect(layout.hasNoteColumn).toBe(true);
  });

  it('never turns a heading into a table row', () => {
    const parsed = outreachLetterLayout('', 'HOUSE · SENATE\nMon · 10:00');
    expect(parsed.tableRows).toEqual([{ item: 'Mon', detail: '10:00', note: '—' }]);
  });

  it('drops the note column when no row has a third field', () => {
    const parsed = outreachLetterLayout('', 'Request · $10M\nMark · $12M');
    expect(parsed.hasNoteColumn).toBe(false);
    expect(outreachLetterTableGrid(false)).toBe('minmax(0,1.6fr) minmax(0,1fr)');
    expect(outreachLetterTableGrid(true)).toBe(
      'minmax(0,1.5fr) minmax(0,1fr) minmax(0,1fr)',
    );
  });

  it('caps the table at six rows', () => {
    const many = Array.from({ length: 9 }, (_, i) => `Row ${i} · detail`).join('\n');
    expect(outreachLetterLayout('', many).tableRows).toHaveLength(6);
  });

  it('groups blocks into heading-led sections, with an unheaded lead section', () => {
    expect(layout.sections.map((section) => section.head)).toEqual(['', 'HOUSE', 'SENATE']);
    expect(layout.sections.at(0)?.items).toEqual([
      'To: [Firm GA list]',
      'Bottom line',
      'Six sessions in the next seven days touch watched defense equities.',
    ]);
    expect(layout.sections.at(1)?.items).toEqual([
      'Mon Aug 25 · 10:00 ET · HASC Tactical Air & Land',
      'Tue Aug 26 · 14:00 ET · HAC-D',
    ]);
    // "Actions" is mixed case, so it is prose inside the SENATE section rather
    // than a section of its own — the parser reads case, not intent.
    expect(layout.sections.at(2)?.items).toContain('Actions');
  });

  it('caps sections at seven and their items at four', () => {
    const long = Array.from({ length: 9 }, (_, i) => `HEAD ${i}\na\nb\nc\nd\ne`).join('\n');
    const parsed = outreachLetterLayout('', long);
    expect(parsed.sections).toHaveLength(7);
    for (const section of parsed.sections) {
      expect(section.items.length).toBeLessThanOrEqual(4);
    }
  });

  it('picks the last block that reads as a sentence for the closing line', () => {
    expect(layout.closingLine).toBe(
      'Six sessions in the next seven days touch watched defense equities.',
    );
  });

  it('will not use a short label or a bullet as a closing line', () => {
    // "Actions" and "Bottom line" both end without punctuation and are short;
    // a bullet is excluded because it is not prose.
    expect(outreachLetterLayout('', 'Actions\nBottom line').closingLine).toBe('');
    expect(
      outreachLetterLayout('', '- This bulleted line is long enough and ends in a period.')
        .closingLine,
    ).toBe('');
  });

  it('handles an empty letter without throwing', () => {
    const parsed = outreachLetterLayout('', '');
    expect(parsed.blocks).toEqual([]);
    expect(parsed.tableRows).toEqual([]);
    expect(parsed.sections).toEqual([]);
    expect(parsed.facts).toEqual([]);
    expect(parsed.closingLine).toBe('');
    expect(parsed.footnote).toBe('');
  });
});
