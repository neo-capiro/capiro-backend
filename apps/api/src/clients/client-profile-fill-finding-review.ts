import {
  commitReviewedFindings,
  type ReviewCommand,
  type ReviewTransaction,
} from './client-profile-fill-review-store.js';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientProfileFillService } from './client-profile-fill.service.js';
import type { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';
import type { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';
import { asRecord } from './client-profile-fill.helpers.js';
import {
  auditAdvanced,
  type AdvancedFindingRow,
  type FindingApplicationReporter,
} from './client-profile-fill-finding-review.shared.js';
import { ClientProfileFillAdvocacyRecordApplication } from './client-profile-fill-advocacy-record-application.js';
import { ClientProfileFillOutcomeApplication } from './client-profile-fill-outcome-application.js';

export interface FindingReviewPorts extends FindingApplicationReporter {
  getRun: ClientProfileFillCompletionService['getRun'];
  confirmedMappingKeys(ctx: TenantContext, clientId: string, source: string): Promise<Set<string>>;
}

const ADVANCED_FINDING_KINDS = new Set([
  'federal_footprint',
  'facility_resolution',
  'district_nexus',
  'advocacy_record',
  'advocacy_outcome',
  'regulatory_outcome',
  'profile_completion',
]);
const NON_APPLYABLE_ADVANCED_KINDS = new Set([
  'facility_resolution',
  'district_nexus',
  'profile_completion',
]);

/** Human review composes canonical writers with the finding acceptance transaction. */
export class ClientProfileFillFindingReview {
  private readonly recordApplication: ClientProfileFillAdvocacyRecordApplication;
  private readonly outcomeApplication: ClientProfileFillOutcomeApplication;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fill: ClientProfileFillService,
    private readonly advocacyMatters: ClientAdvocacyMatterService,
    private readonly ports: FindingReviewPorts,
  ) {
    this.recordApplication = new ClientProfileFillAdvocacyRecordApplication(
      prisma,
      advocacyMatters,
      ports,
    );
    this.outcomeApplication = new ClientProfileFillOutcomeApplication(
      prisma,
      advocacyMatters,
      ports,
    );
  }

  async applyFindings(ctx: TenantContext, clientId: string, runId: string, command: ReviewCommand) {
    return commitReviewedFindings(
      this.prisma,
      ctx,
      clientId,
      runId,
      command,
      (scope, finding) => this.applyReviewedFinding(scope, ctx, clientId, finding),
      {
        warn: this.ports.warn,
        afterApplied: (findings) => this.fill.afterReviewedFindings(ctx, clientId, runId, findings),
      },
    );
  }

  private async applyReviewedFinding(
    scope: ReviewTransaction,
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
  ) {
    if (NON_APPLYABLE_ADVANCED_KINDS.has(finding.kind))
      throw new BadRequestException(
        'This item is informational and is not applied to the client record',
      );
    if (ADVANCED_FINDING_KINDS.has(finding.kind))
      return this.applyAdvancedFinding(ctx, clientId, finding, scope);
    return this.fill.applyFindingInTransaction(scope, ctx, clientId, finding);
  }

  async applyAdvocacyFindingToMatter(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    findingId: string,
    target:
      | { matterId: string }
      | { newMatter: { title: string; matterType?: string; summary?: string | null } },
    command: ReviewCommand,
  ) {
    if ('matterId' in target === 'newMatter' in target)
      throw new BadRequestException('Provide exactly one of matterId or newMatter');
    if (command?.findings?.length !== 1 || command.findings[0]?.id !== findingId)
      throw new BadRequestException('The review must select this advocacy finding');
    return commitReviewedFindings(
      this.prisma,
      ctx,
      clientId,
      runId,
      command,
      async (scope, finding) => {
        if (finding.kind !== 'advocacy_record')
          throw new BadRequestException('Only advocacy findings support direct Matter assignment');
        await this.recordApplication.applyAdvocacyRecord(ctx, clientId, finding, target, scope);
      },
      { target, warn: this.ports.warn },
    );
  }

  private async applyAdvancedFinding(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
    scope: ReviewTransaction,
  ): Promise<void> {
    switch (finding.kind) {
      case 'federal_footprint':
        await this.applyFederalFootprint(ctx, clientId, finding, scope);
        return;
      case 'advocacy_record':
        await this.recordApplication.applyAdvocacyRecord(ctx, clientId, finding, undefined, scope);
        return;
      case 'advocacy_outcome':
        await this.outcomeApplication.applyAdvocacyOutcome(ctx, clientId, finding, scope);
        return;
      case 'regulatory_outcome':
        await this.outcomeApplication.applyRegulatoryOutcome(ctx, clientId, finding, scope);
        return;
      default:
        throw new BadRequestException(`Unsupported completion finding: ${finding.kind}`);
    }
  }

  private async applyFederalFootprint(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
    scope: ReviewTransaction,
  ) {
    const tx = scope.tx;
    {
      const before = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: { intakeData: true },
      });
      if (!before) throw new NotFoundException('Client not found');
      await tx.$executeRawUnsafe(
        `UPDATE clients
            SET intake_data_jsonb = jsonb_set(
                  COALESCE(intake_data_jsonb, '{}'::jsonb),
                  '{federalMarket}',
                  $4::jsonb,
                  true
                ),
                updated_at = now()
          WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        clientId,
        ctx.tenantId,
        finding.id,
        JSON.stringify(finding.proposedValue),
      );
      await auditAdvanced(
        tx,
        ctx,
        clientId,
        finding,
        asRecord(before.intakeData).federalMarket,
        finding.proposedValue,
      );
    }
  }

  async applyAdvocacyRecord(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
    matterTarget?:
      | { matterId: string }
      | { newMatter: { title: string; matterType?: string; summary?: string | null } },
  ): Promise<string | null> {
    return this.recordApplication.applyAdvocacyRecord(ctx, clientId, finding, matterTarget);
  }
}
