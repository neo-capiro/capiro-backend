/*
 * Stage D context-utils — pure-logic coverage matching the existing strategy
 * test idiom (fiscal.test.ts). No strategy PAGE has component tests, so the
 * field-error contract is verified at the parseUploadError layer the modal
 * renders from, not via a jsdom render.
 */
import { describe, expect, it } from 'vitest';
import {
  canArchiveContextDoc,
  canExtractContextFacts,
  isContextDocStale,
  normalizeDocumentList,
  normalizeLocate,
  normalizeSections,
  parseUploadError,
  resolveHighlight,
  templateLabel,
  todayIso,
} from './context-utils.js';
import type { ContextDocumentListItem } from '../types.js';

const err400 = (data: unknown) => ({ response: { status: 400, data } });

describe('parseUploadError (upload 400 → general + field-level errors)', () => {
  it('parses { message, errors: [{ field, message }] }', () => {
    const view = parseUploadError(
      err400({
        message: 'Front-matter validation failed',
        errors: [
          { field: 'as_of', message: 'must be an ISO date (YYYY-MM-DD)' },
          { field: 'scope', message: 'must be one of once|node|strategy|client|firm' },
        ],
      }),
    );
    expect(view.general).toBe('Front-matter validation failed');
    expect(view.fields).toEqual([
      { field: 'as_of', message: 'must be an ISO date (YYYY-MM-DD)' },
      { field: 'scope', message: 'must be one of once|node|strategy|client|firm' },
    ]);
  });

  it('parses { fieldErrors: { field: msg | [msgs] } }', () => {
    const view = parseUploadError(
      err400({
        message: 'Invalid document',
        fieldErrors: { authority: 'unknown authority level', valid_until: ['must be a date'] },
      }),
    );
    expect(view.general).toBe('Invalid document');
    expect(view.fields).toEqual([
      { field: 'authority', message: 'unknown authority level' },
      { field: 'valid_until', message: 'must be a date' },
    ]);
  });

  it('splits Nest-style message arrays into field lines and prose', () => {
    const view = parseUploadError(
      err400({
        message: ['document_type: is required', 'The front-matter block is malformed'],
        error: 'Bad Request',
        statusCode: 400,
      }),
    );
    expect(view.fields).toEqual([{ field: 'document_type', message: 'is required' }]);
    expect(view.general).toBe('The front-matter block is malformed');
  });

  it('degrades to a general message for a plain-string body and for no body at all', () => {
    expect(parseUploadError(err400({ message: 'nope' }))).toEqual({ general: 'nope', fields: [] });
    const bare = parseUploadError(new Error('network'));
    expect(bare.fields).toEqual([]);
    expect(bare.general.length).toBeGreaterThan(0);
  });
});

function doc(overrides: Partial<ContextDocumentListItem>): ContextDocumentListItem {
  return {
    id: 'd1',
    clientId: null,
    scope: 'client',
    scopeRef: null,
    templateKey: '02_client_constraints',
    title: 'Client constraints',
    state: 'active',
    frontmatter: null,
    checksum: 'x',
    supersedesId: null,
    validUntil: null,
    createdByUserId: 'u1',
    updatedByUserId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('isContextDocStale (derived STALE chip)', () => {
  it('active doc past validUntil is stale; future is not', () => {
    expect(isContextDocStale(doc({ validUntil: '2026-07-01' }), '2026-07-24')).toBe(true);
    expect(isContextDocStale(doc({ validUntil: '2026-08-01' }), '2026-07-24')).toBe(false);
  });

  it('superseded/archived docs never show stale; missing horizon never stale', () => {
    expect(isContextDocStale(doc({ state: 'superseded', validUntil: '2020-01-01' }), '2026-07-24')).toBe(false);
    expect(isContextDocStale(doc({ state: 'archived', validUntil: '2020-01-01' }), '2026-07-24')).toBe(false);
    expect(isContextDocStale(doc({ validUntil: null }), '2026-07-24')).toBe(false);
  });

  it('falls back to front-matter valid_until when the column is null', () => {
    expect(
      isContextDocStale(doc({ validUntil: null, frontmatter: { valid_until: '2026-01-01' } }), '2026-07-24'),
    ).toBe(true);
  });

  it('todayIso is the UTC calendar day (matches the server cutoff), not the local one', () => {
    // Around UTC midnight the local calendar day differs from the UTC one in
    // any non-UTC timezone — the chip must agree with the server's UTC filter
    // (context-documents.service isStale) whichever side of UTC this runs on.
    expect(todayIso(new Date('2026-07-24T00:30:00Z'))).toBe('2026-07-24');
    expect(todayIso(new Date('2026-07-23T23:30:00Z'))).toBe('2026-07-23');
  });
});

describe('response normalizers', () => {
  it('normalizeDocumentList accepts bare arrays and wrapped envelopes', () => {
    const row = doc({});
    expect(normalizeDocumentList([row])).toEqual([row]);
    expect(normalizeDocumentList({ documents: [row] })).toEqual([row]);
    expect(normalizeDocumentList({ items: [row] })).toEqual([row]);
    expect(normalizeDocumentList('garbage')).toEqual([]);
  });

  it('normalizeSections tolerates heading/title naming + wrapped envelope', () => {
    const out = normalizeSections({
      sections: [
        { ref: 'goal', heading: 'Goal', level: 2, line: 12 },
        { id: 'scope', title: 'Scope', depth: 2 },
      ],
    });
    expect(out).toEqual([
      { ref: 'goal', heading: 'Goal', level: 2, line: 12 },
      { ref: 'scope', heading: 'Scope', level: 2, line: null },
    ]);
  });

  it('normalizeLocate maps line-range and snippet variants', () => {
    expect(normalizeLocate({ ref: 'goal', startLine: 3, endLine: 5, lines: ['a', 'b', 'c'] }, 'goal')).toEqual({
      ref: 'goal',
      startLine: 3,
      endLine: 5,
      lines: ['a', 'b', 'c'],
    });
    expect(normalizeLocate({ start: 7, snippet: 'x\ny' }, 'r')).toEqual({
      ref: 'r',
      startLine: 7,
      endLine: 7,
      lines: ['x', 'y'],
    });
  });
});

describe('resolveHighlight (locate → line range in the loaded body)', () => {
  const lines = ['# Title', '', '## Goal', '- Goal statement:', '- Target date:'];

  it('prefers API line numbers, clamped to the body', () => {
    expect(resolveHighlight(lines, { ref: 'g', startLine: 3, endLine: 5, lines: null })).toEqual({
      start: 3,
      end: 5,
    });
    expect(resolveHighlight(lines, { ref: 'g', startLine: 3, endLine: 99, lines: null })).toEqual({
      start: 3,
      end: 5,
    });
  });

  it('falls back to matching the echoed lines verbatim', () => {
    expect(
      resolveHighlight(lines, { ref: 'g', startLine: null, endLine: null, lines: ['## Goal', '- Goal statement:'] }),
    ).toEqual({ start: 3, end: 4 });
  });

  it('returns null when nothing anchors', () => {
    expect(resolveHighlight(lines, { ref: 'g', startLine: null, endLine: null, lines: ['missing'] })).toBeNull();
    expect(resolveHighlight(lines, { ref: 'g', startLine: null, endLine: null, lines: null })).toBeNull();
  });
});

describe('templateLabel', () => {
  it('strips the numeric prefix and humanizes underscores', () => {
    expect(templateLabel('03_ask_and_options')).toBe('Ask and options');
    expect(templateLabel('custom')).toBe('Custom');
  });
});

describe('canArchiveContextDoc (Archive button visibility contract)', () => {
  it('draft and active docs are archivable', () => {
    expect(canArchiveContextDoc('draft')).toBe(true);
    expect(canArchiveContextDoc('active')).toBe(true);
  });

  it('superseded is NOT archivable — the server 409s unconditionally on it', () => {
    // Superseded rows are retained history (context-documents.service:
    // "archive the active document instead"), so rendering an Archive button
    // for them is a dead end that can never succeed.
    expect(canArchiveContextDoc('superseded')).toBe(false);
  });

  it('archived is NOT re-archivable', () => {
    expect(canArchiveContextDoc('archived')).toBe(false);
  });
});

describe('canExtractContextFacts (Extract-facts button visibility contract)', () => {
  const both = { agenticMeri: true, contextSteward: true };

  it('shown only when agenticMeri AND contextSteward are on AND the doc is active', () => {
    expect(canExtractContextFacts(both, 'active')).toBe(true);
  });

  it('hidden when contextSteward is off/unset even with agenticMeri on — the route stacks ContextStewardGuard and would 403 on every click', () => {
    expect(canExtractContextFacts({ agenticMeri: true }, 'active')).toBe(false);
    expect(canExtractContextFacts({ agenticMeri: true, contextSteward: false }, 'active')).toBe(false);
  });

  it('hidden when agenticMeri is off even with contextSteward on (class-level AgenticGuard)', () => {
    expect(canExtractContextFacts({ contextSteward: true }, 'active')).toBe(false);
  });

  it('hidden for non-active docs — the server 409s unconditionally on them', () => {
    expect(canExtractContextFacts(both, 'draft')).toBe(false);
    expect(canExtractContextFacts(both, 'superseded')).toBe(false);
    expect(canExtractContextFacts(both, 'archived')).toBe(false);
  });

  it('hidden when features are absent (older cached /me shape degrades, never a 403)', () => {
    expect(canExtractContextFacts(undefined, 'active')).toBe(false);
  });
});
