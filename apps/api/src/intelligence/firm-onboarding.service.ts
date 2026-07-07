import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CLIENT_SLOT_LIMIT_CODE, type TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientPrepopulationService } from './client-prepopulation.service.js';
import { SamEntityEnrichmentService } from './sam-entity.service.js';

/**
 * Firm-registrant onboarding + "import your clients" (Phase 2 of the client→data
 * association overhaul).
 *
 * A tenant IS a lobbying firm. Once it identifies its Senate LDA registrant
 * (tenants.lda_registrant_id), its real client list is knowable directly from
 * that registrant's filings — so onboarding inverts from "type a name and hope
 * the matcher finds it" to "pick from your actual filed clients", with the stable
 * lda client_id pinned on import (no fuzzy matching).
 */
export interface RegistrantHit {
  id: number;
  name: string;
  city: string | null;
  state: string | null;
  totalClients: number;
  totalFilings: number;
}

export interface ImportCandidate {
  ldaClientId: number;
  name: string;
  filings: number;
  latestFilingYear: number | null;
  totalSpend: number;
  /** Non-null when a Client in this tenant already carries this id. */
  onboardedAs: string | null;
}

@Injectable()
export class FirmOnboardingService {
  private readonly logger = new Logger(FirmOnboardingService.name);
  // Same enforcement switch as ClientsService: the LDA import previously
  // bypassed the client-slot cap entirely (onboarding-v1 audit finding) — a
  // tenant could import an unlimited portfolio around the 402 gate.
  private readonly billingEnforced: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly prepopulation: ClientPrepopulationService,
    private readonly samEntity: SamEntityEnrichmentService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.billingEnforced = config.get('BILLING_ENFORCED', { infer: true });
  }

  /** Trigram search over LDA registrants so a firm can find itself. */
  async searchRegistrants(q: string): Promise<RegistrantHit[]> {
    const term = q.trim();
    if (term.length < 2) return [];
    return this.prisma.$queryRaw<RegistrantHit[]>`
      SELECT id, name, city, state,
             total_clients AS "totalClients",
             total_filings AS "totalFilings"
      FROM lda_registrant
      WHERE similarity(name, ${term}) > 0.2
      ORDER BY similarity(name, ${term}) DESC, total_filings DESC
      LIMIT 20
    `;
  }

  async getTenantRegistrant(
    ctx: TenantContext,
  ): Promise<{ ldaRegistrantId: number | null; ldaRegistrantName: string | null }> {
    const tenant = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { ldaRegistrantId: true, ldaRegistrantName: true },
      }),
    );
    return {
      ldaRegistrantId: tenant?.ldaRegistrantId ?? null,
      ldaRegistrantName: tenant?.ldaRegistrantName ?? null,
    };
  }

  /** Set (or change) the firm's LDA registrant. Validates the id exists. */
  async setTenantRegistrant(ctx: TenantContext, registrantId: number) {
    const reg = await this.prisma.ldaRegistrant.findUnique({
      where: { id: registrantId },
      select: { name: true },
    });
    if (!reg) throw new NotFoundException(`LDA registrant ${registrantId} not found`);

    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.tenant.update({
        where: { id: ctx.tenantId },
        data: { ldaRegistrantId: registrantId, ldaRegistrantName: reg.name },
      }),
    );
    return { ldaRegistrantId: registrantId, ldaRegistrantName: reg.name };
  }

  /**
   * The firm's actual clients (distinct lda_filing.client_id under its
   * registrant), with spend + recency for ranking and an `onboardedAs` flag so
   * the UI can show which are already imported.
   */
  async listImportCandidates(ctx: TenantContext): Promise<{
    registrantId: number | null;
    registrantName: string | null;
    candidates: ImportCandidate[];
  }> {
    const { ldaRegistrantId, ldaRegistrantName } = await this.getTenantRegistrant(ctx);
    if (ldaRegistrantId == null) {
      return { registrantId: null, registrantName: null, candidates: [] };
    }

    const grouped = await this.prisma.ldaFiling.groupBy({
      by: ['clientId', 'clientName'],
      where: { registrantId: ldaRegistrantId, clientId: { not: null }, clientName: { not: '' } },
      _sum: { income: true, expenses: true },
      _max: { filingYear: true },
      _count: { _all: true },
    });

    const existing = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findMany({ select: { name: true, ldaClientIds: true } }),
    );
    const onboarded = new Map<number, string>();
    for (const c of existing) for (const id of c.ldaClientIds) onboarded.set(id, c.name);

    const candidates: ImportCandidate[] = grouped
      .filter((g) => g.clientId != null)
      .map((g) => ({
        ldaClientId: g.clientId as number,
        name: g.clientName,
        filings: g._count._all,
        latestFilingYear: g._max.filingYear ?? null,
        totalSpend: Number(g._sum.income ?? 0) + Number(g._sum.expenses ?? 0),
        onboardedAs: onboarded.get(g.clientId as number) ?? null,
      }))
      .sort((a, b) => b.totalSpend - a.totalSpend);

    return { registrantId: ldaRegistrantId, registrantName: ldaRegistrantName, candidates };
  }

  /**
   * Create Client records from selected LDA client_ids — with the id pinned
   * (clients.lda_client_ids + a confirmed source='lda' mapping) and basic
   * profile fields seeded from lda_client. Guards: each id must belong to the
   * tenant's own registrant, and an id already onboarded is skipped (idempotent).
   */
  async importClients(ctx: TenantContext, ldaClientIds: number[]) {
    const ids = Array.from(new Set(ldaClientIds)).filter((n) => Number.isInteger(n));
    if (ids.length === 0) throw new BadRequestException('No LDA client ids provided');

    const { ldaRegistrantId } = await this.getTenantRegistrant(ctx);
    if (ldaRegistrantId == null) {
      throw new BadRequestException('Set your firm (LDA registrant) before importing clients');
    }

    // Client-slot cap (mirrors ClientsService.create): already at/over the
    // limit → 402 up front. Mid-batch cap hits are reported per-row instead
    // (see the in-transaction check below) so partial imports stay usable.
    const slotGate = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { billingStatus: true, clientSlots: true },
      });
      const current = await tx.client.count({ where: { status: { not: 'archived' } } });
      return { tenant, current };
    });
    const slotsEnforced =
      this.billingEnforced && slotGate.tenant && slotGate.tenant.billingStatus !== 'comped';
    if (slotsEnforced && slotGate.current >= slotGate.tenant!.clientSlots) {
      throw new HttpException(
        {
          code: CLIENT_SLOT_LIMIT_CODE,
          message: `You've used all ${slotGate.tenant!.clientSlots} client slots.`,
          limit: slotGate.tenant!.clientSlots,
          current: slotGate.current,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // Only allow importing the firm's OWN clients (not arbitrary global ids).
    const ownRows = await this.prisma.ldaFiling.findMany({
      where: { registrantId: ldaRegistrantId, clientId: { in: ids } },
      select: { clientId: true },
      distinct: ['clientId'],
    });
    const ownIds = new Set(ownRows.map((r) => r.clientId).filter((v): v is number => v != null));

    const ldaClients = await this.prisma.ldaClient.findMany({ where: { id: { in: ids } } });
    const byId = new Map(ldaClients.map((c) => [c.id, c]));

    const created: Array<{ id: string; name: string; ldaClientId: number }> = [];
    const skipped: Array<{ ldaClientId: number; reason: string }> = [];

    for (const id of ids) {
      if (!ownIds.has(id)) {
        skipped.push({ ldaClientId: id, reason: 'not a client of your firm' });
        continue;
      }
      const lc = byId.get(id);
      if (!lc) {
        skipped.push({ ldaClientId: id, reason: 'LDA client record not found' });
        continue;
      }
      try {
        const result = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
          // Serialize concurrent imports of the same (tenant, lda id): the
          // check-then-create dup guard below is not atomic, so a double-click /
          // retry could otherwise create two Clients pinned to the same id. A
          // per-(tenant,id) advisory xact lock makes the second request observe
          // the first's committed row and skip it.
          await tx.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtextextended($1, 0::int8))`,
            `${ctx.tenantId}:lda:${id}`,
          );
          const dup = await tx.client.findFirst({
            where: { ldaClientIds: { has: id } },
            select: { name: true },
          });
          if (dup) return { dup: dup.name };
          if (slotsEnforced) {
            // Re-count inside the row transaction so a batch stops exactly at
            // the cap instead of overshooting.
            const count = await tx.client.count({ where: { status: { not: 'archived' } } });
            if (count >= slotGate.tenant!.clientSlots) {
              return { capped: slotGate.tenant!.clientSlots };
            }
          }
          const client = await tx.client.create({
            data: {
              tenantId: ctx.tenantId,
              name: lc.name,
              description: lc.generalDescription ?? null,
              issueCodes: lc.issueCodes ?? [],
              ldaClientIds: [id],
              intakeData: {
                state: lc.state ?? null,
                importedFromLda: { registrantId: ldaRegistrantId, ldaClientId: id },
              } as object,
              createdByUserId: ctx.userId,
            },
            select: { id: true, name: true },
          });
          // The confirmed mapping is the source of truth; clients.lda_client_ids is
          // its denormalized cache. client_intel_mapping is RLS-scoped (tenant_id
          // required); this create runs inside withTenant(ctx.tenantId).
          await tx.clientIntelMapping.create({
            data: {
              tenantId: ctx.tenantId,
              clientId: client.id,
              source: 'lda',
              externalId: String(id),
              externalName: lc.name,
              confidence: 1,
              confirmed: true,
            },
          });
          return { client };
        });

        if ('dup' in result) {
          skipped.push({ ldaClientId: id, reason: `already onboarded as "${result.dup}"` });
        } else if ('capped' in result) {
          skipped.push({
            ldaClientId: id,
            reason: `${CLIENT_SLOT_LIMIT_CODE}: client slot limit (${result.capped}) reached`,
          });
        } else {
          created.push({ id: result.client.id, name: result.client.name, ldaClientId: id });
          // Layer in LDA-derived signals + union issue codes (idempotent). Never
          // fails the import row.
          await this.prepopulation
            .prepopulate(ctx.tenantId, result.client.id)
            .catch((e: unknown) =>
              this.logger.warn(
                `prepopulate after import failed for ${result.client.id}: ${e instanceof Error ? e.message : String(e)}`,
              ),
            );
          // SAM gov-id enrichment is network-bound; fire-and-forget (NOT awaited)
          // so a multi-client import doesn't serialize one SAM round-trip per
          // client into the request. Fill-if-empty, fail-safe.
          void this.samEntity
            .enrichGovIds(ctx.tenantId, result.client.id)
            .catch((e: unknown) =>
              this.logger.warn(
                `gov-id enrichment after import failed for ${result.client.id}: ${e instanceof Error ? e.message : String(e)}`,
              ),
            );
        }
      } catch (err) {
        skipped.push({ ldaClientId: id, reason: (err as Error).message ?? 'error' });
      }
    }

    this.logger.log(
      `importClients(${ctx.tenantId}): ${created.length} created, ${skipped.length} skipped`,
    );
    return { created: created.length, items: created, skipped };
  }
}
