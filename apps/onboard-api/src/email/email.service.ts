import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  /** MIME type, e.g. 'application/pdf'. */
  contentType: string;
}

export interface SendEmailOptions {
  to: string;
  /** Email kind for the log/cadence queries (e.g. 'receipt', 'it_admin_invite'). */
  kind: string;
  /** Unique idempotency key — a repeated send with the same key is a silent no-op. */
  dedupeKey: string;
  subject: string;
  html: string;
  text: string;
  tenantId?: string;
  purchaserId?: string;
  /** When present, the message is sent as raw MIME (multipart/mixed) so files
   * ride along as attachments — SES Simple content cannot carry attachments. */
  attachments?: EmailAttachment[];
}

export interface SendEmailResult {
  /** True when SES actually accepted the message this call. */
  sent: boolean;
  /** True when the dedupe key had already been used (nothing sent). */
  skipped: boolean;
  sesMessageId: string | null;
}

/**
 * Onboarding email sender: a thin SESv2 wrapper made idempotent by
 * onboard_email_log (unique dedupe_key) so funnel retries and cron double-runs
 * can never double-send.
 *
 * Fail-soft by default: unless ONBOARD_EMAIL_ENABLED='true' the send is only
 * logged (row recorded with sesMessageId 'disabled') so local/dev/staging
 * flows complete without emailing anyone. When enabled, an SES failure is
 * logged and rethrown — the caller decides whether the step survives it.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly ses: SESv2Client;
  private readonly from: string;
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.ses = new SESv2Client({
      region: config.get<string>('AWS_REGION_DEFAULT') ?? 'us-east-1',
    });
    this.from = config.get<string>('ONBOARD_EMAIL_FROM') ?? 'onboarding@capiro.ai';
    this.enabled = config.get<string>('ONBOARD_EMAIL_ENABLED') === 'true';
  }

  async send(opts: SendEmailOptions): Promise<SendEmailResult> {
    const existing = await this.prisma.onboardEmailLog.findUnique({
      where: { dedupeKey: opts.dedupeKey },
      select: { sesMessageId: true },
    });
    if (existing) {
      this.logger.debug(`Email dedupe hit (${opts.kind} → ${opts.to}) — skipping`);
      return { sent: false, skipped: true, sesMessageId: existing.sesMessageId };
    }

    let sesMessageId = 'disabled';
    if (this.enabled) {
      try {
        const hasAttachments = (opts.attachments?.length ?? 0) > 0;
        const command = hasAttachments
          ? new SendEmailCommand({
              FromEmailAddress: this.from,
              Destination: { ToAddresses: [opts.to] },
              Content: { Raw: { Data: this.buildRawMime(opts) } },
            })
          : new SendEmailCommand({
              FromEmailAddress: this.from,
              Destination: { ToAddresses: [opts.to] },
              Content: {
                Simple: {
                  Subject: { Data: opts.subject, Charset: 'UTF-8' },
                  Body: {
                    Html: { Data: opts.html, Charset: 'UTF-8' },
                    Text: { Data: opts.text, Charset: 'UTF-8' },
                  },
                },
              },
            });
        const res = await this.ses.send(command);
        sesMessageId = res.MessageId ?? 'unknown';
      } catch (err) {
        this.logger.error(`SES send failed (${opts.kind} → ${opts.to}): ${(err as Error).message}`);
        throw err;
      }
    } else {
      this.logger.log(
        `Email disabled (ONBOARD_EMAIL_ENABLED≠true) — would send ${opts.kind} "${opts.subject}" to ${opts.to}`,
      );
    }

    try {
      await this.prisma.onboardEmailLog.create({
        data: {
          kind: opts.kind,
          dedupeKey: opts.dedupeKey,
          toEmail: opts.to,
          sesMessageId,
          tenantId: opts.tenantId ?? null,
          purchaserId: opts.purchaserId ?? null,
        },
      });
    } catch (err) {
      // A concurrent sender won the dedupe-key race after our read — benign.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.warn(`Email log race on dedupe key ${opts.dedupeKey} — already recorded`);
        return { sent: this.enabled, skipped: true, sesMessageId };
      }
      throw err;
    }

    return { sent: this.enabled, skipped: false, sesMessageId };
  }

  /**
   * Assemble a raw multipart/mixed MIME message: a multipart/alternative
   * text+html body followed by base64 attachments. Everything is base64-encoded
   * so UTF-8 bodies and binary PDFs are transmitted safely.
   */
  private buildRawMime(opts: SendEmailOptions): Buffer {
    const CRLF = '\r\n';
    const mixed = `mixed_${randomUUID()}`;
    const alt = `alt_${randomUUID()}`;
    const wrap76 = (b64: string) => b64.replace(/(.{76})/g, `$1${CRLF}`);
    const encodeText = (s: string) => wrap76(Buffer.from(s, 'utf8').toString('base64'));

    const lines: string[] = [
      `From: ${this.from}`,
      `To: ${opts.to}`,
      `Subject: ${encodeHeaderValue(opts.subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${mixed}"`,
      '',
      `--${mixed}`,
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      '',
      `--${alt}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeText(opts.text),
      `--${alt}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeText(opts.html),
      `--${alt}--`,
    ];
    for (const att of opts.attachments ?? []) {
      const safeName = att.filename.replace(/["\r\n]/g, '');
      lines.push(
        `--${mixed}`,
        `Content-Type: ${att.contentType}; name="${safeName}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${safeName}"`,
        '',
        wrap76(att.content.toString('base64')),
      );
    }
    lines.push(`--${mixed}--`, '');
    return Buffer.from(lines.join(CRLF), 'utf8');
  }
}

/** RFC 2047 encoded-word for a header value that contains non-ASCII bytes. */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}
