import type { ReviewTransaction } from './client-profile-fill-review-store.js';
import { withinFinding, afterFindingCommit } from './client-profile-fill-review-transaction.js';
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

  /** Record, audit and a chosen Matter participate in the caller's review transaction.
   * Automatic clustering remains a best-effort post-commit effect. */
  async applyAdvocacyRecord(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
    matterTarget?:
      | { matterId: string }
      | { newMatter: { title: string; matterType?: string; summary?: string | null } },
    scope?: ReviewTransaction,
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
      const confirmed = scope
        ? new Set(
            (
              await scope.tx.clientIntelMapping.findMany({
                where: { tenantId: ctx.tenantId, clientId, source: sourceType, confirmed: true },
                select: { externalId: true },
              })
            ).map((row) => row.externalId),
          )
        : await this.ports.confirmedMappingKeys(ctx, clientId, sourceType);
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
    await withinFinding(this.prisma, ctx.tenantId, scope, async (tx) => {
      if (scope) {
        const [prior] = await tx.$queryRawUnsafe<
          Array<{ matterId: string | null; locked: boolean; rejected: boolean }>
        >(
          `SELECT matter_id AS "matterId", matter_locked AS locked, not_advocacy AS rejected
           FROM client_advocacy_record WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND external_key=$3 FOR UPDATE`,
          ctx.tenantId,
          clientId,
          externalKey,
        );
        if (
          prior?.rejected ||
          (matterTarget &&
            prior?.locked &&
            (!('matterId' in matterTarget) || matterTarget.matterId !== prior.matterId))
        )
          throw new BadRequestException(
            'This record already has a human review decision. Use its correction controls.',
          );
      }
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
    await afterFindingCommit(scope, () => this.assignAutomatically(ctx, clientId, record));
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
