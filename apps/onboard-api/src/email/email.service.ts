import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
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
  /** Stable attempt identity. Exact retries read the receipt; changed inputs conflict. */
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
  /** Durable provider-attempt state; sent means accepted by SES, not delivered. */
  status: 'sending' | 'sent' | 'disabled' | 'failed' | 'outcome_unknown';
}

/**
 * The existing unique log is the delivery claim, committed before SES. A crash
 * or uncertain provider result consumes that claim permanently; retries only
 * read its outcome. Disabled claims remain disabled if configuration changes.
 */
@Injectable()
export class EmailService implements OnModuleDestroy {
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
      maxAttempts: 1,
    });
    this.from = config.get<string>('ONBOARD_EMAIL_FROM') ?? 'onboarding@capiro.ai';
    this.enabled = config.get<string>('ONBOARD_EMAIL_ENABLED') === 'true';
  }

  onModuleDestroy() {
    this.ses.destroy();
  }

  async send(opts: SendEmailOptions): Promise<SendEmailResult> {
    const requestHash = createHash('sha256').update(JSON.stringify({
      to: opts.to, kind: opts.kind, tenantId: opts.tenantId ?? null,
      purchaserId: opts.purchaserId ?? null, from: this.from,
      subject: opts.subject, html: opts.html, text: opts.text,
      attachments: (opts.attachments ?? []).map(a => ({
        filename: a.filename, contentType: a.contentType,
        sha256: createHash('sha256').update(a.content).digest('hex'),
      })),
    })).digest('hex');
    // Build locally before claiming: a deterministic serialization failure has
    // not attempted delivery and should not leave a misleading sending claim.
    const command = (opts.attachments?.length ?? 0) > 0
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
    try {
      await this.prisma.onboardEmailLog.create({
        data: {
          kind: opts.kind,
          dedupeKey: opts.dedupeKey,
          toEmail: opts.to,
          sesMessageId: null,
          status: this.enabled ? 'sending' : 'disabled',
          requestHash,
          tenantId: opts.tenantId ?? null,
          purchaserId: opts.purchaserId ?? null,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.replay(opts, requestHash);
      }
      throw err;
    }

    if (!this.enabled)
      return { sent: false, skipped: false, sesMessageId: null, status: 'disabled' };
    let status: SendEmailResult['status'];
    let sesMessageId: string | null = null;
    try {
      const result = await this.ses.send(command, { abortSignal: AbortSignal.timeout(15_000) });
      sesMessageId = result.MessageId || null;
      status = sesMessageId ? 'sent' : 'outcome_unknown';
    } catch (error) {
      // Match the existing newsletter delivery owner: a definite 4xx refusal
      // is failed; network errors, timeouts and 5xx may have been accepted.
      const code = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      status = code && code >= 400 && code < 500 && code !== 408 ? 'failed' : 'outcome_unknown';
      this.logger.warn('Onboarding email provider attempt did not confirm acceptance');
    }
    // If this write fails, the durable sending claim fences all later calls.
    // Never catch a receipt failure by re-entering the provider attempt.
    const finished = await this.prisma.onboardEmailLog.updateMany({
      where: { dedupeKey: opts.dedupeKey, requestHash, status: 'sending' },
      data: { status, sesMessageId },
    });
    if (finished.count !== 1) return this.replay(opts, requestHash);
    return { sent: status === 'sent', skipped: false, sesMessageId, status };
  }

  private async replay(opts: SendEmailOptions, requestHash: string): Promise<SendEmailResult> {
    const prior = await this.prisma.onboardEmailLog.findUniqueOrThrow({
      where: { dedupeKey: opts.dedupeKey },
    });
    if ((prior.requestHash && prior.requestHash !== requestHash) ||
      prior.toEmail !== opts.to || prior.kind !== opts.kind ||
      prior.tenantId !== (opts.tenantId ?? null) || prior.purchaserId !== (opts.purchaserId ?? null))
      throw new ConflictException('Email request identity was already used for different inputs');
    let status = prior.status as SendEmailResult['status'];
    if (status === 'sending' && prior.sentAt.getTime() < Date.now() - 10 * 60_000) {
      const stale = await this.prisma.onboardEmailLog.updateMany({
        where: { id: prior.id, status: 'sending' }, data: { status: 'outcome_unknown' },
      });
      if (stale.count !== 1) return this.replay(opts, requestHash);
      status = 'outcome_unknown';
    }
    return {
      sent: false, skipped: true, status,
      sesMessageId: status === 'sent' ? prior.sesMessageId : null,
    };
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
