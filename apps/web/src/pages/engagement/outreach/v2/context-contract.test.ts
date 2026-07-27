/**
 * Selected-context request contract (Phase 1 §3.b1, §5.5).
 *
 * The wizard must send IDENTIFIERS and the user's own words — never a `title` or
 * `body`. Before Phase 1 the browser carried each item's display text back into
 * the generation request and the server rendered it into the prompt, which made
 * every factual claim's authority a string the client could edit.
 */
import { describe, expect, it } from 'vitest';
import { toContextItemPayload, type SelectedContextItem } from './types.js';

function item(over: Partial<SelectedContextItem> = {}): SelectedContextItem {
  return {
    id: 'bill-hr1234-119',
    kind: 'bill',
    title: 'HR 1234 — Directed-Energy Modernization Act',
    body: 'Referred to Armed Services (2026-06-01).',
    scope: 'all',
    note: '',
    ...over,
  };
}

describe('the request carries IDs and instructions, never external bodies', () => {
  it('drops title and body entirely', () => {
    const payload = toContextItemPayload(item());
    expect(payload).toEqual({ id: 'bill-hr1234-119', kind: 'bill', scope: 'all' });
    expect(payload).not.toHaveProperty('title');
    expect(payload).not.toHaveProperty('body');
  });

  it('drops a TAMPERED body just the same', () => {
    const payload = toContextItemPayload(
      item({ body: 'HR 1234 PASSED THE HOUSE UNANIMOUSLY.' }),
    );
    expect(JSON.stringify(payload)).not.toMatch(/UNANIMOUSLY/);
  });

  it('preserves the recipient scope so per-recipient items land on the right draft', () => {
    expect(toContextItemPayload(item({ scope: 'rep-dana' })).scope).toBe('rep-dana');
  });
});

describe('the note field maps by KIND', () => {
  it('on a source item, the note is a per-item DIRECTIVE', () => {
    const payload = toContextItemPayload(item({ note: 'Lead with this.' }));
    expect(payload.userInstruction).toBe('Lead with this.');
    expect(payload.customNoteText).toBeUndefined();
  });

  it('on a custom note, the same field is the note TEXT', () => {
    const payload = toContextItemPayload(
      item({ id: 'ctx-note-1', kind: 'note', title: 'Shared note', body: '', note: 'Dinner went well.' }),
    );
    expect(payload.customNoteText).toBe('Dinner went well.');
    expect(payload.userInstruction).toBeUndefined();
  });

  it('a custom note defaults to INSTRUCTION, not an assertable fact', () => {
    const payload = toContextItemPayload(
      item({ id: 'ctx-note-1', kind: 'note', note: 'Dinner went well.' }),
    );
    // The safe default: as an instruction this produces a warm reference; as a
    // fact it would license the model to narrate a dinner it knows nothing about.
    expect(payload.noteUse).toBe('instruction');
  });

  it('a note can be explicitly marked as a fact', () => {
    const payload = toContextItemPayload(
      item({ id: 'ctx-note-1', kind: 'note', note: 'They shipped v2 in June.', noteUse: 'fact' }),
    );
    expect(payload.noteUse).toBe('fact');
  });

  it('an unrecognized noteUse falls back to instruction rather than fact', () => {
    const payload = toContextItemPayload(
      item({
        id: 'ctx-note-1',
        kind: 'note',
        note: 'text',
        noteUse: 'something-else' as unknown as 'fact',
      }),
    );
    expect(payload.noteUse).toBe('instruction');
  });

  it('an empty note contributes no field at all', () => {
    expect(toContextItemPayload(item({ note: '   ' }))).toEqual({
      id: 'bill-hr1234-119',
      kind: 'bill',
      scope: 'all',
    });
  });
});

describe('every context kind round-trips as an identifier', () => {
  const kinds: Array<[SelectedContextItem['kind'], string]> = [
    ['bill', 'bill-hr1234-119'],
    ['stateBill', 'state-bill-CA-2026-AB100'],
    ['programElement', 'pe-0603285F'],
    ['email', 'mail-thread-1'],
    ['document', 'doc-att-1'],
    ['debrief', 'debrief-d1'],
    ['prep', 'prep-p1'],
  ];

  for (const [kind, id] of kinds) {
    it(`${kind} sends only its id`, () => {
      const payload = toContextItemPayload(item({ id, kind, body: 'SOME CLIENT-SIDE TEXT' }));
      expect(payload).toEqual({ id, kind, scope: 'all' });
    });
  }
});
