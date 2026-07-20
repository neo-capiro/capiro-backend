// RFC 2822 MIME assembly for the Gmail send adapter. The Gmail API accepts a
// base64url-encoded raw message; these tests decode it back and assert the
// wire format so a regression here can't silently mangle outbound mail.

import { describe, expect, test } from '@jest/globals';
import { buildGmailRawMessage } from './gmail-send.service.js';

function decode(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

/** Split a decoded MIME message into [headerBlock, bodyBlock] on the first blank line. */
function splitHeaders(mime: string): [string, string] {
  const idx = mime.indexOf('\r\n\r\n');
  return [mime.slice(0, idx), mime.slice(idx + 4)];
}

describe('buildGmailRawMessage', () => {
  test('single HTML email: headers + base64 body decode correctly', () => {
    const mime = decode(
      buildGmailRawMessage({
        subject: 'Following up',
        body: '<p>Hi <strong>Dana</strong></p>',
        bodyContentType: 'HTML',
        toRecipients: [{ email: 'dana@example.com', name: 'Dana Lee' }],
      }),
    );
    const [headers, body] = splitHeaders(mime);
    expect(headers).toContain('To: Dana Lee <dana@example.com>');
    expect(headers).toContain('Subject: Following up');
    expect(headers).toContain('MIME-Version: 1.0');
    expect(headers).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(headers).toContain('Content-Transfer-Encoding: base64');
    // The body is base64 — decoding it yields the original HTML.
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(
      '<p>Hi <strong>Dana</strong></p>',
    );
  });

  test('plain text defaults to text/plain', () => {
    const mime = decode(
      buildGmailRawMessage({
        subject: 'Hello',
        body: 'plain body',
        toRecipients: [{ email: 'a@b.com' }],
      }),
    );
    const [headers] = splitHeaders(mime);
    expect(headers).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(headers).toContain('To: a@b.com');
  });

  test('cc and bcc render as address lists; a name-less recipient is bare', () => {
    const mime = decode(
      buildGmailRawMessage({
        subject: 's',
        body: 'b',
        toRecipients: [{ email: 'to@x.com' }],
        ccRecipients: [{ email: 'cc@x.com', name: 'Cee' }],
        bccRecipients: [{ email: 'bcc@x.com' }],
      }),
    );
    const [headers] = splitHeaders(mime);
    expect(headers).toContain('Cc: Cee <cc@x.com>');
    expect(headers).toContain('Bcc: bcc@x.com');
  });

  test('no cc/bcc → those headers are omitted entirely', () => {
    const mime = decode(
      buildGmailRawMessage({
        subject: 's',
        body: 'b',
        toRecipients: [{ email: 'to@x.com' }],
      }),
    );
    const [headers] = splitHeaders(mime);
    expect(headers).not.toMatch(/^Cc:/m);
    expect(headers).not.toMatch(/^Bcc:/m);
  });

  test('non-ASCII subject is RFC 2047 encoded-word', () => {
    const mime = decode(
      buildGmailRawMessage({
        subject: 'Café ☕ update',
        body: 'b',
        toRecipients: [{ email: 'to@x.com' }],
      }),
    );
    const [headers] = splitHeaders(mime);
    const expected = `=?UTF-8?B?${Buffer.from('Café ☕ update', 'utf8').toString('base64')}?=`;
    expect(headers).toContain(`Subject: ${expected}`);
  });

  test('attachments produce a multipart/mixed body with the file part', () => {
    const fileB64 = Buffer.from('hello file', 'utf8').toString('base64');
    const mime = decode(
      buildGmailRawMessage({
        subject: 's',
        body: '<p>see attached</p>',
        bodyContentType: 'HTML',
        toRecipients: [{ email: 'to@x.com' }],
        attachments: [{ name: 'notes.txt', contentType: 'text/plain', contentBytes: fileB64 }],
      }),
    );
    const [headers] = splitHeaders(mime);
    expect(headers).toMatch(/Content-Type: multipart\/mixed; boundary="capiro_[0-9a-f]+"/);
    expect(mime).toContain('Content-Type: text/plain; name="notes.txt"');
    expect(mime).toContain('Content-Disposition: attachment; filename="notes.txt"');
    // The file bytes survive as base64 in their own part.
    expect(mime).toContain(fileB64);
    // Both the body part and the closing boundary are present.
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(mime).toMatch(/--capiro_[0-9a-f]+--/);
  });

  test('non-ASCII attachment filename is RFC 2231 / RFC 2047 encoded (no raw 8-bit header)', () => {
    const mime = decode(
      buildGmailRawMessage({
        subject: 's',
        body: 'b',
        toRecipients: [{ email: 'to@x.com' }],
        attachments: [
          {
            name: 'Résumé café.pdf',
            contentType: 'application/pdf',
            contentBytes: Buffer.from('x').toString('base64'),
          },
        ],
      }),
    );
    // Content-Disposition uses the RFC 2231 extended parameter.
    expect(mime).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9%20caf%C3%A9.pdf");
    // Content-Type name= uses an RFC 2047 encoded-word.
    expect(mime).toContain(
      `name="=?UTF-8?B?${Buffer.from('Résumé café.pdf', 'utf8').toString('base64')}?="`,
    );
    // The raw accented bytes never appear as a bare header value.
    expect(mime).not.toContain('filename="Résumé café.pdf"');
  });

  test('content type parameters are dropped to the base media type', () => {
    const mime = decode(
      buildGmailRawMessage({
        subject: 's',
        body: 'b',
        toRecipients: [{ email: 'to@x.com' }],
        attachments: [
          {
            name: 'a.csv',
            contentType: 'text/csv; charset=utf-8',
            contentBytes: Buffer.from('x').toString('base64'),
          },
        ],
      }),
    );
    expect(mime).toContain('Content-Type: text/csv; name="a.csv"');
    expect(mime).not.toContain('charset=utf-8');
  });

  test('CRLF in a recipient display name and address cannot break the header block', () => {
    const mime = decode(
      buildGmailRawMessage({
        subject: 'hi',
        body: 'b',
        toRecipients: [{ email: 'to@x.com\r\nBcc: evil@x.com', name: 'Dana\r\n\r\nInjected' }],
      }),
    );
    const [headers] = splitHeaders(mime);
    // No injected Bcc, and the header block still contains the real headers
    // (Subject/Content-Type were not pushed into the body by a blank line).
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(headers).toContain('Subject: hi');
    expect(headers).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(headers).toMatch(/^To: Dana Injected <to@x.comBcc: evil@x.com>$/m);
  });

  test('header-injection attempts in subject are neutralized (no CRLF leak)', () => {
    const mime = decode(
      buildGmailRawMessage({
        subject: 'ok\r\nBcc: evil@x.com',
        body: 'b',
        toRecipients: [{ email: 'to@x.com' }],
      }),
    );
    const [headers] = splitHeaders(mime);
    // The CRLF is collapsed to a space, so no injected Bcc header appears.
    expect(headers).not.toMatch(/^Bcc: evil@x\.com/m);
    expect(headers).toContain('Subject: ok Bcc: evil@x.com');
  });
});
