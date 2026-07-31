import type { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { ContextCompilerService } from '../context/context-compiler.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AiCredentialResolverService } from '../engagement/ai-credential-resolver.service.js';
import type { ReviewsService } from '../reviews/reviews.service.js';
import { MeriResearchService } from './meri-research.service.js';
import type { MeriToolsService } from './meri-tools.service.js';

type ResearchContextLoader = (
  ctx: TenantContext,
  clientId: string | null,
) => Promise<string | null>;

interface ResearchServiceInternals {
  clientContext: ResearchContextLoader;
}

/**
 * Decorate the existing research service without duplicating its long-running
 * agent loop. Off remains byte-compatible, shadow records comparisons without
 * changing prompts, and enforce appends the plain v2 governed context selected
 * by the research surface policy before either SSE stream emits a body event.
 */
export function createGovernedMeriResearchService(
  prisma: PrismaService,
  config: ConfigService<AppConfig, true>,
  tools: MeriToolsService,
  aiCredentials: AiCredentialResolverService,
  reviews: ReviewsService,
  contextCompiler: ContextCompilerService,
): MeriResearchService {
  const service = new MeriResearchService(prisma, config, tools, aiCredentials, reviews);
  const internal = service as unknown as ResearchServiceInternals;
  const legacyClientContext = internal.clientContext.bind(service);

  internal.clientContext = async (ctx, clientId) => {
    const baseline = await legacyClientContext(ctx, clientId);
    const mode = await contextCompiler.modeFor(ctx.tenantId, 'research');
    if (mode === 'off') return baseline;

    const packet = await contextCompiler.compile({
      tenantId: ctx.tenantId,
      effectiveTenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      userId: ctx.userId,
      clientId,
      surface: 'research',
      layers: [
        'firm-identity',
        'firm-playbook',
        'user-voice',
        ...(clientId ? (['client-steering', 'client-people'] as const) : []),
      ],
      render: 'all',
      ref: { clientId },
    });

    // Shadow must be indistinguishable from off to the model and product output.
    if (mode !== 'enforce' || packet.version !== 2) return baseline;

    const governed = packet.rendered
      .map((item) => item.body.trim())
      .filter(Boolean)
      .join('\n\n');
    const combined = [baseline?.trim() ?? '', governed].filter(Boolean).join('\n\n');
    return combined || null;
  };

  return service;
}
