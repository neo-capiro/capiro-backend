import { describe, expect, test } from 'vitest';
import { withClaimAnchors } from './alert-actions-api.js';
import { markdownishToHtml } from '../../engagement/outreach/v2/richtext.js';

/**
 * P1-15 (Gate C c-9 case 7 + §4 edge case 12).
 *
 * The Workspace path builds its draft from the structured `sections`, not from the
 * server's markdown, so it needs its own anchor rendering — and that rendering has to
 * match apps/api's `withClaimAnchors` exactly, or the same memo reads differently
 * depending on which surface you opened it from. These are the expected strings that
 * `apps/api/src/intelligence/alert-memo/alert-memo-citations.spec.ts` asserts for the
 * identical inputs.
 */
describe('withClaimAnchors — identical format to apps/api', () => {
  test.each([
    ['The closed rule is stalling floor consideration.', ['c2', 'c4'], 'The closed rule is stalling floor consideration. [c2][c4]'],
    ['Cited.', ['c1'], 'Cited. [c1]'],
    ['Three sources agree.', ['c3', 'c1', 'c2'], 'Three sources agree. [c3][c1][c2]'],
  ])('renders %p / %p as %p', (text, ids, expected) => {
    expect(withClaimAnchors(text, ids as string[])).toBe(expected);
  });

  test('adds no anchor and no trailing space when there are no claimIds', () => {
    expect(withClaimAnchors('The rule was granted.', [])).toBe('The rule was granted.');
    expect(withClaimAnchors('The rule was granted.', undefined)).toBe('The rule was granted.');
    expect(withClaimAnchors('The rule was granted.', [])).not.toMatch(/\s$/);
  });

  test('the Workspace section body joins anchored paragraphs with a blank line', () => {
    const paragraphs = [
      { text: 'First point.', claimIds: ['c1'] },
      { text: 'Second point.', claimIds: [] },
      { text: 'Third point.', claimIds: ['c2', 'c3'] },
    ];
    expect(paragraphs.map((p) => withClaimAnchors(p.text, p.claimIds)).join('\n\n')).toBe(
      'First point. [c1]\n\nSecond point.\n\nThird point. [c2][c3]',
    );
  });
});

/**
 * §4 edge case 12: `[c1]` is a valid markdown shortcut-reference, so a renderer COULD
 * turn it into a link and the anchor would arrive in the Workspace editor as a broken
 * link. markdownishToHtml's inline() only linkifies the full `[text](url)` form, so a
 * bare bracket pair stays literal — no escaping needed. This is the lock on that.
 */
describe('claim anchors survive the Workspace renderer as literal text', () => {
  test('a bare [c1] is not linkified', () => {
    const html = markdownishToHtml('The rule was granted. [c1][c2]');
    expect(html).toContain('[c1][c2]');
    expect(html).not.toContain('<a ');
  });

  test('a real inline link in the same paragraph still linkifies', () => {
    const html = markdownishToHtml('See [the bill](https://congress.gov/bill/hr8800). [c1]');
    expect(html).toContain('<a href="https://congress.gov/bill/hr8800">the bill</a>');
    expect(html).toContain('[c1]');
  });
});
