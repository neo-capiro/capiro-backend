/**
 * Lays one sample letter out four different ways for the Format step's preview.
 *
 * The point of this module is that it INVENTS NOTHING. Every fact, row, section
 * and closing line the briefing-card, status-table and timeline previews show is
 * derived from the letter's own words — the format decides where the words go,
 * never what they are. That is the promise the Format step makes in copy
 * ("Presentation only. The words come from the template you picked"), so the
 * derivation rules are deliberately conservative and each one is asserted:
 *
 *   - a heading is a line that is entirely upper-case and short;
 *   - a bullet is a line that starts with a dash, a bullet or "1) ";
 *   - source small print is only what follows the LAST bare em-dash rule, so an
 *     inline "Source:" line mid-letter stays in the body instead of truncating it;
 *   - facts come only from figures the subject line itself states;
 *   - a table row is only a line that genuinely carries middot-separated fields;
 *   - a closing line has to read as a sentence — a lone section label does not.
 *
 * Ported from the Engagement V2 prototype's `wizardVals()` preview pipeline.
 */

/** The middot-with-spaces the prototype's letters use as a field separator. */
const FIELD_SEPARATOR = ' · ';

export type OutreachLetterBlockKind = 'head' | 'bullet' | 'para';

export interface OutreachLetterBlock {
  kind: OutreachLetterBlockKind;
  text: string;
}

export interface OutreachLetterFact {
  value: string;
  label: string;
}

export interface OutreachLetterTableRow {
  item: string;
  detail: string;
  note: string;
}

export interface OutreachLetterSection {
  head: string;
  items: string[];
}

export interface OutreachLetterLayout {
  /** Every body block, headings and bullets classified, small print removed. */
  blocks: OutreachLetterBlock[];
  /** Up to three figure/label pairs taken from the subject line. */
  facts: OutreachLetterFact[];
  /** Up to six middot-separated rows, for the status-table format. */
  tableRows: OutreachLetterTableRow[];
  /** True when at least one row has a third field worth a "Note" column. */
  hasNoteColumn: boolean;
  /** Heading-led groups, for the timeline format. */
  sections: OutreachLetterSection[];
  /** The last block that reads as a full sentence, or ''. */
  closingLine: string;
  /** Source small print after the last em-dash rule, joined with spaces. */
  footnote: string;
}

const MAX_HEADING_LENGTH = 64;
const MAX_FACTS = 3;
const MAX_TABLE_ROWS = 6;
const MAX_SECTIONS = 7;
const MAX_SECTION_ITEMS = 4;
const MIN_CLOSING_WORDS = 7;
const EM_DASH_RULE = '—';

const BULLET_PREFIX = /^[-•]\s|^\d\)\s/;
/** A leading figure: an optional comparator, digits, then an optional unit. */
const FACT_PATTERN = /^([≤<>~]?\s?[\d.,]+[A-Za-z%]*)\s+(.+)$/;

function classify(text: string): OutreachLetterBlock {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters && text === text.toUpperCase() && text.length < MAX_HEADING_LENGTH) {
    return { kind: 'head', text };
  }
  if (BULLET_PREFIX.test(text)) {
    return { kind: 'bullet', text: text.replace(BULLET_PREFIX, '') };
  }
  return { kind: 'para', text };
}

/**
 * Split a letter into blocks. Blank lines are separators, not content, so a
 * letter's paragraph spacing does not become empty preview rows.
 */
export function outreachLetterBlocks(body: string): OutreachLetterBlock[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(classify);
}

/**
 * The figures the subject line states, as value/label pairs. A subject with no
 * leading-figure fields yields none rather than a guess.
 */
export function outreachLetterFacts(subject: string): OutreachLetterFact[] {
  return subject
    .split(FIELD_SEPARATOR)
    .map((field) => {
      const match = field.trim().match(FACT_PATTERN);
      if (!match || match[1] === undefined || match[2] === undefined) return null;
      return { value: match[1].trim(), label: match[2].trim() };
    })
    .filter((fact): fact is OutreachLetterFact => fact !== null)
    .slice(0, MAX_FACTS);
}

export function outreachLetterLayout(subject: string, body: string): OutreachLetterLayout {
  const all = outreachLetterBlocks(body);

  // Only the block after the LAST bare em-dash rule is source small print.
  let cut = -1;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i]?.text === EM_DASH_RULE) {
      cut = i;
      break;
    }
  }
  const blocks = cut > -1 ? all.slice(0, cut) : all;
  const footnoteBlocks = cut > -1 ? all.slice(cut).filter((b) => b.text !== EM_DASH_RULE) : [];

  const tableRows = blocks
    .filter((b) => b.kind !== 'head' && b.text.split(FIELD_SEPARATOR).length > 1)
    .slice(0, MAX_TABLE_ROWS)
    .map((b) => {
      const parts = b.text.split(FIELD_SEPARATOR).map((part) => part.trim());
      return {
        item: parts[0] ?? '',
        detail: parts[1] || EM_DASH_RULE,
        note: parts.slice(2).join(FIELD_SEPARATOR) || EM_DASH_RULE,
      };
    });

  const sections: OutreachLetterSection[] = [];
  let current: OutreachLetterSection | null = null;
  for (const block of blocks) {
    if (block.kind === 'head') {
      current = { head: block.text, items: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { head: '', items: [] };
      sections.push(current);
    }
    current.items.push(block.text);
  }

  const sentences = blocks.filter(
    (b) =>
      b.kind === 'para' &&
      b.text.split(/\s+/).length > MIN_CLOSING_WORDS - 1 &&
      /[.!?]$/.test(b.text),
  );

  return {
    blocks,
    facts: outreachLetterFacts(subject),
    tableRows,
    hasNoteColumn: tableRows.some((row) => row.note !== EM_DASH_RULE),
    sections: sections
      .slice(0, MAX_SECTIONS)
      .map((section) => ({ head: section.head, items: section.items.slice(0, MAX_SECTION_ITEMS) })),
    closingLine: sentences.at(-1)?.text ?? '',
    footnote: footnoteBlocks.map((b) => b.text).join(' '),
  };
}

/** The status-table preview drops its third column when no row has one. */
export function outreachLetterTableGrid(hasNoteColumn: boolean): string {
  return hasNoteColumn
    ? 'minmax(0,1.5fr) minmax(0,1fr) minmax(0,1fr)'
    : 'minmax(0,1.6fr) minmax(0,1fr)';
}

export const OUTREACH_TABLE_FORMAT_EMPTY_NOTE =
  'This letter has no tabular rows — the standard-email or briefing-card format suits it better.';

export const OUTREACH_FORMAT_PREVIEW_FOOTNOTE =
  'Rendered from the selected letter’s own words. Any mailbox that strips HTML receives the standard-email version of the same text.';
