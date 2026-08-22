import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import {
  EVALUATION_CONFIG_VERSION,
  computeEvaluationSamplingKey,
  decideEvaluationEligibility,
  evaluationEnabled,
  learningTenantSelected,
} from '@capiro/meriv2-core';
import type { AppConfig } from '../config/config.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AiCredentialResolverService } from '../engagement/ai-credential-resolver.service.js';
import type { ReviewsService } from '../reviews/reviews.service.js';
import type { EvaluationCaptureService } from '../evaluation/evaluation-capture.service.js';
import { MeriContextPlaneService } from './meri-context-plane.service.js';
import { MeriResearchService } from './meri-research.service.js';
import type { MeriToolsService } from './meri-tools.service.js';

type ResearchContextLoader = (
  ctx: TenantContext,
  clientId: string | null,
) => Promise<string | null>;

type StreamPlan = MeriResearchService['streamPlan'];
type StreamResearch = MeriResearchService['streamResearch'];

interface ResearchServiceInternals {
  clientContext: ResearchContextLoader;
  streamPlan: StreamPlan;
  streamResearch: StreamResearch;
}

const governedResearch = new AsyncLocalStorage<MeriGovernedTurnContext>();

/**
 * Phase 19 adoption wrapper for the established long-running Deep Research loop.
 *
 * The service itself remains unchanged. Its public plan/research entrypoints are
 * wrapped so the session topic is resolved through the shared Context Plane
 * before any model call; the private clientContext seam then consumes only that
 * governed prompt. No direct ContextCompiler call or parallel research RAG path
 * remains on Capiro traffic.
 *
 * Planning uses `meri.research`. The gather+synthesize run uses
 * `research.generate-report`, so both Phase 19 operations are real enforced
 * boundaries rather than duplicate registry aliases.
 */
export function createGovernedMeriResearchService(
  prisma: PrismaService,
  config: ConfigService<AppConfig, true>,
  tools: MeriToolsService,
  aiCredentials: AiCredentialResolverService,
  reviews: ReviewsService,
  contextPlane: MeriContextPlaneService,
  // Phase 27F — optional, same contract as elsewhere in this program: absent
  // means no evaluation decision is ever recorded, no other behavior change.
  evaluation?: EvaluationCaptureService,
): MeriResearchService {
  const service = new MeriResearchService(prisma, config, tools, aiCredentials, reviews);
  const internal = service as unknown as ResearchServiceInternals;
  const legacyClientContext = internal.clientContext.bind(service);
  const originalStreamPlan = service.streamPlan.bind(service);
  const originalStreamResearch = service.streamResearch.bind(service);

  internal.clientContext = async (ctx, clientId) => {
    const governed = governedResearch.getStore();
    if (governed) return governed.prompt || null;
    // Compatibility only for direct/unwrapped use. The Nest provider below wraps
    // both public research entrypoints, so normal product traffic never reaches
    // this legacy loader after Phase 19.
    return legacyClientContext(ctx, clientId);
  };

  internal.streamPlan = (async (ctx, id, sse) => {
    const governed = await resolveSessionContext(
      prisma,
      contextPlane,
      ctx,
      id,
      'meri.research',
    );
    return governedResearch.run(governed, () => originalStreamPlan(ctx, id, sse));
  }) as StreamPlan;

  internal.streamResearch = (async (ctx, id, sse) => {
    const governed = await resolveSessionContext(
      prisma,
      contextPlane,
      ctx,
      id,
      'research.generate-report',
    );
    // Phase 27F: record a real eligibility/sampling decision for every Deep
    // Research turn — genuinely exercised infrastructure, not a stub. The
    // control-arm REPLAY is not implemented for this surface yet (Deep
    // Research is a full multi-turn agentic loop with real side effects,
    // not a single isolated generation call like Outreach/CRM Fill's
    // extraction methods — see the Phase 27F closeout notes), so this
    // consistently records `unsupported_operation` today. Flipping that to
    // a real replay later is a pure additive follow-up: this decision path
    // and its sampling key are already live.
    void considerMeriResearchEvaluation(evaluation, ctx, id, governed).catch(() => undefined);
    return governedResearch.run(governed, () => originalStreamResearch(ctx, id, sse));
  }) as StreamResearch;

  return service;
}

/**
 * Phase 27F — real eligibility/sampling decision for a Deep Research turn.
 * See the `streamResearch` wrapper's own comment for why the control-arm
 * replay is not implemented for this surface yet: this consistently
 * records `unsupported_operation` today, never a fabricated comparison.
 * Never throws (evaluation must never affect the real research turn).
 */
async function considerMeriResearchEvaluation(
  evaluation: EvaluationCaptureService | undefined,
  ctx: TenantContext,
  sessionId: string,
  governed: MeriGovernedTurnContext,
): Promise<void> {
  if (!evaluation || !evaluationEnabled(process.env.LEARNING_EVALUATION)) return;
  // Phase 27G rollout bound — see learningTenantSelected. Meri has no
  // control replay yet, so this only suppresses the eligibility decision
  // ROW for a tenant outside the allowlist; it changes no research turn.
  if (!learningTenantSelected(ctx.tenantId)) return;
  const contextPacketId = governed.contextPacket.packetId ?? null;
  const institutionalItemCount = governed.contextPacket.items.length;
  const eligibility = decideEvaluationEligibility({
    enabled: true,
    contextPacketId,
    institutionalItemCount,
    authoritativeInputReplayable: true,
    // Deep Research's streamResearch is a full multi-turn agentic loop with
    // real side effects (tool calls, a persisted report) — not a single
    // isolated generation call. A safe, non-mutating shadow replay for it
    // is real future work, not something this phase fabricates.
    operationSupported: false,
    providerAvailable: true,
    withinBudget: true,
  });
  const samplingKey = computeEvaluationSamplingKey({
    tenantId: ctx.tenantId,
    operation: 'meri.research.generate-report',
    artifactId: sessionId,
  });
  // operationSupported is always false above, so eligibility is always
  // { eligible: false, reason: 'unsupported_operation' } today — the
  // eligible branch cannot occur until a real replay is implemented.
  await evaluation.recordDecision({
    tenantId: ctx.tenantId,
    surface: 'meri',
    operation: 'meri.research.generate-report',
    evaluationType: 'institutional_context_ablation',
    status: 'skipped',
    skipReason: eligibility.eligible ? 'unsupported_operation' : eligibility.reason,
    contextPacketId,
    treatmentArtifactId: sessionId,
    samplingKey,
    configVersion: EVALUATION_CONFIG_VERSION,
    observedAt: new Date(),
  });
}

async function resolveSessionContext(
  prisma: PrismaService,
  contextPlane: MeriContextPlaneService,
  ctx: TenantContext,
  sessionId: string,
  operationId: 'meri.research' | 'research.generate-report',
): Promise<MeriGovernedTurnContext> {
  const session = await prisma.withTenant(ctx.tenantId, (tx) =>
    tx.clioResearchSession.findFirst({
      where: { id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId },
      select: { topic: true, clientId: true },
    }),
  );
  if (!session) throw new Error('meri_context_plane_research_session_not_found');
  return contextPlane.resolveResearch(ctx, {
    task: session.topic,
    clientId: session.clientId,
    operationId,
    sessionId,
  });
}
