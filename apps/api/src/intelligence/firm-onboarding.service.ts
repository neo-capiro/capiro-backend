import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { CLIENT_SLOT_LIMIT_CODE, type TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientPrepopulationService } from './client-prepopulation.service.js';
import { SamEntityEnrichmentService } from './sam-entity.service.js';
import { requireClientCapacity } from '../clients/client-capacity.js';
import { FirmImportJobStore } from './firm-import-job.store.js';
import {
  importItemReason,
  normalizeImportSelection,
  type FirmImportItemCode,
  type ImportChunkJobSummary,
  type ImportJobView,
} from './firm-import-job.contracts.js';

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
    private readonly importJobs: FirmImportJobStore,
    config: ConfigService<AppConfig, true>,
  ) {
    this.billingEnforced = config.get('BILLING_ENFORCED', { infer: true });
  }

  /**
   * Find a firm among LDA registrants. Ranked so the DISTINCTIVE tokens
   * matter, not a shared common word:
   *   1. exact / prefix / substring match on the full query (a firm typing its
   *      own name lands at the top),
   *   2. word_similarity — how well the query matches a run of words in the
   *      name (order/extra-token tolerant),
   *   3. whole-string similarity, then filing volume as a tiebreak.
   * The old query used only `similarity(name, term) > 0.2`, which for a
   * multi-word query like "maven advocacy partners" flooded the list with
   * unrelated "* ADVOCACY" firms (the common word dominated the trigram score)
   * and buried/omitted the real match. The stricter gate below returns few or
   * zero rows when the firm isn't in the LDA data — the correct cue to add
   * clients manually instead.
   */
  async searchRegistrants(q: string): Promise<RegistrantHit[]> {
    const term = q.trim();
    if (term.length < 2) return [];
    return this.prisma.$queryRaw<RegistrantHit[]>`
      SELECT id, name, city, state,
             total_clients AS "totalClients",
             total_filings AS "totalFilings"
      FROM lda_registrant
      WHERE name ILIKE '%' || ${term} || '%'
         OR word_similarity(${term}, name) >= 0.5
         OR similarity(name, ${term}) >= 0.45
      ORDER BY
        (name ILIKE ${term}) DESC,
        (name ILIKE ${term} || '%') DESC,
        (name ILIKE '%' || ${term} || '%') DESC,
        word_similarity(${term}, name) DESC,
        similarity(name, ${term}) DESC,
        total_filings DESC
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

  /** Tenant-scoped paged jobs with full-population status counts. */
  listImportJobs(ctx: TenantContext, options: Parameters<FirmImportJobStore['listJobs']>[1] = {}) {
    return this.importJobs.listJobs(ctx, options);
  }

  getImportJob(ctx: TenantContext, jobId: string) {
    return this.importJobs.getJob(ctx, jobId);
  }

  /**
   * Status-only projection. Staleness is an operator-attention signal, never
   * proof of failure or completion; outstanding items stay explicitly unresolved.
   */
  async getImportJobStatus(ctx: TenantContext, jobId: string) {
    const job = await this.importJobs.getJob(ctx, jobId);
    return {
      id: job.id,
      requestId: job.requestId,
      status: job.status,
      terminal: job.terminal,
      stale: job.stale,
      staleAfterSeconds: job.staleAfterSeconds,
      counts: {
        total: job.total,
        processed: job.processed,
        successful: job.successful,
        rejected: job.rejected,
        outstanding: job.outstanding,
        created: job.created,
        alreadyPresent: job.alreadyPresent,
      },
      unresolved: job.items
        .filter((item) => item.outcome === 'pending')
        .map((item) => item.ldaClientId),
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  /**
   * Create Client records from selected LDA client_ids — with the id pinned
   * (clients.lda_client_ids + a confirmed source='lda' mapping) and basic
   * profile fields seeded from lda_client. Guards: each id must belong to the
   * tenant's own registrant, and an id already onboarded is skipped (idempotent).
   *
   * Durable view: the request is bound to a job keyed by the caller's stable
   * requestId (or a server UUID for legacy callers), item identities are
   * persisted before any client work, and every item outcome is written in the
   * same transaction as its Client/mapping effect. Nothing here queues work or
   * retries: the operator inspects/reconciles the persisted job.
   */
  async importClients(
    ctx: TenantContext,
    ldaClientIds: number[],
    options: { requestId?: string } = {},
  ): Promise<{
    created: number;
    items: Array<{ id: string; name: string; ldaClientId: number }>;
    skipped: Array<{ ldaClientId: number; reason: string }>;
    job: ImportChunkJobSummary;
  }> {
    const ids = normalizeImportSelection(ldaClientIds);
    if (ids.length === 0) throw new BadRequestException('No LDA client ids provided');

    const { ldaRegistrantId } = await this.getTenantRegistrant(ctx);
    if (ldaRegistrantId == null) {
      throw new BadRequestException('Set your firm (LDA registrant) before importing clients');
    }

    // Client-slot cap (mirrors ClientsService.create): already at/over the
    // limit → 402 up front. Mid-batch cap hits are reported per-row instead
    // (see the in-transaction check below) so partial imports stay usable.
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      requireClientCapacity(tx, ctx.tenantId, this.billingEnforced),
    );

    const { job, created: started } = await this.importJobs.createOrReconcile(ctx, {
      requestKey: options.requestId ?? randomUUID(),
      ldaRegistrantId,
      ids,
    });
    // Same request identity + same exact selection reconciles the existing job.
    // An interrupted response is read back from durable outcomes, never re-run.
    if (!started) return this.importResult(job);

    await this.importJobs.markRunning(ctx, job.id);

    // Only allow importing the firm's OWN clients (not arbitrary global ids).
    const ownRows = await this.prisma.ldaFiling.findMany({
      where: { registrantId: ldaRegistrantId, clientId: { in: ids } },
      select: { clientId: true },
      distinct: ['clientId'],
    });
    const ownIds = new Set(ownRows.map((r) => r.clientId).filter((v): v is number => v != null));

    const ldaClients = await this.prisma.ldaClient.findMany({ where: { id: { in: ids } } });
    const byId = new Map(ldaClients.map((c) => [c.id, c]));

    const recordRejected = (ldaClientId: number, code: FirmImportItemCode) =>
      this.prisma.withTenant(ctx.tenantId, (tx) =>
        this.importJobs.markItemOutcome(tx, {
          tenantId: ctx.tenantId,
          jobId: job.id,
          ldaClientId,
          outcome: 'rejected',
          code,
        }),
      );

    for (const id of ids) {
      if (!ownIds.has(id)) {
        await recordRejected(id, 'NOT_OWN_CLIENT');
        continue;
      }
      const lc = byId.get(id);
      if (!lc) {
        await recordRejected(id, 'LDA_CLIENT_NOT_FOUND');
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
            select: { id: true },
          });
          if (dup) {
            await this.importJobs.markItemOutcome(tx, {
              tenantId: ctx.tenantId,
              jobId: job.id,
              ldaClientId: id,
              outcome: 'already_present',
              clientId: dup.id,
            });
            return { dup: true as const };
          }
          try {
            await requireClientCapacity(tx, ctx.tenantId, this.billingEnforced);
          } catch (error) {
            const response = error instanceof HttpException ? error.getResponse() : null;
            if (
              response &&
              typeof response === 'object' &&
              'code' in response &&
              response.code === CLIENT_SLOT_LIMIT_CODE
            )
              return {
                capped: 'limit' in response ? Number(response.limit) : null,
              };
            throw error;
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
          // SAME transaction as the Client+mapping effect: a committed Client can
          // never be followed by a lost success record.
          await this.importJobs.markItemOutcome(tx, {
            tenantId: ctx.tenantId,
            jobId: job.id,
            ldaClientId: id,
            outcome: 'created',
            clientId: client.id,
          });
          return { client };
        });

        if ('dup' in result) {
          continue; // already_present persisted inside the transaction
        }
        if ('capped' in result) {
          await recordRejected(id, 'CLIENT_SLOT_LIMIT');
          continue;
        }
        // Layer in LDA-derived signals + union issue codes (idempotent). Never
        // fails the import row and is never an import-job completion signal.
        await this.prepopulation
          .prepopulate(ctx.tenantId, result.client.id)
          .catch((e: unknown) =>
            this.logger.warn(
              `prepopulate after import failed for ${result.client.id}: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        // SAM gov-id enrichment is network-bound; fire-and-forget (NOT awaited)
        // so a multi-client import doesn't serialize one SAM round-trip per
        // client into the request. Fill-if-empty, fail-safe, and NOT evidence of
        // import-job completion.
        void this.samEntity
          .enrichGovIds(ctx.tenantId, result.client.id)
          .catch((e: unknown) =>
            this.logger.warn(
              `gov-id enrichment after import failed for ${result.client.id}: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
      } catch (err) {
        // Closed code only: raw provider/SQL text never reaches the job row.
        this.logger.warn(
          `import item failed (job ${job.id}, lda ${id}): ${err instanceof Error ? err.message : 'unknown'}`,
        );
        await recordRejected(id, 'INTERNAL_ERROR');
      }
    }

    // Status/finishedAt were written atomically with the last item outcome, so
    // this read is already authoritative; there is no post-commit finalize step.
    const finalJob = await this.importJobs.getJob(ctx, job.id);

    this.logger.log(
      `importClients(${ctx.tenantId}, job ${job.id}): ${finalJob.created} created, ` +
        `${finalJob.alreadyPresent} already present, ${finalJob.rejected} rejected, ` +
        `${finalJob.outstanding} outstanding`,
    );
    return this.importResult(finalJob);
  }

  /** Legacy {created,items,skipped} shape plus the additive job summary. */
  private importResult(job: ImportJobView) {
    const items = job.items
      .filter((item) => item.outcome === 'created' && item.clientId)
      .map((item) => ({
        id: item.clientId as string,
        name: item.clientName ?? '',
        ldaClientId: item.ldaClientId,
      }));
    const skipped = job.items
      .filter((item) => item.outcome === 'already_present' || item.outcome === 'rejected')
      .map((item) => ({
        ldaClientId: item.ldaClientId,
        reason:
          item.outcome === 'already_present' ? 'already onboarded' : importItemReason(item.code),
      }));

    return {
      created: items.length,
      items,
      skipped,
      job: {
        id: job.id,
        requestId: job.requestId,
        status: job.status,
        stale: job.stale,
        counts: {
          total: job.total,
          processed: job.processed,
          successful: job.successful,
          rejected: job.rejected,
          outstanding: job.outstanding,
          created: job.created,
          alreadyPresent: job.alreadyPresent,
        },
      },
    };
  }
}
