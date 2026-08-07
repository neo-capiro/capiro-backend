import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { TangoStoreService, computeContentHash } from '../external/tango/tango-store.service.js';
import type { TangoEntity } from '../external/tango/tango.types.js';
import { DURABLE_SET_ASIDE_CERTIFICATIONS, type DurableSetAsideCertification } from './set-aside.js';

/**
 * Client profile enrichment review workflow (Funding Opportunities P20).
 *
 * ── Why a new table, not TangoResourceLink or ClientIntelMapping ─────────────
 *
 * See the migration's own header (`20260823010000_client_profile_enrichment
 * _candidates`) for the full reasoning. In short: `TangoResourceLink` (P15)
 * is reserved for linking into Capiro's own GLOBAL reference tables, and
 * `clients` is tenant-owned, which `assertKnownLocalType` refuses on
 * purpose. `ClientIntelMapping` (P05) answers "is this the same legal
 * entity", a different question from "should this field change".
 *
 * ── Source precedence: propose, never overwrite ───────────────────────────────
 *
 * Nothing in this service ever writes to `Client` directly from a sync. Tango
 * data VERIFIES/ENRICHES; it never silently overwrites first-party data —
 * the plan's own architectural invariant, restated here for a NEW kind of
 * candidate rather than assumed to generalize from the mapping-governance
 * precedent (P05) without re-checking it applies the same way.
 *
 * ── "Rejection durable across syncs" ───────────────────────────────────────
 *
 * `proposeCandidate` is idempotent, like P15's `proposeLink`: if a row with
 * the identical (tenantId, clientId, source, field, contentHash) already
 * exists — pending, accepted, OR rejected — it is returned as-is and NOTHING
 * new is created. A rejected suggestion never comes back just because a
 * later sync re-observed the same Tango data. A genuinely DIFFERENT proposed
 * value for the same field is a new row, not a collision — the durability
 * protects a SPECIFIC rejected suggestion, not the field forever.
 *
 * ── "No accept-all for certifications" ─────────────────────────────────────
 *
 * There is no bulk-review method on this service at all, for any field —
 * `reviewCandidate` takes exactly one candidate id. This generalizes the
 * phase's own stated bar (no accept-all for certifications specifically) to
 * every field this service manages, which trivially satisfies the narrower
 * rule without needing a field-type allow/deny split that could drift.
 *
 * ── Certifications: curated, EXACT matches only — never fuzzy ─────────────────
 *
 * A false certification claim (HUBZONE, 8(a), SDVOSB, …) has real compliance
 * consequences. {@link TANGO_BUSINESS_TYPE_TO_CERTIFICATION} maps only a
 * short, hand-reviewed list of exact (case-insensitive, trimmed) Tango
 * business-type description strings to Capiro's six-value durable
 * certification vocabulary (`set-aside.ts`). A Tango business type that does
 * not exactly match is simply never proposed — never guessed at by partial
 * or fuzzy matching, same "UEI-first, never fuzzy" discipline this program
 * already applies to identity matching (P02), now applied to certification
 * text too.
 */

export const ENRICHMENT_FIELDS = ['naicsCodes', 'pscCodes', 'setAsideCertifications', 'cageCode'] as const;
export type EnrichmentField = (typeof ENRICHMENT_FIELDS)[number];

export const ENRICHMENT_CANDIDATE_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type EnrichmentCandidateStatus = (typeof ENRICHMENT_CANDIDATE_STATUSES)[number];

/**
 * Curated, exact (case-insensitive, trimmed), hand-reviewed. Extend this list
 * deliberately when a new legitimate Tango phrasing is found — never widen
 * the matcher itself to fuzzy/partial matching.
 */
export const TANGO_BUSINESS_TYPE_TO_CERTIFICATION: Readonly<Record<string, DurableSetAsideCertification>> = {
  // SAM.gov's own WOSB designation is singular ("Woman"); EDWOSB's official
  // program name is plural ("Women"). Both singular AND plural are curated
  // for plain WOSB defensively, since this program has not yet observed a
  // real Tango response to confirm which phrasing this specific provider
  // uses — better to accept either exact form than to miss a real match on
  // a plausible variant.
  'woman owned small business': 'WOSB',
  'women owned small business': 'WOSB',
  'economically disadvantaged women-owned small business': 'EDWOSB',
  'economically disadvantaged women owned small business': 'EDWOSB',
  'service-disabled veteran-owned small business': 'SDVOSB',
  'service disabled veteran owned small business': 'SDVOSB',
  'veteran-owned small business': 'VOSB',
  'veteran owned small business': 'VOSB',
  hubzone: 'HUBZONE',
  'hubzone certified small business': 'HUBZONE',
  'hubzone small business': 'HUBZONE',
  '8(a) program': '8A',
  '8(a) program participant': '8A',
  '8a program participant': '8A',
};

function matchCertifications(descriptions: string[]): DurableSetAsideCertification[] {
  const found = new Set<DurableSetAsideCertification>();
  for (const raw of descriptions) {
    const key = raw.trim().toLowerCase();
    const mapped = TANGO_BUSINESS_TYPE_TO_CERTIFICATION[key];
    if (mapped) found.add(mapped);
  }
  return [...found];
}

/** Case-insensitive, order-insensitive set union — never a removal. */
function unionPreservingOrder(existing: string[], additional: string[]): string[] {
  const seen = new Set(existing.map((v) => v.toUpperCase()));
  const merged = [...existing];
  for (const v of additional) {
    if (!seen.has(v.toUpperCase())) {
      seen.add(v.toUpperCase());
      merged.push(v);
    }
  }
  return merged;
}

export interface ProposeCandidatesResult {
  clientId: string;
  proposed: number;
  alreadyExisted: number;
  noChange: EnrichmentField[];
  /** True when this client has no UEI or no Tango snapshot yet — nothing to compare. */
  skipped: boolean;
}

export interface EnrichmentCandidateView {
  id: string;
  clientId: string;
  source: string;
  field: EnrichmentField;
  currentValue: unknown;
  proposedValue: unknown;
  status: EnrichmentCandidateStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export interface ReviewCandidateInput {
  status: 'accepted' | 'rejected';
  reviewedBy: string;
  /** Required when rejecting — a rejection with no stated reason is not reviewable evidence later. */
  rejectionReason?: string;
}

@Injectable()
export class ClientProfileEnrichmentService {
  private readonly logger = new Logger(ClientProfileEnrichmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tangoStore: TangoStoreService,
  ) {}

  /**
   * Compare one client's CURRENT profile against its active Tango entity
   * snapshot (P19) and propose durable, idempotent candidates for whatever
   * differs. Never writes to `clients` — only to the candidate table.
   */
  async proposeCandidatesForClient(tenantId: string, clientId: string): Promise<ProposeCandidatesResult> {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId },
        select: { id: true, uei: true, naicsCodes: true, pscCodes: true, setAsideCertifications: true, cageCode: true },
      }),
    );
    if (!client) throw new NotFoundException(`Client ${clientId} not found in this tenant`);

    if (!client.uei) {
      // No UEI, nothing to compare against — never a fuzzy name-based lookup.
      return { clientId, proposed: 0, alreadyExisted: 0, noChange: [], skipped: true };
    }

    // Global table (P15) — no tenant scoping needed or applicable.
    const snapshot = await this.tangoStore.getActiveSnapshot('entity', client.uei);
    if (!snapshot) {
      return { clientId, proposed: 0, alreadyExisted: 0, noChange: [], skipped: true };
    }
    const entity = snapshot.normalizedJsonb as unknown as TangoEntity;

    const arrayFields: Array<{ field: EnrichmentField; current: string[]; incoming: string[] }> = [
      { field: 'naicsCodes', current: client.naicsCodes, incoming: entity.naicsCodes },
      { field: 'pscCodes', current: client.pscCodes, incoming: entity.pscCodes },
      {
        field: 'setAsideCertifications',
        current: client.setAsideCertifications,
        incoming: matchCertifications([...entity.businessTypes, ...entity.sbaBusinessTypes]),
      },
    ];

    // One transaction for the whole propose pass — every candidate this
    // client's snapshot could yield, checked and (idempotently) created
    // against a single consistent view, not one transaction per field.
    return this.prisma.withTenant(tenantId, async (tx) => {
      let proposed = 0;
      let alreadyExisted = 0;
      const noChange: EnrichmentField[] = [];

      for (const { field, current, incoming } of arrayFields) {
        const proposedValue = unionPreservingOrder(current, incoming);
        if (proposedValue.length === current.length) {
          noChange.push(field);
          continue;
        }
        const created = await proposeCandidateWithin(tx, tenantId, clientId, field, current, proposedValue);
        if (created) proposed += 1;
        else alreadyExisted += 1;
      }

      // cageCode: a scalar, fill-if-empty-or-different. A DIFFERENT CAGE code
      // from what the client already has on file is itself worth a human's
      // attention, not silently ignored — a government-assigned identifier
      // disagreeing with what Capiro has on file is a real discrepancy.
      if (entity.cageCode && entity.cageCode !== client.cageCode) {
        const created = await proposeCandidateWithin(
          tx,
          tenantId,
          clientId,
          'cageCode',
          client.cageCode,
          entity.cageCode,
        );
        if (created) proposed += 1;
        else alreadyExisted += 1;
      } else {
        noChange.push('cageCode');
      }

      return { clientId, proposed, alreadyExisted, noChange, skipped: false };
    });
  }

  async listCandidates(
    tenantId: string,
    filter: { clientId?: string; status?: EnrichmentCandidateStatus } = {},
  ): Promise<EnrichmentCandidateView[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientProfileEnrichmentCandidate.findMany({
        where: {
          tenantId,
          ...(filter.clientId ? { clientId: filter.clientId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map(toView);
  }

  /**
   * Review EXACTLY ONE candidate. There is no bulk variant — see the class
   * doc for why that is the point, not a gap.
   */
  async reviewCandidate(
    tenantId: string,
    candidateId: string,
    input: ReviewCandidateInput,
  ): Promise<EnrichmentCandidateView> {
    if (input.status === 'rejected' && !input.rejectionReason?.trim()) {
      throw new BadRequestException('rejectionReason is required when rejecting a candidate');
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const candidate = await tx.clientProfileEnrichmentCandidate.findFirst({
        where: { id: candidateId, tenantId },
      });
      if (!candidate) throw new NotFoundException(`Enrichment candidate ${candidateId} not found in this tenant`);
      if (candidate.status !== 'pending') {
        throw new ForbiddenException(
          `Candidate ${candidateId} was already ${candidate.status} — a reviewed candidate cannot be re-reviewed`,
        );
      }

      if (input.status === 'accepted') {
        // Apply to the actual client field FIRST, in the same transaction as
        // the status flip — an accepted row whose write failed must not be
        // recorded as accepted.
        await tx.client.update({
          where: { id: candidate.clientId },
          data: { [candidate.field]: candidate.proposedValueJsonb as never },
        });
      }

      const updated = await tx.clientProfileEnrichmentCandidate.update({
        where: { id: candidateId },
        data: {
          status: input.status,
          reviewedBy: input.reviewedBy,
          reviewedAt: new Date(),
          rejectionReason: input.status === 'rejected' ? input.rejectionReason!.trim() : null,
        },
      });
      return toView(updated);
    });
  }
}

/** Shared by every field propose-check inside ONE tenant transaction (see proposeCandidatesForClient). */
async function proposeCandidateWithin(
  tx: Prisma.TransactionClient,
  tenantId: string,
  clientId: string,
  field: EnrichmentField,
  currentValue: unknown,
  proposedValue: unknown,
): Promise<boolean> {
  const contentHash = computeContentHash({ source: 'tango', field, proposedValue });
  const existing = await tx.clientProfileEnrichmentCandidate.findFirst({
    where: { tenantId, clientId, source: 'tango', field, contentHash },
  });
  if (existing) return false;

  await tx.clientProfileEnrichmentCandidate.create({
    data: {
      tenantId,
      clientId,
      source: 'tango',
      field,
      currentValueJsonb: (currentValue ?? null) as object | undefined,
      proposedValueJsonb: proposedValue as object,
      contentHash,
    },
  });
  return true;
}

function toView(row: {
  id: string;
  clientId: string;
  source: string;
  field: string;
  currentValueJsonb: unknown;
  proposedValueJsonb: unknown;
  status: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
}): EnrichmentCandidateView {
  return {
    id: row.id,
    clientId: row.clientId,
    source: row.source,
    field: row.field as EnrichmentField,
    currentValue: row.currentValueJsonb,
    proposedValue: row.proposedValueJsonb,
    status: row.status as EnrichmentCandidateStatus,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt.toISOString(),
  };
}
