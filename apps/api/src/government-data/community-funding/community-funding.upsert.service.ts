import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { sha256CanonicalJson } from '../../defense-budget/contracts/canonical-json.js';
import { communityFundingIdentity } from './community-funding.identity.js';
import { mergeCanonicalNonIdentityFields } from './community-funding.precedence.js';
import type { CanonicalNonIdentityFields } from './community-funding.precedence.js';
import { normalizeIdentityText } from './community-funding.parser.js';
import type { FundingCandidate } from './community-funding.types.js';

/**
 * Identity vs provenance repair of the original #1328 design — see
 * community-funding.identity.ts's class doc for the full rationale.
 *
 * One canonical CommunityFundingRequest row per identity_hash (the government
 * funding request itself). Every source occurrence that produced or corroborated
 * that request gets its own CommunityFundingRequestSource row, keyed uniquely by
 * (requestId, sourceDocumentId, sourcePage, sourceRow) so re-running the same
 * document is a no-op and two genuinely distinct documents always coexist as two
 * provenance rows under the one canonical request.
 */
@Injectable()
export class CommunityFundingUpsertService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertMany(candidates: FundingCandidate[], sourceDocumentId: string, retrievedAt = new Date()) {
    // One real transaction per batch (unchanged from the original design intent):
    // a whole document's ingest either fully applies or not. Explicit timeout scaled
    // to batch size — Prisma's 5s interactive-transaction default is far too short for
    // a real consolidated-XLSX batch (thousands of candidates, each requiring several
    // round trips); the real FY2026 XLSX rehearsal in
    // community-funding.cross-source-dedup.spec.ts is the proof this needs raising.
    //
    // Full-corpus disposable proof (2026-08-31): length*50 still expired on large
    // House PDFs (937 / 2886 rows) under concurrent host load — interactive txn
    // closed mid-batch. Scale more generously with a hard 15-minute ceiling so a
    // single official source document can finish without abandoning the whole
    // campaign, while remaining bounded (no infinite wait).
    const timeoutMs = Math.min(900_000, Math.max(120_000, candidates.length * 150));
    return this.prisma.$transaction(async (tx) => {
      let upserted = 0, changed = 0, provenanceInserted = 0, provenanceUnchanged = 0;
      for (const candidate of candidates) {
        const identityHash = communityFundingIdentity(candidate);
        const existing = await tx.communityFundingRequest.findUnique({
          where: { identityHash },
          select: {
            id: true, requesterName: true, requesterState: true, requesterDistrict: true,
            recipientAddress: true, city: true, state: true, zip: true, projectDescription: true,
            requestedAmountUsd: true, finalAmountUsd: true, amountStageRaw: true,
            appropriationsAccountRaw: true, subcommittee: true,
          },
        });

        let requestId: string;
        if (!existing) {
          const created = await tx.communityFundingRequest.create({ data: this.canonicalCreateData(candidate, identityHash) });
          requestId = created.id;
          upserted++;
        } else {
          requestId = existing.id;
          const current: CanonicalNonIdentityFields = {
            requesterName: existing.requesterName,
            requesterState: existing.requesterState,
            requesterDistrict: existing.requesterDistrict,
            recipientAddress: existing.recipientAddress,
            city: existing.city,
            state: existing.state,
            zip: existing.zip,
            projectDescription: existing.projectDescription,
            requestedAmountUsd: existing.requestedAmountUsd.toString(),
            finalAmountUsd: existing.finalAmountUsd?.toString() ?? null,
            amountStageRaw: existing.amountStageRaw as FundingCandidate['amountStageRaw'],
            appropriationsAccountRaw: existing.appropriationsAccountRaw,
            subcommittee: existing.subcommittee,
          };
          const merge = mergeCanonicalNonIdentityFields(current, candidate);
          if (merge.changed) {
            await tx.communityFundingRequest.update({ where: { id: requestId }, data: merge.fields });
            changed++;
          }
        }

        // Provenance: one row per (request, sourceDocument, page, row) — see class doc.
        // sourceRow is the deterministic per-source uniqueness key (always populated by
        // both parsers); sourceHash covers this occurrence's own raw fields so an
        // unchanged re-run of the same document is a true no-op, never a duplicate.
        //
        // NOTE: sourcePage is nullable (XLSX rows have no page), so Prisma does not
        // generate a usable compound-unique shorthand type for this lookup (its
        // generated compound-key input type requires sourcePage: number, not
        // number | null) — findFirst + create/update by id is used instead. The real
        // concurrency/duplicate guarantee is the DB-level unique index on
        // (request_id, source_document_id, source_page, source_row), not this
        // application-level check; see database-concurrency-proof's "application
        // checks are advisory" rule. This whole batch already runs inside one
        // transaction and is processed sequentially, so no intra-batch race exists here.
        const sourceHash = sha256CanonicalJson(candidate as unknown as Parameters<typeof sha256CanonicalJson>[0]);
        const existingSource = await tx.communityFundingRequestSource.findFirst({
          where: { requestId, sourceDocumentId, sourcePage: candidate.sourcePage, sourceRow: candidate.sourceRow },
          select: { id: true, sourceHash: true },
        });
        if (!existingSource) {
          await tx.communityFundingRequestSource.create({
            data: {
              requestId, sourceDocumentId, sourcePage: candidate.sourcePage, sourceRow: candidate.sourceRow,
              sourceHash, retrievedAt, requesterNameRaw: candidate.requesterName,
              amountStageRaw: candidate.amountStageRaw, requestedAmountUsd: candidate.requestedAmountUsd,
              finalAmountUsd: candidate.finalAmountUsd, appropriationsAccountRaw: candidate.appropriationsAccountRaw,
              subcommittee: candidate.subcommittee,
            },
          });
          provenanceInserted++;
        } else if (existingSource.sourceHash !== sourceHash) {
          // Same document occurrence, corrected values on a re-run (e.g. a republished
          // artifact with a fix) — update this provenance row in place by its stable id.
          // Deterministic on (requestId, sourceDocumentId, sourcePage, sourceRow), never
          // inserts a duplicate.
          await tx.communityFundingRequestSource.update({
            where: { id: existingSource.id },
            data: {
              sourceHash, retrievedAt, requesterNameRaw: candidate.requesterName,
              amountStageRaw: candidate.amountStageRaw, requestedAmountUsd: candidate.requestedAmountUsd,
              finalAmountUsd: candidate.finalAmountUsd, appropriationsAccountRaw: candidate.appropriationsAccountRaw,
              subcommittee: candidate.subcommittee,
            },
          });
        } else {
          provenanceUnchanged++;
        }
      }
      return { upserted, changed, unchanged: candidates.length - upserted - changed, provenanceInserted, provenanceUnchanged };
    }, { timeout: timeoutMs, maxWait: timeoutMs });
  }

  private canonicalCreateData(c: FundingCandidate, identityHash: string) {
    return {
      identityHash, chamber: c.chamber, requestType: c.requestType, fiscalYear: c.fiscalYear,
      requesterName: c.requesterName, requesterState: c.requesterState, requesterDistrict: c.requesterDistrict,
      recipientName: c.recipientName, recipientNormalized: normalizeIdentityText(c.recipientName), recipientAddress: c.recipientAddress,
      city: c.city, state: c.state, zip: c.zip, projectTitle: c.projectTitle, projectDescription: c.projectDescription,
      requestedAmountUsd: c.requestedAmountUsd, finalAmountUsd: c.finalAmountUsd, amountStageRaw: c.amountStageRaw,
      appropriationsAccountRaw: c.appropriationsAccountRaw,
      appropriationsAccountNormalized: c.appropriationsAccountRaw ? normalizeIdentityText(c.appropriationsAccountRaw) : null,
      subcommittee: c.subcommittee,
    };
  }
}
