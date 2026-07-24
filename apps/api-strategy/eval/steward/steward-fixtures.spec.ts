/**
 * Stage E — Steward eval fixtures self-test (DETERMINISTIC, no LLM).
 *
 * The five Phase-3 scenarios (conflicting asks · stale dates · uncertain
 * positions · hard-vs-soft deadlines · authority levels) live as seven real
 * markdown documents in this directory. This spec proves — with the REAL
 * Stage D primitives, zero network/DB — that every fixture is a document a
 * live Steward run could actually consume:
 *
 *   1. `parseFrontmatter` + `validateFrontmatter` return ZERO errors (real
 *      calendar dates, no template placeholders, vocab-valid enums), and the
 *      document_type maps to a pack templateKey.
 *   2. `locateAll` surfaces the expected section anchors, and every
 *      contradiction/hedge/deadline the scenario is ABOUT is locatable via its
 *      closed-set `row:<heading>:<n>` ref — the exact anchors a live Steward
 *      extraction would cite into sp_context_fact.sourceRef.
 *
 * Live extraction SCORING (running the Steward over these and judging the
 * facts/conflicts it produces) folds into the L2 harness — manual, Stage H
 * wires the cadence. See eval/README.md.
 */
import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  AUTHORITIES,
  TEMPLATE_KEY_BY_TYPE,
  parseFrontmatter,
  validateFrontmatter,
  type DocumentTypeValue,
  type Frontmatter,
} from '../../src/context/frontmatter.js';
import { locate, locateAll } from '../../src/context/markdown-locate.js';

interface RowExpectation {
  /** The closed-set anchor a live Steward run would cite. */
  ref: string;
  /** Substrings that must appear in the DATA row itself (header echo excluded). */
  contains: string[];
}

interface FixtureExpectation {
  file: string;
  /** 'heading:' refs locateAll must surface. */
  headings: string[];
  rows: RowExpectation[];
}

const FIXTURES: FixtureExpectation[] = [
  {
    file: 'conflicting-asks-a.md',
    headings: ['heading:Strategy brief', 'heading:Goal', 'heading:Definition of success'],
    rows: [{ ref: 'row:Goal:1', contains: ['$25,000,000', 'Atlas maritime sensor', '2026-09-30'] }],
  },
  {
    file: 'conflicting-asks-b.md',
    headings: [
      'heading:Ask and strategic options',
      'heading:Primary ask',
      'heading:Fallback options',
    ],
    rows: [
      { ref: 'row:Primary ask:1', contains: ['$40,000,000', 'Atlas maritime sensor', '2027-03-31'] },
      { ref: 'row:Fallback options:2', contains: ['$25,000,000 partial plus-up'] },
    ],
  },
  {
    file: 'stale-dates.md',
    headings: [
      'heading:Calendar and deadlines',
      'heading:Hard deadlines',
      'heading:Date assumptions and uncertainty',
    ],
    rows: [
      { ref: 'row:Calendar and deadlines:1', contains: ['2026-03-13', 'Hard'] },
      { ref: 'row:Calendar and deadlines:2', contains: ['2026-05-15', 'Soft'] },
    ],
  },
  {
    file: 'uncertain-positions.md',
    headings: ['heading:Stakeholder map', 'heading:Priority tiers', 'heading:Watcher rules'],
    rows: [
      { ref: 'row:Stakeholder map:1', contains: ['Unknown', 'Low', 'reportedly'] },
      { ref: 'row:Stakeholder map:2', contains: ['Lean support', 'Low', 'May support'] },
      { ref: 'row:Stakeholder map:3', contains: ['has not said so on the record'] },
    ],
  },
  {
    file: 'hard-vs-soft-deadlines.md',
    headings: [
      'heading:Calendar and deadlines',
      'heading:Hard deadlines',
      'heading:Soft or forecast dates',
      'heading:Timing instructions to Meri',
    ],
    rows: [
      { ref: 'row:Calendar and deadlines:1', contains: ['Hard', '2027-03-19'] },
      { ref: 'row:Calendar and deadlines:2', contains: ['Soft', '2027-06-07'] },
      { ref: 'row:Calendar and deadlines:3', contains: ['Hard', '2026-12-10'] },
    ],
  },
  {
    file: 'authority-levels-approved.md',
    headings: ['heading:Client constraints', 'heading:Resource limits', 'heading:Hard constraints'],
    rows: [
      { ref: 'row:Resource limits:1', contains: ['$150,000'] },
      { ref: 'row:Hard constraints:1', contains: ['No public statements naming the prime contractor'] },
    ],
  },
  {
    file: 'authority-levels-draft.md',
    headings: ['heading:Client constraints', 'heading:Resource limits'],
    rows: [{ ref: 'row:Resource limits:1', contains: ['$200,000'] }],
  },
];

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

/** Parse + validate a fixture, throwing loudly with the field errors on failure. */
function loadValid(file: string): { raw: string; fm: Frontmatter } {
  const raw = read(file);
  const parsed = parseFrontmatter(raw);
  expect(parsed.errors).toEqual([]);
  expect(parsed.frontmatter).not.toBeNull();
  const errors = validateFrontmatter(parsed.frontmatter!);
  if (errors.length > 0) {
    throw new Error(`${file} failed validation: ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
  }
  return { raw, fm: parsed.frontmatter! };
}

describe('Stage E — Steward fixtures self-test (deterministic, no LLM)', () => {
  it('the fixture directory holds exactly the seven expected documents (no orphans)', () => {
    const files = readdirSync(__dirname).filter((f) => f.endsWith('.md')).sort();
    expect(files).toEqual(FIXTURES.map((f) => f.file).sort());
  });

  describe.each(FIXTURES.map((f): [string, FixtureExpectation] => [f.file, f]))(
    '%s',
    (_label, fixture) => {
      it('passes parseFrontmatter + validateFrontmatter with zero errors', () => {
        const { fm } = loadValid(fixture.file);
        // The document_type must map to a real pack templateKey (00–13 contract).
        const templateKey = TEMPLATE_KEY_BY_TYPE[fm.document_type as DocumentTypeValue];
        expect(typeof templateKey).toBe('string');
        // validateFrontmatter already rejects placeholder dates/ids — assert
        // the two Steward-critical fields landed as real values anyway.
        expect(fm.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(fm.valid_until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });

      it('locateAll finds the expected sections', () => {
        const { raw } = loadValid(fixture.file);
        const refs = locateAll(raw).sections.map((s) => s.ref);
        for (const heading of fixture.headings) {
          expect(refs).toContain(heading);
        }
      });

      it('every scenario row is locatable via its closed-set row: ref', () => {
        const { raw } = loadValid(fixture.file);
        const lineCount = raw.split(/\r?\n/).length;
        for (const row of fixture.rows) {
          const hit = locate(raw, row.ref);
          expect(hit).not.toBeNull();
          expect(hit!.kind).toBe('row');
          expect(hit!.startLine).toBeGreaterThan(0);
          expect(hit!.endLine).toBeLessThanOrEqual(lineCount);
          // locate() appends the table's HEADER row for column context — assert
          // against the DATA row alone so a header echo can't fake a match.
          const dataRow = hit!.content.split('\n')[0]!;
          for (const needle of row.contains) {
            expect(dataRow).toContain(needle);
          }
        }
      });
    },
  );

  describe('scenario: conflicting asks (the pair actually contradicts)', () => {
    it('both docs assert the SAME program with DIFFERENT figures/timing at citable anchors', () => {
      const a = loadValid('conflicting-asks-a.md');
      const b = loadValid('conflicting-asks-b.md');

      // Same client + strategy — a live Steward run would compare these facts.
      expect(a.fm.client_id).toBe(b.fm.client_id);
      expect(a.fm.strategy_id).toBe(b.fm.strategy_id);

      const rowA = locate(a.raw, 'row:Goal:1')!.content.split('\n')[0]!;
      const rowB = locate(b.raw, 'row:Primary ask:1')!.content.split('\n')[0]!;
      // Shared subject…
      expect(rowA).toContain('Atlas maritime sensor');
      expect(rowB).toContain('Atlas maritime sensor');
      // …with contradicting amounts AND timing.
      expect(rowA).toContain('$25,000,000');
      expect(rowB).toContain('$40,000,000');
      expect(rowB).not.toContain('$25,000,000');
      expect(rowA).toContain('2026-09-30');
      expect(rowB).toContain('2027-03-31');

      // Both are client_approved — the conflict cannot be waved off on
      // authority; resolution needs a human (or the newer-as_of rule).
      expect(a.fm.authority).toBe('client_approved');
      expect(b.fm.authority).toBe('client_approved');
      expect(String(b.fm.as_of) > String(a.fm.as_of)).toBe(true); // ISO-lexical
    });
  });

  describe('scenario: stale dates', () => {
    it('is a VALID document whose validity horizon has already passed', () => {
      const { fm } = loadValid('stale-dates.md');
      // Frontmatter is fully valid (that is the point — staleness is a state,
      // not a validation failure)…
      const validUntil = String(fm.valid_until);
      // …but the horizon is in the past, so Stage D/E must treat it stale.
      expect(validUntil < '2026-07-24').toBe(true); // fixture pinned well in the past
      expect(new Date(validUntil).getTime()).toBeLessThan(Date.now());
      expect(String(fm.as_of) <= validUntil).toBe(true);
    });
  });

  describe('scenario: hard vs soft deadlines', () => {
    it('the Hard and Soft rows are distinct, adjacent, separately citable anchors', () => {
      const { raw } = loadValid('hard-vs-soft-deadlines.md');
      const hard = locate(raw, 'row:Calendar and deadlines:1')!;
      const soft = locate(raw, 'row:Calendar and deadlines:2')!;
      expect(hard.startLine).not.toBe(soft.startLine);
      const hardRow = hard.content.split('\n')[0]!;
      const softRow = soft.content.split('\n')[0]!;
      expect(hardRow).toContain('Hard');
      expect(hardRow).not.toContain('Soft');
      expect(softRow).toContain('Soft');
      expect(softRow).not.toContain('Hard');
    });
  });

  describe('scenario: authority levels', () => {
    it('client_approved and working_draft assert DIFFERENT figures for the same limit', () => {
      const approved = loadValid('authority-levels-approved.md');
      const draft = loadValid('authority-levels-draft.md');

      expect(approved.fm.client_id).toBe(draft.fm.client_id);
      expect(approved.fm.authority).toBe('client_approved');
      expect(draft.fm.authority).toBe('working_draft');
      expect(AUTHORITIES).toContain(approved.fm.authority);
      expect(AUTHORITIES).toContain(draft.fm.authority);

      const approvedRow = locate(approved.raw, 'row:Resource limits:1')!.content.split('\n')[0]!;
      const draftRow = locate(draft.raw, 'row:Resource limits:1')!.content.split('\n')[0]!;
      // Same limit, different figures — the authority ladder decides.
      expect(approvedRow).toContain('External advocacy budget cap');
      expect(draftRow).toContain('External advocacy budget cap');
      expect(approvedRow).toContain('$150,000');
      expect(draftRow).toContain('$200,000');
      // The approved doc is the source of truth; the working draft is not.
      expect(approved.fm.source_of_truth).toBe(true);
      expect(draft.fm.source_of_truth).toBe(false);
    });
  });
});
