// OutreachEmailRenderer (W6.1) — golden/behavioral parity for the shared send
// renderer extracted from sendBatchEmails: the sanitize allowlist, plaintext
// passthrough/escape, and signature append must behave exactly as before.

import { describe, expect, test } from '@jest/globals';
import {
  appendOutreachSignature,
  escapeOutreachPlaintext,
  renderOutreachBody,
} from './outreach-email-renderer.js';

describe('renderOutreachBody', () => {
  test('plaintext (no tags) passes through as Text', () => {
    expect(renderOutreachBody('Hi Dana, following up.')).toEqual({
      content: 'Hi Dana, following up.',
      contentType: 'Text',
    });
  });

  test('HTML is sanitized to the allowlist and sent as HTML', () => {
    const out = renderOutreachBody('<p>Hi <strong>Dana</strong></p><script>alert(1)</script>');
    expect(out.contentType).toBe('HTML');
    expect(out.content).toContain('<strong>Dana</strong>');
    expect(out.content).not.toContain('<script>');
    expect(out.content).not.toContain('alert(1)');
  });

  test('links keep href and gain target=_blank + rel=noopener', () => {
    const out = renderOutreachBody('<p><a href="https://x.io">link</a></p>');
    expect(out.content).toContain('href="https://x.io"');
    expect(out.content).toContain('target="_blank"');
    expect(out.content).toContain('rel="noopener noreferrer"');
  });

  test('disallowed schemes (javascript:) are stripped', () => {
    const out = renderOutreachBody('<p><a href="javascript:alert(1)">x</a></p>');
    expect(out.content).not.toContain('javascript:');
  });

  test('disallowed tags (img/table) are removed but text kept', () => {
    const out = renderOutreachBody(
      '<p>see <img src="x.png"> the <table><tr><td>t</td></tr></table></p>',
    );
    expect(out.content).not.toContain('<img');
    expect(out.content).not.toContain('<table');
    expect(out.content).toContain('see');
  });

  test('empty body → empty Text', () => {
    expect(renderOutreachBody(undefined)).toEqual({ content: '', contentType: 'Text' });
  });
});

describe('escapeOutreachPlaintext', () => {
  test('escapes &, <, > and converts newlines to <br>', () => {
    expect(escapeOutreachPlaintext('a & b < c > d\ne')).toBe('a &amp; b &lt; c &gt; d<br>e');
  });
});

describe('appendOutreachSignature', () => {
  test('no signature → unchanged', () => {
    const rendered = { content: 'body', contentType: 'Text' as const };
    expect(appendOutreachSignature(rendered, '')).toBe(rendered);
  });

  test('HTML body + signature → concatenated HTML', () => {
    const out = appendOutreachSignature(
      { content: '<p>body</p>', contentType: 'HTML' },
      '<div>Sig</div>',
    );
    expect(out).toEqual({ content: '<p>body</p><br><br><div>Sig</div>', contentType: 'HTML' });
  });

  test('plaintext body + signature → body escaped to HTML first', () => {
    const out = appendOutreachSignature(
      { content: 'a < b\nc', contentType: 'Text' },
      '<div>Sig</div>',
    );
    expect(out.contentType).toBe('HTML');
    expect(out.content).toBe('a &lt; b<br>c<br><br><div>Sig</div>');
  });
});
