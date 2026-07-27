// Branch G-A (completion plan §3, Phase G) — extractGmailBodyText reads the
// real message body from a format=full Gmail payload (replacing the ~200-char
// snippet previously stored as bodyText), and stripGmailBodyData keeps that
// same full body out of raw_jsonb, where it would otherwise be duplicated
// across four columns in two tables (mailThread.raw, mailMessage.raw, create
// and update).

import { describe, expect, test } from '@jest/globals';
import { extractGmailBodyText, stripGmailBodyData } from './google-sync.service.js';

type GmailMessagePart = NonNullable<Parameters<typeof extractGmailBodyText>[0]>;
type GmailMessage = Parameters<typeof stripGmailBodyData>[0];

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

describe('extractGmailBodyText', () => {
  test('text/plain only: decodes the body', () => {
    const payload: GmailMessagePart = {
      mimeType: 'text/plain',
      parts: [{ mimeType: 'text/plain', body: { data: b64url('Plain text body') } }],
    };
    expect(extractGmailBodyText(payload)).toBe('Plain text body');
  });

  test('text/html only: strips tags and decodes entities', () => {
    const payload: GmailMessagePart = {
      mimeType: 'text/html',
      body: { data: b64url('<html><body><p>Hello &amp; welcome.</p><p>Second paragraph here.</p></body></html>') },
    };
    const result = extractGmailBodyText(payload);
    expect(result).not.toBeNull();
    expect(result).toContain('Hello & welcome.');
    expect(result).toContain('Second paragraph here.');
    expect(result).not.toMatch(/[<>]/);
    expect(result).not.toContain('&amp;');
  });

  test('multipart/alternative: prefers text/plain over text/html', () => {
    const payload: GmailMessagePart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('Plain version') } },
        { mimeType: 'text/html', body: { data: b64url('<p>HTML version</p>') } },
      ],
    };
    expect(extractGmailBodyText(payload)).toBe('Plain version');
  });

  test('multipart/mixed: an attachment part with the SAME mime type as the body is skipped, not the body itself', () => {
    // Both parts are text/plain; only the filename distinguishes the attachment
    // from the real body. The attachment is listed FIRST so a broken
    // implementation without the filename guard would return it instead.
    const payload: GmailMessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          filename: 'notes.txt',
          mimeType: 'text/plain',
          body: { data: b64url('attachment content, not the body'), attachmentId: 'xyz' },
        },
        { mimeType: 'text/plain', body: { data: b64url('This is the real body') } },
      ],
    };
    expect(extractGmailBodyText(payload)).toBe('This is the real body');
  });

  test('nested multipart (mixed > alternative > plain/html) is found by recursion', () => {
    const payload: GmailMessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('Nested plain body') } },
            { mimeType: 'text/html', body: { data: b64url('<p>Nested html body</p>') } },
          ],
        },
        {
          filename: 'attachment.pdf',
          mimeType: 'application/pdf',
          body: { data: b64url('binary'), attachmentId: 'a1' },
        },
      ],
    };
    expect(extractGmailBodyText(payload)).toBe('Nested plain body');
  });

  test('single-part message (no parts array, content directly on payload.body)', () => {
    const payload: GmailMessagePart = {
      mimeType: 'text/plain',
      body: { data: b64url('Single part body, no multipart wrapper') },
    };
    expect(extractGmailBodyText(payload)).toBe('Single part body, no multipart wrapper');
  });

  test('missing payload returns null', () => {
    expect(extractGmailBodyText(undefined)).toBeNull();
  });

  test('attachment-only message (no text/plain or text/html anywhere) returns null', () => {
    const payload: GmailMessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          filename: 'image.png',
          mimeType: 'image/png',
          body: { data: b64url('fake-image-bytes'), attachmentId: 'img1' },
        },
      ],
    };
    expect(extractGmailBodyText(payload)).toBeNull();
  });

  test('a body over 100,000 characters is truncated with the marker', () => {
    const longText = 'x'.repeat(150_000);
    const payload: GmailMessagePart = {
      mimeType: 'text/plain',
      body: { data: b64url(longText) },
    };
    const result = extractGmailBodyText(payload);
    expect(result).not.toBeNull();
    expect(result?.startsWith('x'.repeat(100))).toBe(true);
    expect(result?.endsWith('\n\n[truncated]')).toBe(true);
    expect(result?.length).toBe(100_000 + '\n\n[truncated]'.length);
  });

  test('base64url-specific characters (-, _) decode correctly, not just standard base64', () => {
    // Deterministic, not probabilistic: a 12-byte (multiple-of-3) ASCII string
    // ending in '?' (0x3F) forces the trailing base64 sextet to index 63,
    // which is '/' under standard base64 but '_' under the URL-safe alphabet
    // Gmail actually uses; ending in '>' (0x3E) forces index 62, '+' vs '-'.
    // Verified empirically (Buffer.from(...).toString('base64url')) before
    // writing this assertion, not derived from memory of the base64 table.
    const underscoreCase = 'a'.repeat(11) + '?';
    const hyphenCase = 'a'.repeat(11) + '>';
    const underscoreEncoded = b64url(underscoreCase);
    const hyphenEncoded = b64url(hyphenCase);
    expect(underscoreEncoded).toBe('YWFhYWFhYWFhYWE_');
    expect(hyphenEncoded).toBe('YWFhYWFhYWFhYWE-');

    expect(extractGmailBodyText({ mimeType: 'text/plain', body: { data: underscoreEncoded } })).toBe(
      underscoreCase,
    );
    expect(extractGmailBodyText({ mimeType: 'text/plain', body: { data: hyphenEncoded } })).toBe(
      hyphenCase,
    );
  });
});

describe('stripGmailBodyData', () => {
  test('clears body.data at every depth, including a single-part payload.body.data with no parts array', () => {
    const message: GmailMessage = {
      id: 'm2',
      payload: { mimeType: 'text/plain', body: { data: 'c2luZ2xlIHBhcnQ', size: 11 } },
    };
    const stripped = stripGmailBodyData(message);

    expect(message.payload?.body?.data).toBe('c2luZ2xlIHBhcnQ'); // original untouched
    expect(stripped.payload?.body?.data).toBeUndefined();
    expect(stripped.payload?.body?.size).toBe(11); // non-data fields preserved
    expect(stripped.payload?.mimeType).toBe('text/plain');
  });

  test('clears body.data at every depth of a nested multipart tree, preserving mimeType/filename/size/attachmentId, without mutating the input', () => {
    const message: GmailMessage = {
      id: 'm1',
      payload: {
        mimeType: 'multipart/mixed',
        body: { size: 0 },
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { size: 10, data: 'cGxhaW4gdGV4dA' } },
              { mimeType: 'text/html', body: { size: 20, data: 'PHA-aHRtbDwvcD4' } },
            ],
          },
          {
            filename: 'doc.pdf',
            mimeType: 'application/pdf',
            body: { size: 500, data: 'ZmFrZXBkZg', attachmentId: 'att1' },
          },
        ],
      },
    };

    const stripped = stripGmailBodyData(message);

    // Cleared on the copy, at every depth.
    expect(stripped.payload?.parts?.[0]?.parts?.[0]?.body?.data).toBeUndefined();
    expect(stripped.payload?.parts?.[0]?.parts?.[1]?.body?.data).toBeUndefined();
    expect(stripped.payload?.parts?.[1]?.body?.data).toBeUndefined();

    // Structure preserved.
    expect(stripped.payload?.parts?.[1]?.filename).toBe('doc.pdf');
    expect(stripped.payload?.parts?.[1]?.mimeType).toBe('application/pdf');
    expect(stripped.payload?.parts?.[1]?.body?.size).toBe(500);
    expect(stripped.payload?.parts?.[1]?.body?.attachmentId).toBe('att1');

    // The input was not mutated.
    expect(message.payload?.parts?.[0]?.parts?.[0]?.body?.data).toBe('cGxhaW4gdGV4dA');
    expect(message.payload?.parts?.[0]?.parts?.[1]?.body?.data).toBe('PHA-aHRtbDwvcD4');
    expect(message.payload?.parts?.[1]?.body?.data).toBe('ZmFrZXBkZg');
  });
});
