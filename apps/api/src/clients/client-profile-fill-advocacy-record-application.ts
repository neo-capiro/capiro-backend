import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';
import { asRecord, asString } from './client-profile-fill.helpers.js';
import { normalizeEvidenceClass } from './client-profile-fill-advocacy-mapping.js';
import {
  auditAdvanced,
  requiredString,
  type AdvancedFindingRow,
  type FindingApplicationReporter,
} from './client-profile-fill-finding-review.shared.js';

export interface AdvocacyRecordApplicationPorts extends FindingApplicationReporter {
  confirmedMappingKeys(ctx: TenantContext, clientId: string, source: string): Promise<Set<string>>;
}

interface PreparedAdvocacyRecord {
  proposed: Record<string, unknown>;
  externalKey: string;
  title: string;
  recordType: string;
  sourceType: string;
  evidenceClass: string;
  activityDate: string | null;
}

/** Attributed record acceptance and its atomic human-directed Matter choice. */
export class ClientProfileFillAdvocacyRecordApplication {
  constructor(
    private readonly prisma: PrismaService,
    private readonly advocacyMatters: ClientAdvocacyMatterService,
    private readonly ports: AdvocacyRecordApplicationPorts,
  ) {}

  /**
   * Applies an advocacy_record finding's proposed value as an upsert into
   * `client_advocacy_record`.
   *
   * `matterTarget` distinguishes two callers:
   *  - Omitted (the generic bulk `applyFindings` path): Matter assignment
   *    runs via `assignMatterForRecord` in its OWN transaction, AFTER the
   *    record commit, best-effort — a clustering failure is logged but
   *    never blocks the accept. This is existing, unchanged behavior.
   *  - Provided (a human explicitly picked "Attach to Matter X" / "Create
   *    new Matter" on this pending finding — see
   *    `applyAdvocacyFindingToMatter`): the record upsert AND the Matter
   *    assign+lock run inside the SAME transaction. The human's choice is
   *    the review decision; if the Matter side fails, the whole write
   *    rolls back rather than silently accepting an unassigned record, and
   *    the caller never proceeds to `markAccepted` — the finding stays
   *    pending; the record upsert's own idempotency (ON CONFLICT) plus
   *    `assignSpecificMatterForRecord`'s already-locked check make a retry
   *    safe.
   *
   * Returns the resolved Matter id when `matterTarget` was provided;
   * `null` for the untargeted path (nothing new callers need there today).
   */
  async applyAdvocacyRecord(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
    matterTarget?:
      | { matterId: string }
      | { newMatter: { title: string; matterType?: string; summary?: string | null } },
  ): Promise<string | null> {
    const proposed = asRecord(finding.proposedValue);
    const externalKey = requiredString(proposed.externalKey, 'Advocacy external key');
    const title = requiredString(proposed.title, 'Advocacy title');
    const recordType = requiredString(proposed.recordType, 'Advocacy record type');
    const sourceType = requiredString(proposed.sourceType, 'Advocacy source type');
    if (sourceType === 'fara' || sourceType === 'testimony') {
      const metadata = asRecord(proposed.metadata);
      const sourceKey =
        sourceType === 'fara'
          ? asString(metadata.registrationNumber)
          : `${asString(metadata.hearingId) ?? ''}::${asString(metadata.witness) ?? ''}`;
      const confirmed = await this.ports.confirmedMappingKeys(ctx, clientId, sourceType);
      if (!sourceKey || !confirmed.has(sourceKey)) {
        throw new BadRequestException(
          'Verify this record’s organization-to-client mapping before accepting it as advocacy. A name match alone is insufficient.',
        );
      }
      proposed.metadata = {
        ...metadata,
        clientMatch: {
          ...asRecord(metadata.clientMatch),
          method: 'confirmed_client_intel_mapping',
          verifiedAt: new Date().toISOString(),
        },
      };
    }
    const evidenceClass = normalizeEvidenceClass(proposed.evidenceClass);
    const activityDate = asString(proposed.activityDate);
    const record = {
      proposed,
      externalKey,
      title,
      recordType,
      sourceType,
      evidenceClass,
      activityDate,
    };
    let targetedMatterId: string | null = null;
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.upsertRecord(tx, ctx, clientId, finding, record);
      await auditAdvanced(tx, ctx, clientId, finding, null, proposed);
      if (matterTarget) {
        // The human choice shares the record/audit transaction and rolls back with it.
        targetedMatterId = await this.advocacyMatters.assignSpecificMatterForRecord(
          tx,
          ctx,
          clientId,
          externalKey,
          matterTarget,
          activityDate,
        );
      }
    });
    if (matterTarget) return targetedMatterId;
    await this.assignAutomatically(ctx, clientId, record);
    return null;
  }

  // Automatic clustering uses its own transaction after the record/audit commit.
  // Its failure is logged and cannot undo the committed record or block acceptance.
  private async assignAutomatically(
    ctx: TenantContext,
    clientId: string,
    record: PreparedAdvocacyRecord,
  ): Promise<void> {
    const { proposed, externalKey, recordType, title, activityDate } = record;
    try {
      await this.advocacyMatters.assignMatterForRecord(ctx, clientId, externalKey, {
        recordType,
        title,
        metadata: asRecord(proposed.metadata),
        activityDate,
      });
    } catch (error) {
      this.ports.warn(
        `Advocacy matter assignment failed for ${clientId}/${externalKey}: ${this.ports.safeError(error)}`,
      );
    }
  }
  private async upsertRecord(
    tx: any,
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
    record: PreparedAdvocacyRecord,
  ): Promise<void> {
    const { proposed, externalKey, title, recordType, sourceType, evidenceClass, activityDate } =
      record;
    await tx.$executeRawUnsafe(
      `INSERT INTO client_advocacy_record
           (tenant_id, client_id, record_type, title, summary, activity_date,
            status, outcome, source_type, source_id, source_url, evidence_class,
            confidence, external_key, metadata_jsonb, created_by_user_id)
         VALUES (
           $1::uuid, $2::uuid, $3, $4, $5,
           CASE WHEN $6 = '' THEN NULL ELSE $6::timestamptz::date END,
           $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::uuid
         )
         ON CONFLICT (tenant_id, client_id, external_key) DO UPDATE
           SET record_type = EXCLUDED.record_type,
               title = EXCLUDED.title,
               summary = EXCLUDED.summary,
               activity_date = EXCLUDED.activity_date,
               status = EXCLUDED.status,
               outcome = COALESCE(EXCLUDED.outcome, client_advocacy_record.outcome),
               source_type = EXCLUDED.source_type,
               source_id = EXCLUDED.source_id,
               source_url = EXCLUDED.source_url,
               evidence_class = EXCLUDED.evidence_class,
               confidence = EXCLUDED.confidence,
               metadata_jsonb = client_advocacy_record.metadata_jsonb || EXCLUDED.metadata_jsonb,
               updated_at = now()`,
      ctx.tenantId,
      clientId,
      recordType,
      title,
      asString(proposed.summary),
      activityDate ?? '',
      asString(proposed.status),
      asString(proposed.outcome),
      sourceType,
      asString(proposed.sourceId),
      asString(proposed.sourceUrl),
      evidenceClass,
      Math.max(0, Math.min(1, Number(proposed.confidence ?? finding.confidence))),
      externalKey,
      JSON.stringify(asRecord(proposed.metadata)),
      ctx.userId,
    );
  }
}
