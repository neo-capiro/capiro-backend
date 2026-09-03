import { describe, expect, it } from '@jest/globals';
import { trimTrailingEmptyHtml } from './engagement.service.js';

/**
 * `sendSingleMail` appends the user's signature with a fixed `<br><br>` join
 * (`appendOutreachSignature`, the same one every campaign send already uses).
 * The compose window's contentEditable body routinely leaves a trailing
 * empty block (a `<div><br></div>` after the cursor's last blank line) —
 * left in place, that empty block's own rendered height stacks with the
 * `<br><br>` join, which is what produced "too much space between the
 * message and the signature". This is what strips it.
 */
describe('trimTrailingEmptyHtml', () => {
  it('leaves real content alone when there is no trailing empty block', () => {
    expect(trimTrailingEmptyHtml('<p>Great meeting you.</p>')).toBe('<p>Great meeting you.</p>');
  });

  it('strips a trailing empty div left by the rich-text editor', () => {
    expect(trimTrailingEmptyHtml('<p>Great meeting you.</p><div><br></div>')).toBe(
      '<p>Great meeting you.</p>',
    );
  });

  it('strips a trailing empty paragraph', () => {
    expect(trimTrailingEmptyHtml('<p>Great meeting you.</p><p><br></p>')).toBe(
      '<p>Great meeting you.</p>',
    );
  });

  it('strips a chain of trailing empty blocks and bare line breaks', () => {
    expect(
      trimTrailingEmptyHtml('<p>Great meeting you.</p><div><br></div><br><p>&nbsp;</p>'),
    ).toBe('<p>Great meeting you.</p>');
  });

  it('does not strip content from an empty-looking but non-empty trailing paragraph', () => {
    expect(trimTrailingEmptyHtml('<p>Great meeting you.</p><p>Thanks again.</p>')).toBe(
      '<p>Great meeting you.</p><p>Thanks again.</p>',
    );
  });
});
