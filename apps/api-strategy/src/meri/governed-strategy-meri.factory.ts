import { Logger, NotFoundException } from '@nestjs/common';
import type { MeriService } from './meri.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AssistantDto, DraftStrategyDto } from './dto/meri.dto.js';
import type { NodeDocumentDraftResponse } from './meri.types.js';
import { StrategyContextPlaneClient } from './strategy-context-plane.client.js';
import { runWithStrategyGovernedContext } from './strategy-governed-context.runtime.js';

export const RAW_STRATEGY_MERI_SERVICE = Symbol('RAW_STRATEGY_MERI_SERVICE');

interface ExecutionDocumentInput {
  kind: 'workspace_draft' | 'outreach_record';
  clientId: string | null;
  strategyType: string;
  goal: string | null;
  node: {
    id: string;
    kind: string;
    subject: string;
    title: string;
    note: string | null;
    startsOn: string | null;
    endsOn: string | null;
  };
}

/**
 * Phase 25/26 compatibility wrapper around the mature Strategy mutation engine.
 *
 * The raw service keeps validation, verifier, versioning, conversations,
 * provenance checks, approvals and persistence. This wrapper owns only the
 * pre-reasoning cutover: every draft/edit/document call resolves one governed
 * Context Plane bundle and exposes it to the outbound orchestrator client through
 * AsyncLocalStorage. A Context Plane failure cannot silently call the model via
 * the old Strategy Context Pack.
 */
export function createGovernedStrategyMeriService(
  service: MeriService,
  contextPlane: StrategyContextPlaneClient,
  prisma: PrismaService,
): MeriService {
  const logger = new Logger('GovernedStrategyMeri');
  const internal = service as unknown as {
    draft: MeriService['draft'];
    assistant: MeriService['assistant'];
    draftExecutionDocument: (
      tenantId: string,
      bearer: string,
      input: ExecutionDocumentInput,
    ) => Promise<NodeDocumentDraftResponse | null>;
  };

  const originalDraft = service.draft.bind(service);
  internal.draft = (async (
    tenantId: string,
    clerkUserId: string,
    bearer: string | undefined,
    dto: DraftStrategyDto,
  ) => {
    const governed = await contextPlane.compile({
      tenantId,
      clerkUserId,
      clientId: dto.clientId,
      mode: 'draft',
      query: [dto.goal, dto.meriContext].filter(Boolean).join('\n'),
      traceId: dto.clientId,
    });
    return runWithStrategyGovernedContext(governed, () =>
      originalDraft(tenantId, clerkUserId, bearer, dto),
    );
  }) as MeriService['draft'];

  const originalAssistant = service.assistant.bind(service);
  internal.assistant = (async (
    tenantId: string,
    clerkUserId: string,
    bearer: string | undefined,
    strategyId: string,
    dto: AssistantDto,
  ) => {
    const strategy = await prisma.withTenant(tenantId, (tx) =>
      tx.spStrategy.findFirst({
        where: { id: strategyId },
        select: { clientId: true },
      }),
    );
    if (!strategy) throw new NotFoundException('Strategy not found');
    const governed = await contextPlane.compile({
      tenantId,
      clerkUserId,
      clientId: strategy.clientId,
      mode: 'assistant',
      query: dto.instruction,
      strategyId,
      nodeId: dto.scope === 'node' ? dto.nodeId ?? null : null,
      traceId: dto.clientMessageId,
    });
    return runWithStrategyGovernedContext(governed, () =>
      originalAssistant(tenantId, clerkUserId, bearer, strategyId, dto),
    );
  }) as MeriService['assistant'];

  const originalDocument = internal.draftExecutionDocument.bind(service);
  internal.draftExecutionDocument = async (
    tenantId: string,
    bearer: string,
    input: ExecutionDocumentInput,
  ) => {
    if (!input.clientId) return null;
    const clerkUserId = clerkUserIdFromBearer(bearer);
    if (!clerkUserId) {
      logger.warn('Strategy document generation skipped: caller identity is unavailable');
      return null;
    }
    try {
      const governed = await contextPlane.compile({
        tenantId,
        clerkUserId,
        clientId: input.clientId,
        mode: 'document',
        artifactKind: input.kind,
        query: `${input.node.title} ${input.goal ?? ''}`.trim(),
        nodeId: input.node.id,
        traceId: input.node.id,
      });
      return runWithStrategyGovernedContext(governed, () =>
        originalDocument(tenantId, bearer, input),
      );
    } catch (error) {
      // Existing Stage-G semantics allow a deterministic placeholder when AI
      // generation is unavailable. The important invariant is that the provider
      // is never reached without governed context.
      logger.warn(
        `Strategy document governed context unavailable; using deterministic placeholder: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  };

  return service;
}

/**
 * The bearer has already passed TenantGuard. We only extract its Clerk `sub` as
 * an identity hint for the main API, which independently re-resolves membership,
 * wall access and mailbox ownership before issuing a packet.
 */
function clerkUserIdFromBearer(bearer: string): string | null {
  try {
    const token = bearer.replace(/^Bearer\s+/i, '').trim();
    const payload = token.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
    };
    return typeof decoded.sub === 'string' && decoded.sub.trim() ? decoded.sub.trim() : null;
  } catch {
    return null;
  }
}
