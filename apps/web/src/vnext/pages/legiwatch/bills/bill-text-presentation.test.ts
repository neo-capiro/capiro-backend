import { describe, expect, it } from 'vitest';
import type { ComparisonLine } from '@capiro/shared';
import { orderedBillTexts, billTextLabel, readingBillChanges } from './bill-text-presentation.js';
const line = (kind: 'added' | 'removed', text: string): ComparisonLine => ({ kind, text,
  left: kind === 'removed' ? { locator: 'page:1', start: 0, end: text.length } : null,
  right: kind === 'added' ? { locator: 'page:1', start: 0, end: text.length } : null });
describe('bill comparison presentation', () => {
  it('orders publication dates, expands official substitute numbers, leaves unknown dates last', () => {
    const versions = [
      { id: 'c3', title: 'Comm Sub', publishedDate: '2026-02-24', sourceUrl: 'https://www.flsenate.gov/Session/Bill/2026/1211/BillText/c3/PDF' },
      { id: 'filed', title: 'Introduced', publishedDate: '2026-01-08' },
      { id: 'unknown', title: 'Text', publishedDate: null },
      { id: 'c1', title: 'Comm Sub', publishedDate: '2026-02-06' },
    ].map((v) => ({ ...v, complete: true, kind: 'text' })) as any;
    expect(orderedBillTexts(versions).map((v) => v.id)).toEqual(['filed', 'c1', 'c3', 'unknown']);
    expect(billTextLabel(versions[0])).toBe('Committee substitute 3 · 2026-02-24');
  });
  it('suppresses page furniture and counter-only changes while preserving substantive numbers and wording', () => {
    const raw = [
      ...['HB 1211 2026', 'Page 1 of 2', 'First provision. 10', 'Second provision. 11', 'Third provision. 12', 'The amount is $100.', 'Effective July 1, 2026.'].map((s) => line('removed', s)),
      ...['CS/HB 1211 2026', 'Page 1 of 3', 'First provision. 20', 'Second provision. 21', 'Third provision. 22', 'The amount is $200.', 'Effective July 1, 2027.'].map((s) => line('added', s)),
    ];
    const snapshot = JSON.stringify(raw), view = readingBillChanges(raw);
    expect(view.changes.map((l) => l.text)).toEqual(['The amount is $100.', 'Effective July 1, 2026.', 'The amount is $200.', 'Effective July 1, 2027.']);
    expect(view.numericChanges).toHaveLength(6);
    expect(JSON.stringify(raw)).toBe(snapshot);
    expect(view.changes.every((l) => (l.left ?? l.right)?.locator === 'page:1')).toBe(true);
  });
  it('preserves every substantive numeric-only amendment when it resembles consecutive line counters', () => {
    const raw = [...['HB 1211 2026', 'Section A limits funding to 100', 'Section B limits funding to 101', 'Section C limits funding to 102'].map((s) => line('removed', s)),
      ...['CS/HB 1211 2026', 'Section A limits funding to 200', 'Section B limits funding to 201', 'Section C limits funding to 202'].map((s) => line('added', s))];
    const view = readingBillChanges(raw);
    expect(view.numericChanges.map((l) => l.text)).toEqual(['Section A limits funding to 100', 'Section A limits funding to 200', 'Section B limits funding to 101', 'Section B limits funding to 201', 'Section C limits funding to 102', 'Section C limits funding to 202']);
    expect(view.numericChanges.every((l) => (l.left ?? l.right)?.locator === 'page:1')).toBe(true);
  });
  it('does not strip unconfirmed trailing numbers or non-Florida text', () => {
    expect(readingBillChanges([line('removed', 'Section 100'), line('added', 'Section 101')]).changes.map((l) => l.text)).toEqual(['Section 100', 'Section 101']);
  });
});
