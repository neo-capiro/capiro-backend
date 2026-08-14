import { describe, expect, test } from '@jest/globals';
import type { MailboxMessageRecord } from './mailbox-knowledge.types.js';
import { MailboxNormalizerService } from './mailbox-normalizer.service.js';

function message(bodyText: string): MailboxMessageRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    threadId: '33333333-3333-4333-8333-333333333333',
    threadExternalId: 'thread-1',
    threadSubject: 'FY28 priorities',
    clientId: '44444444-4444-4444-8444-444444444444',
    connectionId: '55555555-5555-4555-8555-555555555555',
    connectionOwnerUserId: '66666666-6666-4666-8666-666666666666',
    accountEmail: 'neo@capiro.ai',
    source: 'google',
    externalId: 'gmail-1',
    currentSourceRevision: 'a'.repeat(32),
    subject: ' Re: FY28 priorities ',
    fromEmail: 'Jane@Example.COM',
    fromName: ' Jane Smith ',
    toRecipients: [{ email: 'neo@capiro.ai', name: 'Neo' }],
    ccRecipients: [],
    bccRecipients: [],
    sentAt: null,
    receivedAt: new Date('2026-08-14T13:00:00Z'),
    bodyText,
    hasAttachments: false,
    removedAt: null,
    removedReason: null,
    metadata: {},
    raw: null,
    attachments: [],
    createdAt: new Date('2026-08-14T13:01:00Z'),
    updatedAt: new Date('2026-08-14T13:01:00Z'),
  };
}

describe('MailboxNormalizerService', () => {
  const service = new MailboxNormalizerService();

  test('keeps canonical source text but removes HTML, quoted history, signature, and notice from extraction text', () => {
    const normalized = service.normalize(
      message(`
        <div>We should protect PE 0605053A and avoid leading with autonomy.</div>
        <div>Best regards,<br>Jane Smith<br>Policy Director</div>
        <img src="https://tracker.example/pixel.gif" width="1" height="1">
        <div>On Thu, Aug 13, 2026 at 4:00 PM Neo wrote:</div>
        <blockquote>&gt; Old duplicated thread content</blockquote>
        <div>CONFIDENTIALITY NOTICE: this email is intended only for the recipient.</div>
      `),
    );

    expect(normalized.authoritativeText).toContain('We should protect PE 0605053A');
    expect(normalized.authoritativeText).toContain('Old duplicated thread content');
    expect(normalized.authoritativeText).not.toContain('<div>');
    expect(normalized.authoritativeText).not.toContain('tracker.example');
    expect(normalized.normalizedText).toBe(
      'We should protect PE 0605053A and avoid leading with autonomy.',
    );
    expect(normalized.stripped).toEqual({
      html: true,
      quotedHistory: true,
      signature: true,
      confidentialityNotice: false,
    });
    expect(normalized.authoritativeContentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('is deterministic across line-ending and trailing-space differences', () => {
    const first = service.normalize(message('Decision: pursue report language.\r\n\r\nThanks,  '));
    const second = service.normalize(message('Decision: pursue report language.\n\nThanks,'));

    expect(first.authoritativeText).toBe(second.authoritativeText);
    expect(first.authoritativeContentHash).toBe(second.authoritativeContentHash);
    expect(first.normalizedContentHash).toBe(second.normalizedContentHash);
  });

  test('normalizes and deduplicates recipient addresses', () => {
    const input = message('Please connect us with the committee staff director.');
    input.toRecipients = [
      { email: 'STAFFER@SENATE.GOV', name: 'Staffer' },
      { email: 'staffer@senate.gov', name: null },
    ];
    const normalized = service.normalize(input);
    expect(normalized.toRecipients).toEqual([
      { email: 'staffer@senate.gov', name: 'Staffer' },
    ]);
  });
});
