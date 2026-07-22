import type { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function makeService(): EmailService {
  const prisma = {} as unknown as PrismaService;
  const config = {
    get: (key: string) => (key === 'ONBOARD_EMAIL_FROM' ? 'onboarding@capiro.ai' : undefined),
  } as unknown as ConfigService;
  return new EmailService(prisma, config);
}

describe('EmailService.buildRawMime', () => {
  it('assembles multipart/mixed with an attachment and RFC-2047 subject', () => {
    const svc = makeService();
    // buildRawMime is private — exercised directly for the attachment path.
    const raw: Buffer = (
      svc as unknown as { buildRawMime: (o: unknown) => Buffer }
    ).buildRawMime({
      to: 'jane@firm.example',
      kind: 'signed_terms',
      dedupeKey: 'k',
      subject: 'Your signed agreements — café ☕',
      html: '<p>hi</p>',
      text: 'hi',
      attachments: [
        {
          filename: 'Capiro-Terms-of-Service-signed.pdf',
          content: Buffer.from('%PDF-1.7 test'),
          contentType: 'application/pdf',
        },
      ],
    });
    const s = raw.toString('utf8');
    expect(s).toContain('From: onboarding@capiro.ai');
    expect(s).toContain('To: jane@firm.example');
    expect(s).toContain('Content-Type: multipart/mixed; boundary="mixed_');
    expect(s).toContain('Content-Type: multipart/alternative; boundary="alt_');
    expect(s).toContain('Content-Type: application/pdf; name="Capiro-Terms-of-Service-signed.pdf"');
    expect(s).toContain(
      'Content-Disposition: attachment; filename="Capiro-Terms-of-Service-signed.pdf"',
    );
    expect(s).toMatch(/Subject: =\?UTF-8\?B\?/); // non-ASCII subject encoded
    expect(s).toContain(Buffer.from('%PDF-1.7 test').toString('base64'));
  });
});
