import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import {
  verifyMeriGovernedContext,
  validateMeriGovernedArtifactPolicy,
  MERI_CASE46,
} from '@capiro/meriv2-core';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import { TenantGuard } from '../../auth/tenant.guard.js';
import type { OrchestratorTenantContext } from '../../auth/tenant-context.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import {
  validateServerReadonlyCapturePolicy,
  withTrustedCurrentTurnScope,
} from '../../request/trusted-current-turn-scope.js';
import { parseAiProviderHeader } from '../meri.controller.js';
import { MeriContextResolver } from '../meri-context.resolver.js';
import {
  runWithGovernedMeriContext,
  withGovernedPrompt,
} from '../meri-governed-context.runtime.js';
import { MeriV3AccessService } from './meriv3-access.service.js';
import { MeriV3AssistantService } from './meriv3-assistant.service.js';
import { listMeriV3ReasoningProfiles } from './meriv3-reasoning.js';
import type { MeriV3ChatInput } from './meriv3.types.js';
import { meriEvidenceManifest } from './meriv3-context-evidence.js';
import { reconcileMeriTurnCoverage } from './meriv3-turn-coverage.js';
import {
  MeriProcedureBindingError,
  requireMeriProcedureBinding,
} from './meriv3-procedure-guard.js';
import {
  MeriV3ResearchPlanExecutionError,
  requireMeriV3ResearchPlanExecution,
} from './meriv3-plan-execution.js';
import { admitMeriTelemetryContext, createMeriTelemetryContext } from '@capiro/meriv2-core';
import {
  currentMeriTaskUsage,
  emitMeriOrchestratorTelemetry,
  runWithMeriOrchestratorTelemetry,
} from '../../telemetry/meri-telemetry.runtime.js';
import { buildSignedOrchestratorCaptureEvidence } from './meriv3-capture-evidence.js';

type GovernedMeriV3ChatInput = MeriV3ChatInput & { governedContext?: MeriGovernedTurnContext };

@Controller('v3/chat')
@UseGuards(TenantGuard)
export class MeriV3Controller {
  private readonly logger = new Logger(MeriV3Controller.name);

  constructor(
    private readonly access: MeriV3AccessService,
    private readonly resolver: MeriContextResolver,
    private readonly assistant: MeriV3AssistantService,
  ) {}

  @Get('capabilities')
  async capabilities(@CurrentTenant() tenant: OrchestratorTenantContext) {
    await this.assertAllowed(tenant.tenantId);
    return {
      runtime: 'meriv3' as const,
      defaultMode: 'standard' as const,
      modes: listMeriV3ReasoningProfiles().map((profile) => ({
        mode: profile.mode,
        label: profile.label,
        description: profile.description,
        effort: profile.effort,
      })),
      rawReasoningVisible: false,
      storeProviderState: false,
    };
  }

  @Post()
  async run(
    @Body() dto: GovernedMeriV3ChatInput,
    @CurrentTenant() tenant: OrchestratorTenantContext,
    @Req() req: Request,
  ) {
    await this.assertAllowed(tenant.tenantId);
    const execute = async () => {
      const governed = requireGovernedContext(dto);
      const meriContext = await this.resolver.resolveIdentity(tenant);
      authenticateGovernedContext(governed, dto, meriContext);
      validateCapturePolicy(governed, dto, meriContext);
      authenticateResearchPlanExecution(dto, meriContext);
      const procedure = authenticateProcedureBinding(governed, dto, meriContext);
      const telemetry = this.telemetryContext(dto, meriContext);
      return runWithMeriOrchestratorTelemetry(
        telemetry,
        (line) => this.logger.log(line),
        async () => {
          const startedAt = Date.now();
          let outcome = 'returned';
          emitMeriOrchestratorTelemetry({
            name: 'meri.orchestrator.request.received',
            boundary: 'api_orchestrator',
            runtime: 'meriv3',
            clientId: dto.clientId ?? null,
            outcome: 'accepted',
          });
          try {
            meriContext.contextPacket = governed.contextPacket;
            const effectiveDto = {
              ...dto,
              ...(governed.serverReadonlyCapturePolicy
                ? {
                    toolPolicy:
                      dto.toolPolicy === 'none' ? ('none' as const) : ('read-only' as const),
                    pageWrite: false,
                  }
                : {}),

              // Bound turns consume only the server-resolved signed instruction.
              skillAddendum: withGovernedPrompt(
                procedure?.instruction ?? dto.skillAddendum,
                governed,
              ),
            };
            const run = async () => this.assistant.run(meriContext, effectiveDto);
            const result = await withTrustedCurrentTurnScope(
              trustedCurrentTurnScope(meriContext, dto, governed),
              () => runWithGovernedMeriContext(governed, run),
            );
            outcome = result.telemetry?.partial ? 'partial' : 'returned';
            return {
              ...result,
              contextPacket: governed.contextPacket,
              retrieval: reconcileMeriTurnCoverage(governed.retrieval, result.toolCoverage ?? []),
              evidenceManifest:
                result.evidenceManifest ?? meriEvidenceManifest(governed, result.citations ?? []),
            };
          } catch (error) {
            outcome = 'error';
            throw error;
          } finally {
            emitMeriOrchestratorTelemetry({
              name: 'meri.orchestrator.request.finalized',
              boundary: 'api_orchestrator',
              runtime: 'meriv3',
              clientId: dto.clientId ?? null,
              outcome,
              durationMs: Date.now() - startedAt,
              usage: currentMeriTaskUsage(),
            });
          }
        },
      );
    };
    return this.withRequestCredentials(req, execute);
  }

  @Post('stream')
  async stream(
    @Body() dto: GovernedMeriV3ChatInput,
    @CurrentTenant() tenant: OrchestratorTenantContext,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.assertAllowed(tenant.tenantId);
    // Reject forged context before opening SSE or starting its keep-alive.
    const governed = requireGovernedContext(dto);
    const meriContext = await this.resolver.resolveIdentity(tenant);
    authenticateGovernedContext(governed, dto, meriContext);
    authenticateResearchPlanExecution(dto, meriContext);
    const procedure = authenticateProcedureBinding(governed, dto, meriContext);
    validateCapturePolicy(governed, dto, meriContext);
    const telemetry = this.telemetryContext(dto, meriContext);
    res.setHeader('x-request-id', telemetry.requestId);
    res.setHeader('x-capiro-trace-id', telemetry.traceId);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const abort = new AbortController();
    const onAbort = () => abort.abort(new DOMException('Client disconnected', 'AbortError'));
    const onClose = () => {
      if (!res.writableEnded) onAbort();
    };
    req.once('aborted', onAbort);
    res.once('close', onClose);
    res.once('error', onAbort);
    if (req.aborted || res.destroyed) onAbort();
    const frame = (event: unknown) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    // SSE keep-alive: during long no-tools synthesis the assistant can emit no
    // frames for many minutes. Idle hops between apps/api and the orchestrator
    // then tear the connection down (2026-09-01: "terminated" at exactly
    // 600,233ms while the turn completed server-side ~5 minutes later and its
    // output was discarded). A tiny SSE comment every 20s feeds every
    // intermediate hop's idle timer. SSE comments are ignored by standard
    // parsers, and the apps/api reader only treats lines starting with
    // "data: " as frames, so this is invisible to it by construction.
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 20_000);

    const execute = async () => {
      const startedAt = Date.now();
      let outcome = 'returned';
      emitMeriOrchestratorTelemetry({
        name: 'meri.orchestrator.request.received',
        boundary: 'api_orchestrator',
        runtime: 'meriv3',
        clientId: dto.clientId ?? null,
        outcome: 'accepted',
      });
      meriContext.contextPacket = governed.contextPacket;
      const effectiveDto = {
        ...dto,
        ...(governed.serverReadonlyCapturePolicy
          ? {
              toolPolicy: dto.toolPolicy === 'none' ? ('none' as const) : ('read-only' as const),
              pageWrite: false,
            }
          : {}),
        skillAddendum: withGovernedPrompt(procedure?.instruction ?? dto.skillAddendum, governed),
      };
      frame({
        type: 'start',
        runtime: 'meriv3',
        reasoningMode: dto?.reasoningMode ?? 'standard',
      });
      try {
        const run = async () =>
          this.assistant.run(meriContext, effectiveDto, {
            onEvent: frame,
            signal: abort.signal,
          });
        const result = await withTrustedCurrentTurnScope(
          trustedCurrentTurnScope(meriContext, dto, governed),
          () => runWithGovernedMeriContext(governed, run),
        );
        outcome = result.telemetry?.partial ? 'partial' : 'returned';
        const orchestratorCaptureEvidence =
          governed.serverReadonlyCapturePolicy && result.captureEvidence
            ? buildSignedOrchestratorCaptureEvidence({
                policy: governed.serverReadonlyCapturePolicy,
                startedAt: result.captureEvidence.startedAt,
                completedAt: result.captureEvidence.completedAt,
                providerCallObserved: result.captureEvidence.providerCallObserved,
                provider: 'openai',
                model: result.model,
                usage: result.captureEvidence.usage ?? null,
                execution: result.captureEvidence,
                secret: process.env.INTERNAL_SERVICE_SECRET,
              })
            : null;
        frame({
          type: 'done',
          reply: result.reply,
          runtime: result.runtime,
          model: result.model,
          reasoningMode: result.reasoningMode,
          reasoningEffort: result.reasoningEffort,
          ...(result.telemetry ? { telemetry: result.telemetry } : {}),
          ...(result.providerCalls ? { providerCalls: result.providerCalls } : {}),
          steps: result.steps ?? [],
          ...(result.intent ? { intent: result.intent } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.citations?.length ? { citations: result.citations } : {}),
          ...(result.pendingApprovals?.length ? { pendingApprovals: result.pendingApprovals } : {}),
          ...(dto.toolPolicy ? { held: result.held ?? false } : {}),
          ...(dto.toolPolicy === 'read-only' ? { ledgerEntries: result.ledgerEntries ?? [] } : {}),
          retrieval: reconcileMeriTurnCoverage(governed.retrieval, result.toolCoverage ?? []),
          contextPacket: governed.contextPacket,
          evidenceManifest:
            result.evidenceManifest ?? meriEvidenceManifest(governed, result.citations ?? []),
          aborted: abort.signal.aborted,
          ...(governed.serverReadonlyCapturePolicy
            ? { serverReadonlyCaptureReceipt: captureReceipt(governed.serverReadonlyCapturePolicy) }
            : {}),
          ...(orchestratorCaptureEvidence
            ? { serverCaptureEvidenceObservation: orchestratorCaptureEvidence }
            : {}),
        });
      } catch (error) {
        outcome = abort.signal.aborted ? 'aborted' : 'error';
        frame({
          type: 'error',
          message: publicMeriRuntimeError(error),
        });
      } finally {
        if (abort.signal.aborted) outcome = 'aborted';
        emitMeriOrchestratorTelemetry({
          name: 'meri.orchestrator.request.finalized',
          boundary: 'api_orchestrator',
          runtime: 'meriv3',
          clientId: dto.clientId ?? null,
          outcome,
          durationMs: Date.now() - startedAt,
          usage: currentMeriTaskUsage(),
        });
        clearInterval(keepAlive);
        req.removeListener('aborted', onAbort);
        res.removeListener('close', onClose);
        res.removeListener('error', onAbort);
        if (!res.writableEnded) res.end();
      }
    };

    await runWithMeriOrchestratorTelemetry(
      telemetry,
      (line) => this.logger.log(line),
      () => this.withRequestCredentials(req, execute),
    );
  }

  private async assertAllowed(tenantId: string): Promise<void> {
    if (!(await this.access.isAllowed(tenantId))) {
      // 404 rather than 403. The API refuses a closed tenant before it calls
      // here ("Meri is unavailable"); this is defense in depth.
      throw new NotFoundException('Chat runtime not found');
    }
  }

  private withRequestCredentials<T>(req: Request, execute: () => Promise<T>): Promise<T> {
    const bearerToken = extractBearerToken(req) ?? '';
    const aiProvider = parseAiProviderHeader(req);
    const impersonateTenantId = extractImpersonateTenant(req);
    return bearerToken || aiProvider || impersonateTenantId
      ? RequestCredentialsStore.run(
          {
            bearerToken,
            ...(aiProvider ? { aiProvider } : {}),
            ...(impersonateTenantId ? { impersonateTenantId } : {}),
          },
          execute,
        )
      : execute();
  }

  private telemetryContext(
    dto: GovernedMeriV3ChatInput,
    identity: { tenantId: string; userId: string },
  ) {
    return (
      admitMeriTelemetryContext(dto.governedContext?.telemetryContext, {
        tenantId: identity.tenantId,
        actorId: identity.userId,
        conversationId: dto.conversationId ?? null,
      }) ??
      createMeriTelemetryContext({
        tenantId: identity.tenantId,
        actorId: identity.userId,
        conversationId: dto.conversationId ?? null,
        release: process.env.RELEASE_SHA ?? process.env.GIT_SHA ?? process.env.IMAGE_TAG ?? null,
      })
    );
  }
}

function publicMeriRuntimeError(error: unknown): string {
  if (error instanceof Error && error.name === 'ResearchRunInactiveError') {
    return 'Research is stopped, superseded, or no longer accessible.';
  }
  return 'The MeriV3 reasoning runtime could not complete this turn.';
}

function requireGovernedContext(dto: GovernedMeriV3ChatInput): MeriGovernedTurnContext {
  if (!dto?.governedContext) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Governed Context Plane input required',
      code: 'meri_governed_context_required',
    });
  }
  return dto.governedContext;
}

function authenticateGovernedContext(
  governed: MeriGovernedTurnContext,
  dto: MeriV3ChatInput,
  identity: { tenantId: string; userId: string },
): void {
  try {
    verifyMeriGovernedContext(governed, dto, identity, process.env.INTERNAL_SERVICE_SECRET);
  } catch {
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Authenticated Context Plane input required',
      code: 'meri_governed_context_authentication_failed',
    });
  }
}

function authenticateProcedureBinding(
  governed: MeriGovernedTurnContext,
  dto: MeriV3ChatInput,
  identity: { tenantId: string },
) {
  try {
    return requireMeriProcedureBinding({ governed, dto, tenantId: identity.tenantId });
  } catch (error) {
    if (!(error instanceof MeriProcedureBindingError)) throw error;
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Current served procedure binding required',
      code: 'meri_procedure_binding_invalid',
    });
  }
}

function authenticateResearchPlanExecution(
  dto: MeriV3ChatInput,
  identity: { tenantId: string; userId: string },
): void {
  try {
    requireMeriV3ResearchPlanExecution(dto, identity);
  } catch (error) {
    if (!(error instanceof MeriV3ResearchPlanExecutionError)) throw error;
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Authenticated admitted research plan required',
      code: 'meri_research_plan_execution_envelope_invalid',
    });
  }
}

function trustedCurrentTurnScope(
  identity: { tenantId: string; userId: string },
  dto: MeriV3ChatInput,
  governed: MeriGovernedTurnContext,
) {
  return {
    tenantId: identity.tenantId,
    userId: identity.userId,
    conversationId: dto.conversationId ?? null,
    selectedClientId: dto.clientId ?? null,
    ...(governed.serverReadonlyCapturePolicy
      ? { capturePolicy: governed.serverReadonlyCapturePolicy }
      : {}),
    ...(governed.governedArtifactCapturePolicy
      ? { governedArtifactPolicy: governed.governedArtifactCapturePolicy }
      : {}),
  };
}

function validateCapturePolicy(
  governed: MeriGovernedTurnContext,
  dto: MeriV3ChatInput,
  identity: { tenantId: string; userId: string },
): void {
  if (governed.governedArtifactCapturePolicy) {
    try {
      if (!dto.conversationId || !dto.clientId) throw new Error('meri_case46_turn_scope');
      const artifact = validateMeriGovernedArtifactPolicy(governed.governedArtifactCapturePolicy, {
        tenantId: identity.tenantId,
        actorUserId: identity.userId,
        conversationId: dto.conversationId,
        clientId: dto.clientId,
      });
      if (
        governed.serverReadonlyCapturePolicy ||
        !artifact.turnId ||
        dto.researchRun ||
        dto.researchPlanExecution ||
        dto.toolPolicy ||
        dto.pageWrite ||
        dto.currentTurnImages?.length ||
        dto.messages?.length !== 1 ||
        dto.messages[0]?.role !== 'user' ||
        dto.messages[0]?.text !== MERI_CASE46.prompt
      )
        throw new Error('meri_case46_turn_scope');
    } catch {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Current governed artifact authority required',
        code: 'meri_governed_artifact_authentication_failed',
      });
    }
  }
  const policy = governed.serverReadonlyCapturePolicy;
  if (!policy) return;
  try {
    validateServerReadonlyCapturePolicy(policy, {
      tenantId: identity.tenantId,
      actorUserId: identity.userId,
      conversationId: dto.conversationId ?? null,
      clientId: dto.clientId ?? null,
    });
  } catch {
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Current server read-only capture authority required',
      code: 'meri_server_readonly_capture_authentication_failed',
    });
  }
}

function captureReceipt(
  policy: NonNullable<MeriGovernedTurnContext['serverReadonlyCapturePolicy']>,
) {
  return {
    version: 1 as const,
    policyId: policy.policyId,
    fixtureNamespace: policy.fixtureNamespace,
    authority: 'server_current' as const,
    tenantId: policy.tenantId,
    actorUserId: policy.actorUserId,
    conversationId: policy.conversationId,
    clientId: policy.clientId,
    issuedAt: policy.issuedAt,
    expiresAt: policy.expiresAt,
    toolCatalogSha256: policy.toolCatalogSha256,
    dispatchBoundary: 'read_only_enforced' as const,
    dynamicMcpAllowed: false as const,
    incidentalWriters: 'suppressed' as const,
    expectedCaptureWrites: policy.expectedCaptureWrites,
  };
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? req.headers['Authorization'];
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function extractImpersonateTenant(req: Request): string | null {
  const raw = req.headers['x-capiro-impersonate-tenant'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
