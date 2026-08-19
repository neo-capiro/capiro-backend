import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import type { AppConfig } from '../config/config.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AiCredentialResolverService } from '../engagement/ai-credential-resolver.service.js';
import type { ReviewsService } from '../reviews/reviews.service.js';
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
    return governedResearch.run(governed, () => originalStreamResearch(ctx, id, sse));
  }) as StreamResearch;

  return service;
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
