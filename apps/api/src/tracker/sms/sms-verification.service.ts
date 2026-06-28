import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/config.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SmsService, maskPhone, normalizeE164 } from './sms.service.js';

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

function hashCode(code: string, phone: string): string {
  return createHash('sha256').update(`${code}:${phone}`).digest('hex');
}

/**
 * One-time SMS phone verification (the consent step for the SMS channel).
 * The OTP is stored hashed; the verify step is the opt-in record. Works in
 * dormant SMS mode too — non-prod returns the code inline so the flow is
 * testable before a carrier number is provisioned.
 */
@Injectable()
export class SmsVerificationService {
  private readonly logger = new Logger(SmsVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async startVerification(
    tenantId: string,
    userId: string,
    clientId: string | null,
    rawPhone: string,
  ): Promise<{ dormant: boolean; masked: string; devCode?: string }> {
    const phone = normalizeE164(rawPhone);
    if (!phone) {
      throw new BadRequestException('Enter a valid phone number in E.164 form, e.g. +14155551234');
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = hashCode(code, phone);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await this.prisma.withTenant(tenantId, (tx) =>
      tx.smsVerification.create({
        data: { tenantId, userId, clientId: clientId ?? null, phone, codeHash, expiresAt },
      }),
    );

    const result = await this.sms.send(
      phone,
      `Your Capiro verification code is ${code}. It expires in 10 minutes.`,
    );

    // In non-prod, surface the code even when SMS is dormant so the verify flow
    // is end-to-end testable before a number is provisioned. Never in production.
    const isProd = this.config.get('NODE_ENV', { infer: true }) === 'production';
    const devCode = !isProd && (result.dormant || !result.sent) ? code : undefined;

    return { dormant: result.dormant, masked: maskPhone(phone), devCode };
  }

  async confirmVerification(
    tenantId: string,
    userId: string,
    rawPhone: string,
    code: string,
  ): Promise<{ verified: true; phone: string }> {
    const phone = normalizeE164(rawPhone);
    if (!phone) throw new BadRequestException('Invalid phone number');
    const cleanCode = (code ?? '').replace(/[^\d]/g, '');
    if (cleanCode.length !== 6) throw new BadRequestException('Enter the 6-digit code');

    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.smsVerification.findFirst({
        where: { userId, phone, consumed: false },
        orderBy: { createdAt: 'desc' },
      }),
    );
    if (!row) throw new BadRequestException('No pending verification — request a new code');
    if (row.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('That code expired — request a new one');
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      throw new BadRequestException('Too many attempts — request a new code');
    }
    if (row.codeHash !== hashCode(cleanCode, phone)) {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.smsVerification.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } }),
      );
      throw new BadRequestException('Incorrect code');
    }
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.smsVerification.update({ where: { id: row.id }, data: { consumed: true } }),
    );
    return { verified: true, phone };
  }
}
