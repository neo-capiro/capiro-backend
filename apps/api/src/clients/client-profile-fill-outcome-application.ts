import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';
import { asRecord, asString } from './client-profile-fill.helpers.js';
import {
  auditAdvanced,
  requiredString,
  type AdvancedFindingRow,
  type FindingApplicationReporter,
} from './client-profile-fill-finding-review.shared.js';

/** Applies reviewed outcomes while preserving their durable transaction and best-effort Matter link. */
export class ClientProfileFillOutcomeApplication {
  constructor(
    private readonly prisma: PrismaService,
    private readonly advocacyMatters: ClientAdvocacyMatterService,
    private readonly reporter: FindingApplicationReporter,
  ) {}

  async applyAdvocacyOutcome(ctx: TenantContext, clientId: string, finding: AdvancedFindingRow) {
    const proposed = asRecord(finding.proposedValue);
    const externalKey = requiredString(proposed.advocacyExternalKey, 'Advocacy record');
    const outcomeKind = requiredString(proposed.outcomeKind, 'Outcome kind');
    const outcomeEventId = asString(proposed.outcomeEventId);
    const matterId = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const changed = await tx.$executeRawUnsafe(
        `UPDATE client_advocacy_record
            SET outcome = $4,
                status = 'outcome_observed',
                metadata_jsonb = metadata_jsonb || jsonb_build_object(
                  'linkedOutcome', $5::jsonb,
                  'causationClaimed', false
                ),
                updated_at = now()
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND external_key = $3`,
        ctx.tenantId,
        clientId,
        externalKey,
        outcomeKind,
        JSON.stringify(proposed),
      );
      if (Number(changed) !== 1) {
        throw new BadRequestException(
          'Apply the related advocacy record before linking its outcome',
        );
      }
      await auditAdvanced(tx, ctx, clientId, finding, null, proposed);
      const matterRows = await tx.$queryRawUnsafe<Array<{ matterId: string | null }>>(
        `SELECT matter_id AS "matterId" FROM client_advocacy_record
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND external_key = $3`,
        ctx.tenantId,
        clientId,
        externalKey,
      );
      return matterRows[0]?.matterId ?? null;
    });
    // Outcome events are institutional-history objects in their own right
    // (product spec: "Matter groups ... government actions [and] outcomes")
    // even though they never become their own client_advocacy_record row.
    // Link the outcome event into the same Matter as the advocacy record it
    // was matched against, so the Matter's timeline shows what happened
    // after the ask without claiming causation (causationClaimed stays
    // false on the record itself, set above).
    if (matterId && outcomeEventId) {
      try {
        await this.advocacyMatters.linkToMatter(ctx, matterId, {
          linkType: 'outcome_event',
          linkKey: outcomeEventId,
          label: `Observed outcome: ${outcomeKind}`,
          metadata: { causationClaimed: false, outcomeKind },
        });
      } catch (error) {
        this.reporter.warn(
          `Advocacy matter outcome link failed for ${clientId}/${matterId}: ${this.reporter.safeError(error)}`,
        );
      }
    }
  }

  /**
   * Applies a `regulatory_outcome` finding (built by
   * `emitRegulatoryOutcomeFindings`/`buildRegulatoryOutcomeFinding`): a
   * human accepting the finding IS the separately-confirmed step
   * `suggestFederalRegisterCorrelations` deferred. Creates the OutcomeEvent
   * directly here (unlike `applyAdvocacyOutcome`, which links a
   * pre-existing one) since nothing else in the system ever creates an
   * outcome_event for a Federal Register document — this finding's accept
   * IS that creation. `evidence` carries the docket/document identifiers
   * `OutcomeEvent` has no dedicated columns for (§ gap: the smallest
   * necessary addition is these evidence keys, not new columns, matching
   * every other outcome kind's snapshot-into-evidence convention).
   *
   * `recordedBy` is the accepting user (the record() convention every other
   * apply* method already uses via `ctx.userId` for its own writes) — the
   * human review IS the attribution, not a system mirror.
   */
  async applyRegulatoryOutcome(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
  ): Promise<void> {
    const proposed = asRecord(finding.proposedValue);
    const matterId = requiredString(proposed.matterId, 'Advocacy matter');
    const documentNumber = requiredString(
      proposed.documentNumber,
      'Federal Register document number',
    );
    const docketId = requiredString(proposed.docketId, 'Docket id');
    const publicationDate = asString(proposed.publicationDate);
    const evidence = {
      docketId,
      documentNumber,
      documentType: asString(proposed.documentType),
      agencyNames: Array.isArray(proposed.agencyNames) ? proposed.agencyNames : [],
      publicationDate,
      matchedOn: 'docket_id',
      causationClaimed: false,
    };
    const outcomeEvent = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const created = await tx.outcomeEvent.create({
        data: {
          tenantId: ctx.tenantId,
          clientId,
          kind: 'regulatory_action_published',
          sourceType: 'regulatory_document',
          sourceId: documentNumber,
          evidence: evidence as Prisma.InputJsonValue,
          notes: `Government movement observed on docket ${docketId} after the client's attributable Regulations.gov advocacy — causation not claimed.`,
          recordedBy: ctx.userId,
          ...(publicationDate ? { observedAt: new Date(publicationDate) } : {}),
        },
      });
      await auditAdvanced(tx, ctx, clientId, finding, null, proposed);
      return created;
    });
    // Same looseness as applyAdvocacyOutcome's own Matter link: the
    // OutcomeEvent is already durably recorded above; a Matter-link failure
    // is logged, never rolled back into losing that record.
    try {
      await this.advocacyMatters.linkToMatter(ctx, matterId, {
        linkType: 'outcome_event',
        linkKey: outcomeEvent.id,
        label: `Observed government movement: ${evidence.documentType ?? 'Federal Register document'} on docket ${docketId}`,
        metadata: {
          causationClaimed: false,
          matchedOn: 'docket_id',
          relationship: 'strongly_aligned',
          documentNumber,
        },
      });
    } catch (error) {
      this.reporter.warn(
        `Regulatory matter outcome link failed for ${clientId}/${matterId}: ${this.reporter.safeError(error)}`,
      );
    }
  }
}
