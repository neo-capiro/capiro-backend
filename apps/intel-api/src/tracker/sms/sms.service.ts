import { Injectable } from '@nestjs/common';
import {
  SNSClient,
  PublishCommand,
  CheckIfPhoneNumberIsOptedOutCommand,
} from '@aws-sdk/client-sns';

export interface SmsSendResult {
  /** Provider acceptance only; handset receipt requires delivery-status evidence. */
  sent: boolean;
  dormant: boolean;
  providerMessageId?: string;
  error?: string;
  uncertain?: boolean;
  suppressed?: boolean;
  segments?: number;
}
export function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, '');
  const phone = value.startsWith('+')
    ? '+' + digits
    : digits.length === 10
      ? '+1' + digits
      : digits.length === 11 && digits.startsWith('1')
        ? '+' + digits
        : null;
  return phone && /^\+[1-9]\d{9,14}$/.test(phone) ? phone : null;
}
export function maskPhone(phone: string) {
  return `••• ••• ${phone.slice(-4)}`;
}
const GSM_BASIC = new Set(
  Array.from(
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ),
);
const GSM_EXTENDED = new Set(Array.from('\f^{}\\[~]|€'));
export function smsSize(body: string): {
  encoding: 'GSM-7' | 'UCS-2';
  units: number;
  segments: number;
} {
  const chars = Array.from(body),
    gsm = chars.every((c) => GSM_BASIC.has(c) || GSM_EXTENDED.has(c));
  const widths = chars.map((c) => (gsm ? (GSM_EXTENDED.has(c) ? 2 : 1) : c.length));
  const units = widths.reduce((a, b) => a + b, 0),
    single = gsm ? 160 : 70,
    multi = gsm ? 153 : 67;
  if (units <= single) return { encoding: gsm ? 'GSM-7' : 'UCS-2', units, segments: units ? 1 : 0 };
  let segments = 1,
    used = 0;
  for (const width of widths) {
    if (used + width > multi) {
      segments++;
      used = 0;
    }
    used += width;
  }
  return { encoding: gsm ? 'GSM-7' : 'UCS-2', units, segments };
}

/** Existing SNS transport; publication workers retain lease/uncertain-send ownership. */
@Injectable()
export class SmsService {
  private client: SNSClient | undefined;
  private sns() {
    return (this.client ??= new SNSClient({
      region: process.env.AWS_REGION_DEFAULT ?? 'us-east-1',
      maxAttempts: 1,
    }));
  }
  isConfigured() {
    return (
      process.env.TRACKER_SMS_PROVIDER === 'sns' &&
      Boolean(normalizeE164(process.env.TRACKER_SMS_ORIGINATION_NUMBER))
    );
  }
  async optedOut(phone: string): Promise<boolean> {
    if (!this.isConfigured()) throw new Error('SMS provider is dormant');
    const result = await this.sns().send(
      new CheckIfPhoneNumberIsOptedOutCommand({ phoneNumber: phone }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
    if (typeof result.isOptedOut !== 'boolean')
      throw new Error('SMS suppression status unavailable');
    return result.isOptedOut;
  }
  async send(toE164: string, body: string): Promise<SmsSendResult> {
    const size = smsSize(body);
    if (normalizeE164(toE164) !== toE164 || !size.segments || size.segments > 3)
      return {
        sent: false,
        dormant: false,
        error: 'invalid_sms_or_segment_limit',
        segments: size.segments,
      };
    if (!this.isConfigured())
      return { sent: false, dormant: true, error: 'sms_provider_dormant', segments: size.segments };
    try {
      if (await this.optedOut(toE164))
        return {
          sent: false,
          dormant: false,
          suppressed: true,
          error: 'phone_opted_out',
          segments: size.segments,
        };
    } catch {
      return {
        sent: false,
        dormant: false,
        error: 'suppression_check_unavailable',
        segments: size.segments,
      };
    }
    try {
      const result = await this.sns().send(
        new PublishCommand({
          PhoneNumber: toE164,
          Message: body,
          MessageAttributes: {
            'AWS.MM.SMS.OriginationNumber': {
              DataType: 'String',
              StringValue: process.env.TRACKER_SMS_ORIGINATION_NUMBER!,
            },
            'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
          },
        }),
        { abortSignal: AbortSignal.timeout(8000) },
      );
      if (!result.MessageId)
        return {
          sent: false,
          dormant: false,
          uncertain: true,
          error: 'provider_acceptance_unknown',
          segments: size.segments,
        };
      return {
        sent: true,
        dormant: false,
        providerMessageId: result.MessageId,
        segments: size.segments,
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      // Never retry a publish whose acceptance is uncertain.
      return {
        sent: false,
        dormant: false,
        uncertain: !(status && status >= 400 && status < 500),
        error: 'sns_publish_failed',
        segments: size.segments,
      };
    }
  }
}
