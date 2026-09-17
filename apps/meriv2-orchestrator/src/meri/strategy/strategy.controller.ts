import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  runWithAssuranceRequestScope,
  type AssuranceSurface,
  type MeriGovernedTurnContext,
} from '@capiro/meriv2-core';
import { TenantGuard } from '../../auth/tenant.guard.js';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import type { OrchestratorTenantContext } from '../../auth/tenant-context.js';
import { MeriContextResolver } from '../meri-context.resolver.js';
import { runWithGovernedMeriContext } from '../meri-governed-context.runtime.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { parseAiProviderHeader } from '../meri.controller.js';
import { StrategyAssistantService } from './strategy-assistant.service.js';
import { StrategyReportNarrativeService } from './strategy-report-narrative.service.js';
import { parseReportNarrativeInput } from './strategy-report-narrative.prompt.js';
import type {
  StrategyAssistantInput,
  StrategyDocumentDraftInput,
  StrategyDraftInput,
  StrategyReferenceAssistInput,
} from './strategy-prompt.js';

type GovernedInput<T> = T & { governedContext?: MeriGovernedTurnContext };

/**
 * Strategy reasoning endpoints. api-strategy must first cross the main API's
 * ContextPlaneGatewayService, then proxy the resulting body under the shared
 * internal secret. The orchestrator resolves identity only and never compiles a
 * second client pack or runs delegated read tools for these operations.
 */
@Controller()
@UseGuards(TenantGuard)
export class StrategyController {
  constructor(
    private readonly resolver: MeriContextResolver,
    private readonly assistant: StrategyAssistantService,
    private readonly reportNarrative: StrategyReportNarrativeService,
  ) {}

  /**
   * Executive-report narrative. Not a governed Context Plane operation: the
   * body is the complete evidence packet api-strategy assembled from its
   * audience-filtered report snapshot, so no pack is compiled here. Internal
   * secret + delegated identity are still required.
   */
  @Post('strategy-report-narrative')
  async reportNarrativeDraft(
    @Body() dto: unknown,
    @CurrentTenant() tc: OrchestratorTenantContext,
    @Req() req: Request,
  ) {
    requireInternalContextProxy(req);
    const input = parseReportNarrativeInput(dto);
    if (!input) {
      throw new BadRequestException(
        'Report narrative requires an audience, strategy and evidence packet',
      );
    }
    const ctx = await this.resolver.resolveIdentity(tc);
    return this.scoped(req, () => this.reportNarrative.generate(ctx, input));
  }

  @Post('strategy-draft')
  async draft(
    @Body() dto: GovernedInput<StrategyDraftInput>,
    @CurrentTenant() tc: OrchestratorTenantContext,
    @Req() req: Request,
  ) {
    requireInternalContextProxy(req);
    const governed = requireGovernedContext(dto, 'strategies.generate', 'strategy');
    const ctx = await this.resolver.resolveIdentity(tc);
    ctx.contextPacket = governed.contextPacket;
    return this.scoped(req, () =>
      runWithGovernedMeriContext(governed, () => this.assistant.draft(ctx, dto)),
    );
  }

  /**
   * Streaming sibling of `strategy-draft` for api-strategy's async draft
   * worker (job-based drafting, so a single request/response no longer has to
   * fit inside the caller's own HTTP timeout). Same governed-context
   * contract and identical `draft()` call underneath — this route never
   * changes `strategy-draft`'s request/response shape, it only adds a second
   * way to invoke the SAME assistant call with progress streamed out.
   *
   * Wire format: newline-delimited JSON (`application/x-ndjson`), one object
   * per line —
   *   {"type":"progress","stage":"drafting","attempt":n,"round":n,"delta":"..."}
   *   {"type":"result", ...same shape strategy-draft returns on success}
   *   {"type":"error","message":"..."}
   * followed by `res.end()`. This is an internal server-to-server contract
   * (api-strategy's worker), not a browser EventSource, so no
   * `text/event-stream` framing is used.
   */
  @Post('strategy-draft-stream')
  async draftStream(
    @Body() dto: GovernedInput<StrategyDraftInput>,
    @CurrentTenant() tc: OrchestratorTenantContext,
    @Req() req: Request,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    requireInternalContextProxy(req);
    const governed = requireGovernedContext(dto, 'strategies.generate', 'strategy');

    // Registered before any `await` so a disconnect during identity resolution
    // (not just during the LLM call itself) is caught too. No global
    // request-timeout middleware exists in main.ts to exclude this route from,
    // and this app has no compression() middleware either — both confirmed by
    // inspection, so nothing else needs excluding for chunked flushing to work.
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    res.on('error', () => {
      /* socket errors on disconnect are expected */
    });

    const ctx = await this.resolver.resolveIdentity(tc);
    ctx.contextPacket = governed.contextPacket;

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    // Match the chat stream route's convention — prevents a proxy/load
    // balancer from buffering the whole (potentially multi-minute) body.
    res.setHeader('X-Accel-Buffering', 'no');

    const write = (obj: Record<string, unknown>) => {
      if (!res.writableEnded) {
        try {
          res.write(`${JSON.stringify(obj)}\n`);
        } catch {
          /* client gone mid-write */
        }
      }
    };

    await this.scoped(req, async () => {
      try {
        const result = await runWithGovernedMeriContext(governed, () =>
          this.assistant.draft(ctx, dto, {
            onProgress: (event) => write({ type: 'progress', ...event }),
            signal: abort.signal,
          }),
        );
        write({ type: 'result', ...result });
      } catch (error) {
        write({
          type: 'error',
          message: error instanceof Error ? error.message : 'Strategy draft failed',
        });
      } finally {
        if (!res.writableEnded) res.end();
      }
    });
  }

  @Post('strategy-assistant')
  async assistantEdit(
    @Body() dto: GovernedInput<StrategyAssistantInput>,
    @CurrentTenant() tc: OrchestratorTenantContext,
    @Req() req: Request,
  ) {
    requireInternalContextProxy(req);
    const governed = requireGovernedContext(dto, 'strategies.generate', 'strategy');
    const ctx = await this.resolver.resolveIdentity(tc);
    ctx.contextPacket = governed.contextPacket;
    return this.scoped(req, () =>
      runWithGovernedMeriContext(governed, () => this.assistant.assistant(ctx, dto)),
    );
  }

  /**
   * Execution Agent content generation uses the already-adopted destination
   * operation: Workspace generation for a workspace draft, Outreach generation
   * for an outreach record. A Strategy packet cannot be relabeled as either.
   */
  @Post('strategy-document-draft')
  async documentDraft(
    @Body() dto: GovernedInput<StrategyDocumentDraftInput>,
    @CurrentTenant() tc: OrchestratorTenantContext,
    @Req() req: Request,
  ) {
    requireInternalContextProxy(req);
    const surface = documentAssuranceSurface(dto.kind);
    const expectedOperation =
      dto.kind === 'workspace_draft' ? 'workspace.generate' : 'outreach.generate';
    const expectedPacketSurface = dto.kind === 'workspace_draft' ? 'workspace-gen' : 'outreach';
    const governed = requireGovernedContext(dto, expectedOperation, expectedPacketSurface);

    return runWithAssuranceRequestScope(tc.tenantId, surface, async () => {
      const ctx = await this.resolver.resolveIdentity(tc);
      ctx.contextPacket = governed.contextPacket;
      return this.scoped(req, () =>
        runWithGovernedMeriContext(governed, () => this.assistant.draftDocument(ctx, dto)),
      );
    });
  }

  /** Reference-calendar editing is not client Strategy generation. */
  @Post('strategy-reference-assist')
  async referenceAssist(
    @Body() dto: StrategyReferenceAssistInput,
    @CurrentTenant() tc: OrchestratorTenantContext,
    @Req() req: Request,
  ) {
    const ctx = await this.resolver.resolve(tc, null, 'strategy');
    return this.scoped(req, () => this.assistant.referenceAssist(ctx, dto));
  }

  private scoped<T>(req: Request, exec: () => Promise<T>): Promise<T> {
    const token = extractBearerToken(req);
    const aiProvider = parseAiProviderHeader(req);
    return token || aiProvider
      ? RequestCredentialsStore.run(
          { bearerToken: token ?? '', ...(aiProvider ? { aiProvider } : {}) },
          exec,
        )
      : exec();
  }
}

function requireInternalContextProxy(req: Request): void {
  const expected = process.env.INTERNAL_SERVICE_SECRET;
  const raw = req.headers['x-internal-service-secret'];
  const provided = Array.isArray(raw) ? raw[0] : raw;
  if (!expected || typeof provided !== 'string' || provided !== expected) {
    throw new ForbiddenException('Strategy governed context must come from the trusted API proxy');
  }
}

function requireGovernedContext(
  dto: { clientId: string; governedContext?: MeriGovernedTurnContext },
  expectedOperation: MeriGovernedTurnContext['operationId'],
  expectedSurface: string,
): MeriGovernedTurnContext {
  const governed = dto.governedContext;
  if (
    !governed ||
    governed.version !== 1 ||
    governed.operationId !== expectedOperation ||
    typeof governed.prompt !== 'string' ||
    !governed.prompt.trim() ||
    !governed.contextPacket ||
    governed.contextPacket.clientId !== dto.clientId ||
    governed.contextPacket.surface !== expectedSurface ||
    !governed.retrieval ||
    !governed.retrieval.coverage
  ) {
    throw new BadRequestException(
      'Strategy reasoning requires matching governed Context Plane input',
    );
  }
  return governed;
}

function documentAssuranceSurface(
  kind: StrategyDocumentDraftInput['kind'],
): Extract<AssuranceSurface, 'strategy' | 'outreach'> {
  if (kind === 'workspace_draft') return 'strategy';
  if (kind === 'outreach_record') return 'outreach';
  throw new BadRequestException('Unsupported strategy document artifact kind');
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? req.headers['Authorization'];
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}
