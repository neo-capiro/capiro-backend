import { Injectable, Logger } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  EVALUATION_CONFIG_VERSION,
  buildInstitutionalContextControlProjection,
  computeEvaluationSamplingKey,
  decideEvaluationEligibility,
  evaluationEnabled,
  evaluationSampleRate,
  shouldSampleForEvaluation,
} from '@capiro/meriv2-core';
import { createHash } from 'node:crypto';
import { EvaluationCaptureService } from '../../evaluation/evaluation-capture.service.js';
import { computeEditMetrics } from '../../quality-telemetry/edit-metrics.helpers.js';
import { EvidencePacketService } from './evidence-packet.service.js';
import type { EvidencePacketV2 } from './evidence-packet.types.js';
import { MessagePlanService } from './message-plan.service.js';
import type { MessagePlan } from './message-plan.schema.js';
import { AuthorStyleProfileService, type AuthorStyleProfile } from './author-style-profile.service.js';
import { LlmCompletionService, LLM_LONG_GENERATION_TIMEOUT_MS } from '../llm-completion.service.js';
import { GenerationVerifierService } from './generation-verifier.service.js';
import { buildGatewayPrompt, GATEWAY_DRAFT_JSON_SCHEMA } from './gateway-prompt.js';
import { parseDraft } from './generation-gateway.service.js';
import { projectUserVoice, type OutreachGovernedContext } from './outreach-context-plane.service.js';
import type { GaPolicy } from './government-affairs-policy.registry.js';
import type { AuthenticatedDirective } from './evidence-packet.types.js';
import type { ResolvedAiCredential } from '../ai-credential-resolver.service.js';
import type {
  GatewayStyleSample,
  GenerationRequest,
  PinnedGenerationIdentity,
} from './generation-gateway.types.js';
import type { GatewayEnrichmentInput } from './generation-gateway.service.js';

export interface OutreachEvaluationInput {
  readonly request: GenerationRequest;
  readonly enrichment: GatewayEnrichmentInput;
  readonly policy: GaPolicy;
  readonly pinned: PinnedGenerationIdentity;
  readonly pinnedCreds: ResolvedAiCredential[];
  readonly governed: OutreachGovernedContext;
  readonly packet: EvidencePacketV2;
  readonly plan: MessagePlan;
  readonly styleProfile: AuthorStyleProfile | null;
  readonly styleSamples: GatewayStyleSample[];
  readonly recipientBrief: string | null;
  /** Same non-institutional request-derived directives the treatment plan/draft used. */
  readonly requestDirectives: AuthenticatedDirective[];
  readonly wallAllowsClient: boolean;
  readonly scanRequired: boolean;
  readonly authHeader?: string | null;
  readonly treatmentSubject: string;
  readonly treatmentBody: string;
  readonly treatmentArtifactId: string;
  readonly treatmentArtifactVersionSeq: number;
  readonly contextPacketId: string | null;
}

/**
 * Phase 27F — the ONE Outreach shadow-evaluation runner.
 *
 * Reuses the exact product path (`EvidencePacketService.compileOutreachPacket`,
 * `MessagePlanService.buildPlan`, `AuthorStyleProfileService.getProfile`,
 * `buildGatewayPrompt`, `LlmCompletionService.complete`,
 * `GenerationVerifierService.verify`) — no second RAG/prompt stack. The ONLY
 * thing that differs between the treatment (already-produced, real) output
 * and the control output this runner produces is the institutional-context
 * projection of the SAME frozen `governed.packet` (§32): authoritative
 * evidence, recipient identity, policy, plan inputs and style SAMPLES
 * (caller-supplied, not packet-derived) stay byte-identical.
 *
 * Called fire-and-forget, AFTER the real draft version is already durably
 * persisted (`GenerationGatewayService.generate()`) — a failure or slow
 * completion here can never affect or delay the real response (§17). Never
 * mutates a production ContextPacket/EvidencePacket/DraftVersion: the
 * control packet this runner compiles is a NEW, separate persisted row
 * (packetId always omitted from the control compile call), never a write to
 * the treatment's own packet or draft.
 */
@Injectable()
export class OutreachEvaluationRunner {
  private readonly logger = new Logger(OutreachEvaluationRunner.name);

  constructor(
    private readonly evaluation: EvaluationCaptureService,
    private readonly packets: EvidencePacketService,
    private readonly plans: MessagePlanService,
    private readonly styles: AuthorStyleProfileService,
    private readonly llm: LlmCompletionService,
    private readonly verifier: GenerationVerifierService,
  ) {}

  async considerAndRun(ctx: TenantContext, input: OutreachEvaluationInput): Promise<void> {
    if (!evaluationEnabled(process.env.LEARNING_EVALUATION)) return;

    const institutionalItemCount = input.governed.standingMemory.length;
    const eligibility = decideEvaluationEligibility({
      enabled: true,
      contextPacketId: input.contextPacketId,
      institutionalItemCount,
      // The treatment run already resolved a frozen governed bundle we still
      // hold in memory — nothing further needs to be fetched to replay it.
      authoritativeInputReplayable: true,
      operationSupported: true,
      providerAvailable: input.pinnedCreds.length > 0,
      withinBudget: true,
    });

    const samplingKey = computeEvaluationSamplingKey({
      tenantId: ctx.tenantId,
      operation: 'outreach.draft_version.generate',
      artifactId: input.treatmentArtifactId,
    });
    const observedAt = new Date();

    if (!eligibility.eligible) {
      await this.evaluation.recordDecision({
        tenantId: ctx.tenantId,
        clientId: input.request.clientId,
        surface: 'outreach',
        operation: 'outreach.draft_version.generate',
        evaluationType: 'institutional_context_ablation',
        status: 'skipped',
        skipReason: eligibility.reason,
        contextPacketId: input.contextPacketId,
        treatmentArtifactType: 'outreach_draft_version',
        treatmentArtifactId: input.treatmentArtifactId,
        treatmentArtifactVersionSeq: input.treatmentArtifactVersionSeq,
        samplingKey,
        configVersion: EVALUATION_CONFIG_VERSION,
        observedAt,
      });
      return;
    }

    const rate = evaluationSampleRate(process.env.LEARNING_EVALUATION_SAMPLE_RATE);
    if (!shouldSampleForEvaluation(samplingKey, rate)) {
      await this.evaluation.recordDecision({
        tenantId: ctx.tenantId,
        clientId: input.request.clientId,
        surface: 'outreach',
        operation: 'outreach.draft_version.generate',
        evaluationType: 'institutional_context_ablation',
        status: 'skipped',
        skipReason: 'not_sampled',
        contextPacketId: input.contextPacketId,
        treatmentArtifactType: 'outreach_draft_version',
        treatmentArtifactId: input.treatmentArtifactId,
        treatmentArtifactVersionSeq: input.treatmentArtifactVersionSeq,
        samplingKey,
        configVersion: EVALUATION_CONFIG_VERSION,
        observedAt,
      });
      return;
    }

    const recorded = await this.evaluation.recordDecision({
      tenantId: ctx.tenantId,
      clientId: input.request.clientId,
      surface: 'outreach',
      operation: 'outreach.draft_version.generate',
      evaluationType: 'institutional_context_ablation',
      status: 'pending',
      contextPacketId: input.contextPacketId,
      treatmentArtifactType: 'outreach_draft_version',
      treatmentArtifactId: input.treatmentArtifactId,
      treatmentArtifactVersionSeq: input.treatmentArtifactVersionSeq,
      treatmentOutputHash: hashText(`${input.treatmentSubject}\n${input.treatmentBody}`),
      samplingKey,
      configVersion: EVALUATION_CONFIG_VERSION,
      observedAt,
    });
    if (recorded.status !== 'recorded' && recorded.status !== 'duplicate') return;
    // A retried delivery of the same event reaches the SAME row
    // (idempotency-keyed) — never re-run the replay for a duplicate.
    if (recorded.status === 'duplicate') return;

    await this.evaluation.markRunning(ctx.tenantId, recorded.id);
    try {
      await this.runControlReplay(ctx, recorded.id, input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`OutreachEvaluationRunner control replay failed: ${reason}`);
      await this.evaluation.markFailed(ctx.tenantId, recorded.id, reason.slice(0, 160));
    }
  }

  private async runControlReplay(
    ctx: TenantContext,
    evaluationId: string,
    input: OutreachEvaluationInput,
  ): Promise<void> {
    const { request, enrichment, policy, pinned, pinnedCreds, governed, plan, styleSamples, recipientBrief } = input;
    const now = new Date();

    // The ONLY thing that changes: the five institutional SteeringLayers are
    // withheld from a COPY of the treatment's own frozen packet. Evidence,
    // coverage, subject scope, and every authoritative field are untouched.
    const controlProjectedPacket = buildInstitutionalContextControlProjection(
      governed.packet as { items?: unknown; rendered?: unknown; exclusions?: unknown },
    );
    const controlGoverned: typeof governed = { ...governed, packet: controlProjectedPacket };

    // A NEW, separate persisted packet — never the treatment's own row.
    // packetId is deliberately omitted even if request.packetId was set.
    const controlPacket = await this.packets.compileOutreachPacket(ctx, {
      surface: request.surface,
      clientId: request.clientId,
      ref: request.ref ?? { outreachRecordId: request.outreachRecordId ?? null, generationKey: request.recipient.generationKey },
      items: request.items,
      policy,
      modelPolicy: {
        provider: pinned.provider,
        model: pinned.model,
        planModel: pinned.planModel,
        promptSpecVersion: pinned.promptSpecVersion,
        usedTenantKey: pinnedCreds[0]?.usedTenantKey,
      },
      emailScope: input.packet.emailScope,
      scanRequired: input.scanRequired,
      wallAllowsClient: input.wallAllowsClient,
      audience: policy.jurisdiction === 'internal' ? 'internal' : 'external',
      recipientEmails: request.recipient.email ? [request.recipient.email.trim().toLowerCase()] : [],
      requestDirectives: input.requestDirectives,
      enrichments: enrichment.channels,
      includeRelevantEmail: enrichment.includeRelevantEmail,
      topicTerms: enrichment.topicTerms,
      // Lenient here: a control packet that cannot persist should fail this
      // one evaluation, never block anything — but persisting IS attempted
      // for real, so a persistence bug in the shared compiler still shows up.
      failClosedOnPersist: false,
      now,
      recipientIdentityResolved: Boolean(request.recipient.email || request.recipient.name),
      governedContext: controlGoverned,
      ...(input.authHeader ? { authHeader: input.authHeader } : {}),
    });

    const controlStyleProfile = await this.styles.getProfile(ctx, request.clientId, {
      creds: pinnedCreds,
      now,
      runtimeAction: request.runtimeAction,
      voiceMemory: projectUserVoice(controlProjectedPacket),
    });

    const controlPlanResult = await this.plans.buildPlan(ctx, {
      runtimeAction: request.runtimeAction,
      packet: controlPacket,
      policy,
      creds: pinnedCreds,
      recipientBrief,
      audienceKind: request.audienceKind,
      ...(request.groupMemberCount != null ? { groupMemberCount: request.groupMemberCount } : {}),
      clientName: enrichment.clientName,
      tone: request.tone,
      ...(pinned.reasoningEffort ? { reasoningEffort: pinned.reasoningEffort } : {}),
    });

    const controlPrompt = buildGatewayPrompt({
      packet: controlPacket,
      policy,
      plan: controlPlanResult.plan,
      styleProfile: controlStyleProfile,
      styleProfileBlock: controlStyleProfile ? this.styles.renderProfileBlock(controlStyleProfile) : null,
      styleSamples,
      recipientBrief,
      clientBrief: enrichment.clientBrief,
      audienceKind: request.audienceKind,
      ...(request.groupMemberCount != null ? { groupMemberCount: request.groupMemberCount } : {}),
      tone: request.tone,
      length: request.length ?? null,
      senderName: null,
      existingSubject: request.existingSubject ?? null,
      existingBody: request.existingBody ?? null,
      recipientScopeKeys: request.recipient.scopeKeys,
    });

    const cred = pinnedCreds[0];
    if (!cred) throw new Error('evaluation_control_no_credential');

    const startedAt = Date.now();
    const completion = await this.llm.complete({
      runtimeAction: request.runtimeAction,
      provider: cred.provider,
      apiKey: cred.apiKey,
      model: pinned.model,
      system: controlPrompt.system,
      userStatic: controlPrompt.userStatic,
      userVolatile: controlPrompt.userVolatile,
      jsonSchema: GATEWAY_DRAFT_JSON_SCHEMA as unknown as Record<string, unknown>,
      jsonSchemaName: 'outreach_draft_evaluation_control',
      cacheSystem: true,
      cacheUserStatic: true,
      timeoutMs: LLM_LONG_GENERATION_TIMEOUT_MS,
      ...(pinned.reasoningEffort ? { reasoningEffort: pinned.reasoningEffort } : {}),
    });
    const providerDurationMs = Date.now() - startedAt;

    const parsed = parseDraft(completion.text);
    const controlSubject = parsed?.subject ?? '';
    const controlBody = parsed?.body ?? '';

    // A real, existing product check — never a second heuristic invented
    // just for evaluation — proves whether the institutional-context-
    // withheld draft still passes the SAME deterministic verifiers the real
    // pipeline gates on.
    const controlVerdict = parsed
      ? this.verifier.verify({
          subject: controlSubject,
          body: controlBody,
          packet: controlPacket,
          policy,
          plan: controlPlanResult.plan,
          audienceKind: request.audienceKind,
          now,
        })
      : null;

    const editMetrics = computeEditMetrics(input.treatmentBody, controlBody);

    await this.evaluation.markCompleted(ctx.tenantId, evaluationId, {
      treatmentOutputHash: hashText(`${input.treatmentSubject}\n${input.treatmentBody}`),
      controlOutputHash: hashText(`${controlSubject}\n${controlBody}`),
      controlProjectionPolicy: 'withhold_all_institutional_layers',
      metrics: {
        controlProducedOutput: parsed !== null,
        normalizedEditDistance: editMetrics?.normalizedEditDistance ?? null,
        percentChanged: editMetrics?.percentChanged ?? null,
        treatmentBodyLength: input.treatmentBody.length,
        controlBodyLength: controlBody.length,
        controlVerifierHeld: controlVerdict?.held ?? null,
        controlVerifierFindingCount: controlVerdict?.findings.length ?? null,
        controlPacketCriticalFailureCount: controlPacket.criticalFailureCount,
      },
      cost: {
        model: pinned.model,
        inputTokens: completion.usage?.inputTokens ?? null,
        outputTokens: completion.usage?.outputTokens ?? null,
        providerDurationMs,
        estimatedCostUsd: null,
      },
    });
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
