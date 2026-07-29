// The LEGACY (gateway-off) generation path must understand the SAME context-item
// wire contract its own clients speak.
//
// Phase 1 §3.b1 renamed the free-text fields — `note` became `userInstruction`, or
// `customNoteText` for a custom note — and the wizard stopped sending
// `note`/`title`/`body` at all (toContextItemPayload, enforced by
// context-contract.test.ts on the web side). Only generateBatchEmailsViaGateway was
// taught to read the new names, via normalizeSelectedContextItem. The legacy branch
// kept rendering `c.title` / `c.body` / `c.note`, so with
// ENGAGEMENT_GENERATION_GATEWAY off — which is how it shipped, and how it ran in
// production — every user instruction and every custom note's text was silently
// dropped from the prompt, and each item rendered as the literal `- [kind] undefined`.
//
// No API test referenced `contextItems` at all, which is exactly why CI could not
// catch it: the web side tested that it DROPS the legacy fields and the server side
// never tested what it READS. This spec is that missing half of the contract.

import { describe, expect, test } from '@jest/globals';
import { normalizeSelectedContextItem } from './engagement.service.js';

/** Exactly what toContextItemPayload (apps/web .../v2/types.ts) puts on the wire. */
const wizardSourceItem = {
  id: 'debrief-d1',
  kind: 'debrief' as const,
  scope: 'all',
  userInstruction: 'Lead with this.',
};

const wizardCustomNote = {
  id: 'ctx-note-1',
  kind: 'note' as const,
  scope: 'rep-dana',
  customNoteText: 'Dinner went well — keep it warm.',
  noteUse: 'instruction' as const,
};

describe('a modern wizard payload survives normalization', () => {
  test('a per-item instruction is preserved', () => {
    const out = normalizeSelectedContextItem(wizardSourceItem);
    expect(out.userInstruction).toBe('Lead with this.');
  });

  test("a custom note's TEXT is preserved, not dropped", () => {
    const out = normalizeSelectedContextItem(wizardCustomNote);
    expect(out.customNoteText).toBe('Dinner went well — keep it warm.');
    expect(out.noteUse).toBe('instruction');
  });

  test('scope survives so a per-recipient note lands on the right draft', () => {
    expect(normalizeSelectedContextItem(wizardCustomNote).scope).toBe('rep-dana');
  });

  test('an unmarked note defaults to instruction, never assertable fact', () => {
    const out = normalizeSelectedContextItem({
      id: 'ctx-note-2',
      kind: 'note',
      scope: 'all',
      customNoteText: 'We spoke last week.',
    });
    expect(out.noteUse).toBe('instruction');
  });

  test('a note explicitly marked as fact keeps that marking', () => {
    const out = normalizeSelectedContextItem({
      id: 'ctx-note-3',
      kind: 'note',
      scope: 'all',
      customNoteText: 'They shipped v2 in June.',
      noteUse: 'fact',
    });
    expect(out.noteUse).toBe('fact');
  });
});

describe('a legacy payload still maps onto the new names', () => {
  test('legacy `note` on a source item becomes userInstruction', () => {
    const out = normalizeSelectedContextItem({
      id: 'bill-hr1234-119',
      kind: 'bill',
      scope: 'all',
      note: 'Omit the deadline language.',
    });
    expect(out.userInstruction).toBe('Omit the deadline language.');
  });

  test('legacy `note` on a custom note becomes customNoteText', () => {
    const out = normalizeSelectedContextItem({
      id: 'ctx-note-4',
      kind: 'note',
      scope: 'all',
      note: 'Mention the site visit.',
    });
    expect(out.customNoteText).toBe('Mention the site visit.');
    expect(out.userInstruction).toBeUndefined();
  });

  test('a pre-Phase-1 note whose text rode in `body` is recovered', () => {
    const out = normalizeSelectedContextItem({
      id: 'ctx-note-5',
      kind: 'note',
      scope: 'all',
      body: 'Older client put the note text here.',
    });
    expect(out.customNoteText).toBe('Older client put the note text here.');
  });

  test('a browser-supplied title/body is never carried through as evidence', () => {
    const out = normalizeSelectedContextItem({
      id: 'bill-hr1234-119',
      kind: 'bill',
      scope: 'all',
      title: 'HR 1234',
      body: 'HR 1234 PASSED THE HOUSE UNANIMOUSLY.',
    });
    expect(JSON.stringify(out)).not.toMatch(/UNANIMOUSLY/);
    expect(out).not.toHaveProperty('title');
  });

  test('an empty instruction contributes no field at all', () => {
    const out = normalizeSelectedContextItem({
      id: 'bill-1',
      kind: 'bill',
      scope: 'all',
      userInstruction: '   ',
    });
    expect(out).not.toHaveProperty('userInstruction');
  });
});
