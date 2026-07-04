import { Injectable, Logger } from '@nestjs/common';

export interface SmsSendResult {
  /** True only when a provider actually accepted the message for delivery. */
  sent: boolean;
  /** True when SMS is not provisioned yet (no-op, by design). */
  dormant: boolean;
  providerMessageId?: string;
  error?: string;
}

/** Normalize a phone number to E.164, or null if it can't be coerced safely. */
export function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Keep a leading +, strip all other non-digits.
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d]/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  if (hasPlus) return `+${digits}`;
  // Bare 10-digit US number → assume +1; 11-digit starting with 1 → +<digits>.
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/** "+14155551234" → "+1 (•••) •••-1234" for display. */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/[^\d]/g, '');
  const last4 = digits.slice(-4);
  return `+1 (•••) •••-${last4}`;
}

/**
 * SMS delivery for Tracker alerts + phone verification (P1.1, ported from
 * apps/api/src/tracker/sms/sms.service.ts; env is read via process.env — intel-
 * api has no zod config module, same as IntelEmailService).
 *
 * Ships DORMANT: with TRACKER_SMS_PROVIDER unset/'none' (or no origination
 * number), send() is a logged no-op that returns { dormant: true } — the rest
 * of the pipeline (OTP verify, test-alert) runs end-to-end so flipping the
 * provider on (after carrier/10DLC provisioning) makes SMS live with no code
 * change. The AWS SNS path is lazily imported so @aws-sdk/client-sns is only
 * required once SMS is actually enabled.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  private provider(): string {
    return process.env.TRACKER_SMS_PROVIDER ?? 'none';
  }

  private originationNumber(): string {
    return process.env.TRACKER_SMS_ORIGINATION_NUMBER ?? '';
  }

  /** True when a provider AND origination number are configured (SMS live). */
  isConfigured(): boolean {
    return this.provider() !== 'none' && !!this.originationNumber();
  }

  async send(toE164: string, body: string): Promise<SmsSendResult> {
    const provider = this.provider();
    const from = this.originationNumber();

    if (provider === 'none' || !from) {
      this.logger.log(
        `[sms:dormant] would send to ${maskPhone(toE164)} (${body.length} chars) — ` +
          'SMS provider not configured (TRACKER_SMS_PROVIDER/ORIGINATION_NUMBER)',
      );
      return { sent: false, dormant: true };
    }

    if (provider === 'sns') {
      try {
        // Lazy, soft import: @aws-sdk/client-sns is NOT a baseline dependency
        // (SMS ships dormant). The string-typed specifier keeps the compiler
        // from resolving a module that may be absent until SMS is provisioned.
        const specifier = '@aws-sdk/client-sns';
        const mod = (await import(specifier as string).catch(() => null)) as {
          SNSClient: new (cfg: { region: string }) => {
            send: (cmd: unknown) => Promise<{ MessageId?: string }>;
          };
          PublishCommand: new (input: Record<string, unknown>) => unknown;
        } | null;
        if (!mod) {
          this.logger.error(
            'TRACKER_SMS_PROVIDER=sns but @aws-sdk/client-sns is not installed — staying dormant. ' +
              'Run `pnpm --filter @capiro/intel-api add @aws-sdk/client-sns` to enable SMS.',
          );
          return { sent: false, dormant: true, error: 'sns_sdk_missing' };
        }
        const region = process.env.AWS_REGION_DEFAULT ?? 'us-east-1';
        const client = new mod.SNSClient({ region });
        const res = await client.send(
          new mod.PublishCommand({
            PhoneNumber: toE164,
            Message: body,
            MessageAttributes: {
              'AWS.MM.SMS.OriginationNumber': { DataType: 'String', StringValue: from },
              'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
            },
          }),
        );
        return { sent: true, dormant: false, providerMessageId: res.MessageId };
      } catch (e) {
        this.logger.error(`SMS send failed: ${(e as Error).message}`);
        return { sent: false, dormant: false, error: (e as Error).message };
      }
    }

    return { sent: false, dormant: true };
  }
}
