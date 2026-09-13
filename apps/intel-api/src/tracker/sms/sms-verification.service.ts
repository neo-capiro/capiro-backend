import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import { SmsService, maskPhone, normalizeE164 } from './sms.service.js';

const OTP_TTL_MS = 10 * 60_000;
export type SmsPurpose = 'tracker_alerts' | 'hearing_updates' | 'hearing_records';
export const RECORD_SMS_CONSENT_VERSION = 'hearing-record-briefs-v1';
export const RECORD_SMS_CONSENT_TEXT =
  'I agree to receive reviewed Capiro briefs based on published legislative records and related corrections for this client at this number. Message frequency varies. Message and data rates may apply. Reply STOP to opt out.';
export const HEARING_SMS_CONSENT_VERSION = 'hearing-updates-v1';
export const HEARING_SMS_CONSENT_TEXT =
  'I agree to receive reviewed, unofficial Capiro hearing updates for this client at this number. Message frequency varies. Message and data rates may apply. Reply STOP to opt out.';

export function hashCode(code: string, phone: string, scope = ''): string {
  return createHash('sha256')
    .update(JSON.stringify([scope, phone, code]))
    .digest('hex');
}

/** Existing verification flow with atomic, purpose-bound consumption. */
@Injectable()
export class SmsVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
  ) {}

  private async client(tx: Prisma.TransactionClient, tenantId: string, clientId: string | null) {
    if (!clientId || !/^[0-9a-f-]{36}$/i.test(clientId))
      throw new NotFoundException('Client not found');
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id::text FROM clients WHERE tenant_id=${tenantId}::uuid AND id=${clientId}::uuid`;
    if (!rows.length) throw new NotFoundException('Client not found');
    return clientId;
  }
  private scope(tenant: string, user: string, client: string, purpose: SmsPurpose) {
    return JSON.stringify([tenant, user, client, purpose]);
  }

  async startVerification(
    tenantId: string,
    userId: string,
    clientId: string | null,
    rawPhone: string,
    purpose: SmsPurpose = 'tracker_alerts',
    consentVersion?: string,
    contactId?: string,
  ): Promise<{ dormant: boolean; masked: string; devCode?: string }> {
    const phone = normalizeE164(rawPhone);
    if (!phone) throw new BadRequestException('Enter a valid E.164 phone number');
    if (!['tracker_alerts', 'hearing_updates', 'hearing_records'].includes(purpose))
      throw new BadRequestException('Invalid verification purpose');
    if (purpose === 'hearing_updates' && consentVersion !== HEARING_SMS_CONSENT_VERSION)
      throw new BadRequestException('Review and accept the hearing SMS consent statement');
    if (purpose === 'hearing_records' && consentVersion !== RECORD_SMS_CONSENT_VERSION)
      throw new BadRequestException(
        'Review and accept the published-record brief SMS consent statement',
      );
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const row = await this.prisma.withTenant(tenantId, async (tx) => {
      const client = await this.client(tx, tenantId, clientId);
      if (purpose !== 'tracker_alerts') {
        const contact = contactId
          ? await tx.legiWatchReportContact.findFirst({
              where: {
                tenantId,
                id: contactId,
                active: true,
                optedOut: false,
                ownerClerkId: userId,
              },
            })
          : null;
        if (!contact) throw new NotFoundException('An active, owned directory contact is required');
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':sms:' + userId},0))`;
      const recent = await tx.intelSmsVerification.findMany({
        where: { tenantId, userId, createdAt: { gte: new Date(Date.now() - 3600_000) } },
        orderBy: { createdAt: 'desc' },
        take: 6,
      });
      if (
        recent.length >= 5 ||
        recent.some((r) => r.phone === phone && r.createdAt.getTime() > Date.now() - 60_000)
      )
        throw new BadRequestException('Verification request limit reached; try again later');
      await tx.intelSmsVerification.updateMany({
        where: { tenantId, userId, clientId: client, phone, purpose, consumed: false },
        data: { consumed: true },
      });
      return tx.intelSmsVerification.create({
        data: {
          tenantId,
          userId,
          clientId: client,
          phone,
          purpose,
          consentVersion,
          contactId,
          codeHash: hashCode(code, phone, this.scope(tenantId, userId, client, purpose)),
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
        },
      });
    });
    const result = await this.sms.send(
      phone,
      `Your Capiro ${purpose === 'hearing_updates' ? 'hearing updates ' : ''}verification code is ${code}. It expires in 10 minutes. Reply STOP to opt out.`,
    );
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelSmsVerification.updateMany({
        where: { tenantId, id: row.id },
        data: { providerAccepted: result.sent && Boolean(result.providerMessageId) },
      }),
    );
    // An undelivered code never establishes receipt or hearing consent.
    return { dormant: result.dormant, masked: maskPhone(phone) };
  }

  async confirmVerification(
    tenantId: string,
    userId: string,
    rawPhone: string,
    code: string,
    clientId: string | null = null,
    purpose: SmsPurpose = 'tracker_alerts',
  ): Promise<{ verified: true; phone: string }> {
    const phone = normalizeE164(rawPhone);
    if (!phone || !/^\d{6}$/.test(code ?? ''))
      throw new BadRequestException('Enter the phone number and six-digit code');
    const result = await this.prisma.withTenant(tenantId, async (tx) => {
      const client = await this.client(tx, tenantId, clientId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':sms:' + userId},0))`;
      const row = await tx.intelSmsVerification.findFirst({
        where: { tenantId, userId, clientId: client, phone, purpose, consumed: false },
        orderBy: { createdAt: 'desc' },
      });
      if (
        !row ||
        !row.providerAccepted ||
        row.expiresAt.getTime() <= Date.now() ||
        row.attempts >= 5
      )
        return false;
      const expected = Buffer.from(row.codeHash, 'hex'),
        provided = Buffer.from(
          hashCode(code, phone, this.scope(tenantId, userId, client, purpose)),
          'hex',
        );
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        await tx.intelSmsVerification.updateMany({
          where: { tenantId, id: row.id, consumed: false },
          data: { attempts: { increment: 1 } },
        });
        return false;
      }
      const consumed = await tx.intelSmsVerification.updateMany({
        where: { tenantId, id: row.id, consumed: false, attempts: { lt: 5 } },
        data: { consumed: true, confirmedAt: new Date() },
      });
      if (consumed.count !== 1) return false;
      if (purpose !== 'tracker_alerts') {
        if (
          row.consentVersion !==
            (purpose === 'hearing_records'
              ? RECORD_SMS_CONSENT_VERSION
              : HEARING_SMS_CONSENT_VERSION) ||
          !row.contactId
        )
          return false;
        const contact = await tx.legiWatchReportContact.updateMany({
          where: {
            tenantId,
            id: row.contactId,
            active: true,
            optedOut: false,
            ownerClerkId: userId,
          },
          data: { phone, version: { increment: 1 } },
        });
        if (contact.count !== 1) return false;
        await tx.hearingSmsConsent.upsert({
          where: {
            tenantId_userId_clientId_phone_purpose: {
              tenantId,
              userId,
              clientId: client,
              phone,
              purpose,
            },
          },
          create: {
            tenantId,
            userId,
            clientId: client,
            phone,
            purpose,
            contactId: row.contactId,
            verificationId: row.id,
            consentVersion: row.consentVersion,
          },
          update: {
            contactId: row.contactId,
            verificationId: row.id,
            consentVersion: row.consentVersion,
            consentedAt: new Date(),
            revokedAt: null,
          },
        });
      }
      return true;
    });
    if (!result)
      throw new BadRequestException(
        'Code is incorrect, expired, unavailable, or already consumed; request a new code',
      );
    return { verified: true, phone };
  }
}
