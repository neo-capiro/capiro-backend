import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { GenerationGatewayService } from '../../engagement/generation/generation-gateway.service.js';
import type { GenerationResult } from '../../engagement/generation/generation-gateway.types.js';
import { OutreachDraftService } from '../../engagement/outreach-draft.service.js';
import { OutreachV3ArtifactRootService } from '../drafts/outreach-v3-artifact-root.service.js';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import type { OutreachCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import type { OutreachV3SampleVersionRef } from './outreach-v3-generation-approach.js';
import { buildOutreachV3GenerationPlan } from './outreach-v3-generation-plan.js';
import { OutreachV3GenerationPreparationService } from './outreach-v3-generation-preparation.service.js';
import { buildOutreachV3GatewayUnit } from './outreach-v3-generation-request.js';

export interface OutreachV3GeneratedSample {
  generationKey: string;
  outcome: GenerationResult['outcome'];
  subject: string;
  body: string;
  contextNote: string | null;
  manifest: GenerationResult['manifest'];
  sampleVersion: OutreachV3SampleVersionRef | null;
  error: string | null;
  /** V3 samples always require explicit approach + exact-version review. */
  sendable: false;
}

export interface OutreachV3SampleGenerationResult {
  sessionId: string;
  stateVersion: number;
  specHash: string;
  planHash: string;
  representativeSampleKeys: string[];
  samples: OutreachV3GeneratedSample[];
  complete: boolean;
  approachApprovalRequired: true;
  fullGenerationStarted: false;
}

@Injectable()
export class OutreachV3SampleGenerationService {
  constructor(
    private readonly sessions: OutreachSessionService,
    private readonly preparation: OutreachV3GenerationPreparationService,
    private readonly roots: OutreachV3ArtifactRootService,
    private readonly gateway: GenerationGatewayService,
    private readonly drafts: OutreachDraftService,
  ) {}

  async generateSamples(
    ctx: TenantContext,
    sessionId: string,
    authHeader?: string,
  ): Promise<OutreachV3SampleGenerationResult> {
    if (!this.gateway.enabled) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'Governed generation is not enabled for this runtime.',
        503,
        { reason: 'generation_gateway_disabled' },
      );
    }

    const current = await this.sessions.getSession(ctx, sessionId);
    if (current.session.status !== 'active') {
      throw new OutreachCommandError(
        'OUTREACH_SESSION_ARCHIVED',
        'Archived outreach sessions cannot generate samples.',
        409,
      );
    }

    const plan = buildOutreachV3GenerationPlan({
      sessionId,
      stateVersion: current.currentStateVersion,
      specHash: current.specHash,
      spec: current.spec,
      readiness: current.readiness,
      pendingProposalCount: current.pendingProposalCount,
    });
    if (!plan.eligible || plan.representativeSampleKeys.length === 0) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'The campaign is not ready for representative sample generation.',
        409,
        {
          reason: 'generation_plan_not_eligible',
          blockers: plan.blockers.length ? plan.blockers.join(',') : null,
        },
      );
    }
    if (plan.representativeSampleKeys.length > 3) {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CORRUPT',
        'The representative sample set exceeds the governed limit.',
        500,
      );
    }

    // Reauthorize the entire bounded sample set before the first model call.
    const prepared = [];
    for (const generationKey of plan.representativeSampleKeys) {
      const slot = plan.slots.find((candidate) => candidate.generationKey === generationKey);
      if (!slot) {
        throw new OutreachCommandError(
          'OUTREACH_STATE_CORRUPT',
          'The generation plan references a missing sample slot.',
          500,
        );
      }
      prepared.push(await this.preparation.prepareSlot(ctx, current.spec, slot));
    }

    const { outreachRecordId } = await this.roots.ensureRoot(ctx, sessionId);
    const units = prepared.map((entry) =>
      buildOutreachV3GatewayUnit({
        plan,
        spec: current.spec,
        prepared: entry,
        outreachRecordId,
        ...(authHeader ? { authHeader } : {}),
      }),
    );

    let firstPolicy: ReturnType<GenerationGatewayService['resolvePolicy']>;
    try {
      firstPolicy = this.gateway.resolvePolicy(units[0]!.request);
    } catch {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'The audience policy could not be resolved for representative samples.',
        409,
        { reason: 'audience_policy_required' },
      );
    }
    const resolved = await this.gateway.resolvePinnedIdentity(ctx, {
      policy: firstPolicy,
      runtimeAction: units[0]!.request.runtimeAction,
    });
    if (!resolved) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'Drafting is not configured for this workspace.',
        503,
        { reason: 'ai_not_configured' },
      );
    }

    const samples: OutreachV3GeneratedSample[] = [];
    for (const unit of units) {
      unit.request.pinned = resolved.pinned;
      const generated = await this.gateway.generate(
        ctx,
        unit.request,
        {
          channels: unit.enrichments,
          clientBrief: null,
          clientName: null,
          topicTerms: topicTerms(current.spec),
          auditLedger: unit.auditLedger,
          // Relevant-mail auto-expansion would create factual packet evidence
          // without a matching V3 selected-context decision/ledger entry.
          includeRelevantEmail: false,
        },
        resolved.creds,
      );

      let sampleVersion: OutreachV3SampleVersionRef | null = null;
      if (generated.versionId && generated.artifactId) {
        const version = await this.drafts.getVersion(ctx, generated.versionId);
        if (
          version.outreachRecordId !== outreachRecordId ||
          version.generationKey !== generated.generationKey ||
          version.artifactId !== generated.artifactId
        ) {
          throw new OutreachCommandError(
            'OUTREACH_STATE_CORRUPT',
            'The generated sample version does not match its campaign artifact root.',
            500,
          );
        }
        sampleVersion = {
          generationKey: generated.generationKey,
          artifactId: version.artifactId,
          versionId: version.id,
          contentHash: version.contentHash,
          planHash: plan.planHash,
          auditStatus: version.auditStatus,
          generationStatus: version.generationStatus,
        };
      }

      samples.push({
        generationKey: generated.generationKey,
        outcome: generated.outcome,
        subject: generated.subject,
        body: generated.body,
        contextNote: generated.contextNote ?? null,
        manifest: generated.manifest,
        sampleVersion,
        error: generated.error ?? null,
        sendable: false,
      });

      // Stop on the first non-persisted result. Previous immutable samples stay
      // reviewable; no remaining sample spend occurs automatically.
      if (!sampleVersion) break;

      // External model work cannot hold a campaign-state lock. Recheck after
      // each persisted sample; if Campaign Spec moved, the old-plan version stays
      // as immutable history but is never returned as an approvable current set.
      const after = await this.sessions.getSession(ctx, sessionId);
      if (after.currentStateVersion !== plan.stateVersion || after.specHash !== plan.specHash) {
        throw new OutreachCommandError(
          'OUTREACH_STATE_CONFLICT',
          'The campaign changed while representative samples were being generated. Review the updated plan before generating again.',
          409,
          { currentStateVersion: after.currentStateVersion },
        );
      }
    }

    const complete =
      samples.length === plan.representativeSampleKeys.length &&
      samples.every((sample) => sample.sampleVersion !== null);
    return {
      sessionId,
      stateVersion: plan.stateVersion,
      specHash: plan.specHash,
      planHash: plan.planHash,
      representativeSampleKeys: plan.representativeSampleKeys,
      samples,
      complete,
      approachApprovalRequired: true,
      fullGenerationStarted: false,
    };
  }
}

function topicTerms(spec: OutreachCampaignSpecV1): string[] {
  const raw = [spec.goal.topic, spec.goal.goal, spec.goal.objective, spec.goal.ask.text]
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => value.split(/[^A-Za-z0-9_.-]+/g))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length >= 3);
  return [...new Set(raw)].sort().slice(0, 32);
}
