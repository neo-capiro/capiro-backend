import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { OnboardLegalDoc } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LEGAL_DOC_SEEDS } from './legal-doc-seed.js';

export interface ActiveLegalDocs {
  tos: OnboardLegalDoc;
  sa: OnboardLegalDoc;
}

export interface ConsentAccept {
  docType: 'tos' | 'sa';
  version: string;
}

export interface RecordConsentsInput {
  sessionId: string;
  purchaserId: string;
  clerkUserId: string;
  /** Resolves which SA plan variant is the active one to validate against. */
  plan: 'trial' | 'paid';
  accepts: ConsentAccept[];
  ip: string | null;
  userAgent: string | null;
}

/**
 * Versioned legal documents + consent capture (Flow 1.5). The ToS is
 * plan-agnostic (planVariant 'all'); the SA has trial/paid variants with an
 * 'all' fallback. Consents are only recorded against the CURRENTLY ACTIVE
 * versions — accepting a stale version (doc rotated mid-funnel) is rejected
 * so the recorded consent always matches what the active document says.
 */
@Injectable()
export class LegalService {
  private readonly logger = new Logger(LegalService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getActiveDocs(plan: 'trial' | 'paid'): Promise<ActiveLegalDocs> {
    const [tos, saVariant, saAll] = await Promise.all([
      this.prisma.onboardLegalDoc.findFirst({
        where: { docType: 'tos', planVariant: 'all', active: true },
        orderBy: { effectiveAt: 'desc' },
      }),
      this.prisma.onboardLegalDoc.findFirst({
        where: { docType: 'sa', planVariant: plan, active: true },
        orderBy: { effectiveAt: 'desc' },
      }),
      this.prisma.onboardLegalDoc.findFirst({
        where: { docType: 'sa', planVariant: 'all', active: true },
        orderBy: { effectiveAt: 'desc' },
      }),
    ]);
    const sa = saVariant ?? saAll;
    if (!tos || !sa) {
      throw new ServiceUnavailableException(
        'Legal documents are not available yet — run the seed-legal-docs task.',
      );
    }
    return { tos, sa };
  }

  /**
   * Record the two consent rows (tos + sa) for a signup. Throws 400 when an
   * accepted version is not the active one, or when either doc is missing.
   */
  async recordConsents(input: RecordConsentsInput): Promise<void> {
    const active = await this.getActiveDocs(input.plan);
    const tosAccept = input.accepts.find((a) => a.docType === 'tos');
    const saAccept = input.accepts.find((a) => a.docType === 'sa');
    if (!tosAccept || !saAccept) {
      throw new BadRequestException(
        'Both the Terms of Service and the Subscription Agreement must be accepted.',
      );
    }
    if (tosAccept.version !== active.tos.version) {
      throw new BadRequestException(
        `The Terms of Service version you accepted (${tosAccept.version}) is no longer current — reload the legal step.`,
      );
    }
    if (saAccept.version !== active.sa.version) {
      throw new BadRequestException(
        `The Subscription Agreement version you accepted (${saAccept.version}) is no longer current — reload the legal step.`,
      );
    }

    // Idempotent per (sessionId, docType, docVersion): the Back button lets a
    // user revisit /legal and re-submit — re-accepts must not append duplicate
    // rows to the SOC 2 consent-evidence table.
    const existing = await this.prisma.onboardConsent.findMany({
      where: { sessionId: input.sessionId, docType: { in: ['tos', 'sa'] } },
      select: { docType: true, docVersion: true },
    });
    const already = new Set(existing.map((r) => `${r.docType}:${r.docVersion}`));
    const rows = (['tos', 'sa'] as const)
      .map((docType) => ({
        sessionId: input.sessionId,
        purchaserId: input.purchaserId,
        clerkUserId: input.clerkUserId,
        docType,
        docVersion: docType === 'tos' ? active.tos.version : active.sa.version,
        ip: input.ip,
        userAgent: input.userAgent,
      }))
      .filter((r) => !already.has(`${r.docType}:${r.docVersion}`));
    if (rows.length > 0) {
      await this.prisma.onboardConsent.createMany({ data: rows });
    }
  }

  /**
   * Upsert the COUNSEL-PENDING draft ToS/SA (see legal-doc-seed.ts), marking
   * the seeded version active and de-activating any other version of the same
   * (docType, planVariant). Idempotent — safe to re-run on every deploy.
   */
  async seedDraftDocs(): Promise<
    Array<{ id: string; docType: string; planVariant: string; version: string }>
  > {
    const results: Array<{ id: string; docType: string; planVariant: string; version: string }> =
      [];
    for (const seed of LEGAL_DOC_SEEDS) {
      const row = await this.prisma.$transaction(async (tx) => {
        const doc = await tx.onboardLegalDoc.upsert({
          where: {
            docType_planVariant_version: {
              docType: seed.docType,
              planVariant: seed.planVariant,
              version: seed.version,
            },
          },
          create: {
            docType: seed.docType,
            planVariant: seed.planVariant,
            version: seed.version,
            html: seed.html,
            active: true,
          },
          update: { html: seed.html, active: true },
        });
        await tx.onboardLegalDoc.updateMany({
          where: {
            docType: seed.docType,
            planVariant: seed.planVariant,
            version: { not: seed.version },
            active: true,
          },
          data: { active: false },
        });
        return doc;
      });
      this.logger.log(
        `Seeded legal doc ${row.docType}/${row.planVariant} version ${row.version} (active)`,
      );
      results.push({
        id: row.id,
        docType: row.docType,
        planVariant: row.planVariant,
        version: row.version,
      });
    }
    return results;
  }
}
