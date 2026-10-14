import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Patch,
  Post,
  NotFoundException,
  UnprocessableEntityException,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';
import type { Request, Response } from 'express';
import type { TenantContext } from '@capiro/shared';
import { classifyApiToolReadOutcome } from '@capiro/shared/meri-read-outcome';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { MeriV3InternalServiceGuard } from './meri-v3-internal-service.guard.js';
import { MeriService } from './meri.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { MeriResearchService } from './meri-research.service.js';
import { MERI_JOB_KINDS, type MeriJobKind } from './meri-job.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { MeriMcpService, type CatalogAddInput, type McpServerInput } from './meri-mcp.service.js';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { MeriProcedureRuntimeValidationService } from './meri-procedure-runtime-validation.service.js';
import { MeriApprovalService } from './meri-approval.service.js';
import { MeriComplianceAuditService } from './meri-compliance-audit.service.js';
import { MeriClaimWriterService } from './meri-claim-writer.js';
import { renderReportToBrowserHtml, renderReportToWordHtml } from './meri-research.helpers.js';
import { runMeriStreamWithSetupGuard } from './meri-stream-preflight.helpers.js';
import { withMeriToolRequestControl } from './meri-tool-request-control.js';
import { withMeriChatAttachmentReadScope } from './meri-chat-attachment-read-scope.js';
import { admitMeriChatAttachmentTransport } from './meri-chat-attachment-transport.js';
import {
  admitMeriResearchPortfolioToolTransport,
  withMeriResearchPortfolioToolTurnScope,
} from './meri-rp-tool-transport.js';
import { MeriPdfRenderError } from './meri-docgen-pdf.js';
import { sha256Bytes, validateDocumentArtifactBytes } from './meri-artifact-integrity.js';
import type { AssuranceSurface } from '@capiro/meriv2-core';
import {
  admitMeriInternalTelemetry,
  createMeriApiTelemetryContext,
  emitMeriApiTelemetry,
  runWithMeriApiTelemetry,
  withMeriApiTelemetrySpan,
} from './meri-telemetry.runtime.js';

class CreateMeriConversationDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsUUID()
  // Phase 4 server-only slice: the ONLY prospect scope field the client may
  // supply. Everything else about the prospect scope is resolved server-side.
  prospectId?: string;

  @IsOptional()
  @IsUUID()
  // Distinct from legacy Meri "portfolio" scope (all clients). The server
  // resolves this id to a bounded, authorized receipt before persistence.
  researchPortfolioId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  title?: string;
}

class SendMeriMessageDto {
  // Length 0 allowed: 'regenerate' re-runs the last user turn with an empty body.
  // The service rejects an empty body for a 'new' message.
  @IsString()
  @Length(0, 24_000)
  body!: string;

  // Omitted = a new message. 'regenerate' re-runs the last user turn; 'resend'
  // edits the last user message (with `body`) and re-runs, discarding what follows.
  @IsOptional()
  @IsIn(['regenerate', 'resend'])
  mode?: 'regenerate' | 'resend';

  // ClioAttachment ids previously uploaded via POST /clio/attachments (F1).
  // Documents inject their extracted text; images attach as vision blocks.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsUUID(undefined, { each: true })
  attachmentIds?: string[];
}

class UpdateMeriConversationDto {
  @IsOptional()
  @IsString()
  @Length(1, 160)
  title?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  clientId?: string | null;
}

class CreateResearchSessionDto {
  @IsString()
  @Length(1, 4_000)
  topic!: string;

  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsUUID(undefined, { each: true })
  attachmentIds?: string[];

  @IsOptional()
  @IsIn(['fast', 'standard', 'deep', 'max'])
  reasoningMode?: 'fast' | 'standard' | 'deep' | 'max';

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  clientId?: string | null;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  title?: string;

  /** Stage 2 job kind; anything but research needs the tenant flag meri.jobs. */
  @IsOptional()
  @IsIn(MERI_JOB_KINDS)
  kind?: MeriJobKind;

  /** Deliverable jobs only: the requested document ({ format: 'docx', title? }). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1)
  deliverables?: unknown[];
}

class AnswerClarificationsDto {
  @IsObject()
  answers!: Record<string, string>;
}

class SteerResearchDto {
  @IsIn([1])
  version!: 1;

  @IsString()
  @Length(1, 256)
  requestId!: string;

  @IsInt()
  @Min(0)
  expectedGoalRevision!: number;

  @IsString()
  @Length(1, 4_000)
  message!: string;
}

class CancelResearchDto {
  @IsOptional()
  @IsIn([1])
  version?: 1;

  @IsOptional()
  @IsString()
  @Length(1, 256)
  requestId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  reason?: string;
}

class RecordComplianceCheckDto {
  @IsString()
  @Length(1, 120)
  trigger!: string;

  @IsIn(['PASS', 'WARN', 'BLOCK'])
  decision!: 'PASS' | 'WARN' | 'BLOCK';

  @IsString()
  @Length(0, 4000)
  reason!: string;

  @IsOptional()
  @IsString()
  ruleSource?: string;

  @IsOptional()
  @IsBoolean()
  requiredApproval?: boolean;

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;
}

class RecordClaimsDto {
  @IsString()
  @Length(1, 60)
  subjectType!: string;

  @IsString()
  @Length(1, 200)
  subjectId!: string;

  @IsOptional()
  @IsUUID()
  artifactId?: string;

  @IsArray()
  @ArrayMaxSize(50)
  claims!: Array<{ claim: string; supported: boolean; sourceIds: number[] }>;

  @IsArray()
  @ArrayMaxSize(100)
  sources!: Array<{
    n: number;
    type: string;
    id: string;
    title: string;
    url?: string | null;
    snippet?: string | null;
  }>;
}

class ResolveAttachmentTextDto {
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  attachmentIds!: string[];
}

class ValidateMeriProcedureRuntimeDto {
  @IsUUID()
  conversationId!: string;

  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  clientId!: string | null;

  @IsIn(['general', 'client', 'portfolio', 'external_entity'])
  scope!: 'general' | 'client' | 'portfolio' | 'external_entity';

  @IsString()
  @Length(1, 200)
  recordId!: string;

  @IsString()
  @Matches(/^[a-z0-9_]{2,48}$/)
  canonicalId!: string;

  @IsInt()
  @Min(1)
  procedureVersion!: number;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  manifestDigest!: string;

  @IsString()
  @Matches(/^[a-z0-9_:-]{2,160}$/)
  toolName!: string;
}

@Controller('clio')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MeriController {
  private readonly logger = new Logger(MeriController.name);

  constructor(
    private readonly service: MeriService,
    private readonly tools: MeriToolsService,
    private readonly research: MeriResearchService,
    private readonly kb: ClientKbService,
    private readonly mcp: MeriMcpService,
    private readonly mcpOAuth: MeriMcpOAuthService,
    private readonly firmSkills: MeriFirmSkillsService,
    private readonly procedureRuntime: MeriProcedureRuntimeValidationService,
    private readonly approvals: MeriApprovalService,
    private readonly complianceAudit: MeriComplianceAuditService,
    private readonly claimWriter: MeriClaimWriterService,
  ) {}

  @Get('status')
  status(@CurrentTenant() ctx: TenantContext) {
    return this.service.status(ctx);
  }

  @Get('conversations')
  conversations(@CurrentTenant() ctx: TenantContext) {
    return this.service.listConversations(ctx);
  }

  @Post('conversations')
  createConversation(@CurrentTenant() ctx: TenantContext, @Body() body: CreateMeriConversationDto) {
    return this.service.createConversation(ctx, body);
  }

  // History search (F2). Declared before `conversations/:id` so the literal
  // segment wins route matching.
  @Get('conversations/search')
  searchConversations(
    @CurrentTenant() ctx: TenantContext,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25) : 10;
    return this.service.searchConversations(ctx, q ?? '', parsedLimit);
  }

  @Get('conversations/:id')
  conversation(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.getConversation(ctx, id);
  }

  @Patch('conversations/:id')
  updateConversation(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: UpdateMeriConversationDto,
  ) {
    return this.service.updateConversation(ctx, id, body);
  }

  @Patch('conversations/:id/archive')
  archiveConversation(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.archiveConversation(ctx, id);
  }

  @Patch('conversations/:id/restore')
  restoreConversation(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.restoreConversation(ctx, id);
  }

  @Get('conversations/:id/messages')
  messages(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.listMessages(ctx, id);
  }

  @Post('conversations/:id/stream')
  async streamMessage(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: SendMeriMessageDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const telemetry = createMeriApiTelemetryContext(req, ctx, id);
    res.setHeader('x-request-id', telemetry.requestId);
    res.setHeader('x-capiro-trace-id', telemetry.traceId);
    res.setHeader('Access-Control-Expose-Headers', 'x-request-id, x-capiro-trace-id');
    // Cancel the model stream when the client disconnects or hits Stop, so we
    // stop burning tokens for an answer no one is reading (P0-4).
    const abort = new AbortController();
    const onAbort = () => abort.abort(new DOMException('Client disconnected', 'AbortError'));
    const onClose = () => {
      if (!res.writableEnded) onAbort();
    };
    req.once('aborted', onAbort);
    res.once('close', onClose);
    res.once('error', onAbort);
    if (req.aborted || res.destroyed) onAbort();
    // The raw bearer rides along for the MeriV2 full-chat proxy branch only
    // (delegated tool execution + action-proposal creation re-authenticate
    // with it); the legacy in-process path ignores it.
    //
    // IMPERSONATED turns (x-capiro-impersonate-tenant) route to the contained
    // legacy in-process path, NOT MeriV2: Phase 0 containment (264b351af,
    // 2026-07-28, pinned by meriv2-routing.helpers.spec.ts) keeps them out of
    // the orchestrator until one unified effective actor/tenant/impersonation
    // context is carried end-to-end. The earlier Wave 2.5 gate-flip comment
    // claimed impersonated turns route to MeriV2 — that was reverted by the
    // containment fix; the spec is the contract. The impersonated tenant id is
    // still extracted below because the legacy path scopes persistence/billing
    // through the middleware-swapped ctx.
    const impersonateHeader = req.headers['x-capiro-impersonate-tenant'];
    const impersonateTenantId =
      typeof impersonateHeader === 'string' && impersonateHeader.trim().length > 0
        ? impersonateHeader.trim()
        : undefined;
    const bearerMatch = (req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
    const bearerToken = bearerMatch?.[1]?.trim() || undefined;
    // SSE headers stay deferred until the first frame. A pre-stream failure
    // (provider credentials, conversation-store mismatch) must remain a
    // classified JSON response — not Nest's generic HTTP 500 after the
    // response has already been promoted to text/event-stream.
    try {
      await runWithMeriApiTelemetry(
        telemetry,
        (line) => this.logger.log(line),
        async () => {
          const startedAt = Date.now();
          let setupFailed = false;
          emitMeriApiTelemetry({
            name: 'meri.api.request.received',
            boundary: 'browser_api',
            outcome: 'accepted',
            integrationDependencies: ['captured_turn_audit_receipt_pending_capture_policy_8e'],
          });
          try {
            await runMeriStreamWithSetupGuard({
              res,
              stream: (sse) =>
                this.service.streamMessage(
                  ctx,
                  id,
                  body.body,
                  sse,
                  abort.signal,
                  body.mode ?? 'new',
                  body.attachmentIds ?? [],
                  bearerToken,
                  impersonateTenantId,
                ),
              onError: (classified, err) => {
                setupFailed = true;
                this.logger.error(
                  `Meri stream setup failed [${classified.code}] conversation=${id}: ${
                    err instanceof Error ? err.message : classified.message
                  }`,
                  err instanceof Error ? err.stack : undefined,
                );
              },
            });
          } finally {
            emitMeriApiTelemetry({
              name: 'meri.api.request.finalized',
              boundary: 'browser_api',
              outcome: abort.signal.aborted ? 'aborted' : setupFailed ? 'error' : 'completed',
              durationMs: Date.now() - startedAt,
            });
          }
        },
      );
    } finally {
      req.removeListener('aborted', onAbort);
      res.removeListener('close', onClose);
      res.removeListener('error', onAbort);
    }
  }

  @Get('tools')
  toolManifest() {
    return this.tools.manifest();
  }

  /**
   * Anthropic-native tool JSON-schemas (name/description/input_schema). The
   * MeriV2 orchestrator's in-editor surface fetches these at request time (with
   * the caller's bearer) to present the exact tool schemas to the model, so the
   * tool definitions live in ONE place (MeriToolsService) — no drift-prone copy
   * in the orchestrator. Read-only; tenant-guarded like every /api/clio route.
   */
  @Get('tool-schemas')
  toolSchemas(@CurrentTenant() ctx: TenantContext, @Query('surface') requestedSurface?: string) {
    const surface: AssuranceSurface = requestedSurface === 'in-editor' ? 'in-editor' : 'chat';
    return { schemas: this.tools.anthropicToolSchemas({ tenantId: ctx.tenantId, surface }) };
  }

  // ToolServiceSecretGuard: this endpoint runs write tools with no compliance
  // gate (that gate is in the orchestrator), so it must only be reachable by the
  // orchestrator (post-gate), never a rogue user bearer. Requires the internal
  // service secret in addition to the user JWT. Production and staging always
  // enforce it; development/test observe by default unless
  // MERI_TOOLS_REQUIRE_SERVICE_SECRET=true. @CurrentTenant (user JWT) unchanged.
  @Post('tools/:name')
  @HttpCode(200)
  @UseGuards(ToolServiceSecretGuard)
  async executeTool(
    @CurrentTenant() ctx: TenantContext,
    @Param('name') name: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ) {
    const admittedAttachment = admitMeriChatAttachmentTransport(name, body, ctx, req);
    const admittedRp = admitMeriResearchPortfolioToolTransport(
      name,
      admittedAttachment.input,
      ctx,
      req,
    );
    const telemetry = admitMeriInternalTelemetry(req, ctx);
    return runWithMeriApiTelemetry(
      telemetry,
      (line) => this.logger.log(line),
      async () => {
        const startedAt = Date.now();
        emitMeriApiTelemetry({
          name: 'meri.api.tool.started',
          boundary: 'api_tool',
          invokedTools: [name],
          outcome: 'started',
        });
        try {
          const result = await withMeriToolRequestControl(
            req,
            () => {
              const execute = () =>
                this.tools.executeFromAuthenticatedUser(ctx, name, admittedRp.input);
              const executeRp = () =>
                admittedRp.scope
                  ? withMeriResearchPortfolioToolTurnScope(admittedRp.scope, execute)
                  : execute();
              return admittedAttachment.scope
                ? withMeriChatAttachmentReadScope(admittedAttachment.scope, executeRp)
                : executeRp();
            },
          );
          emitMeriApiTelemetry({
            name: 'meri.api.tool.finalized',
            boundary: 'api_tool',
            invokedTools: [name],
            outcome: classifyApiToolReadOutcome(name, result)?.kind ?? 'returned',
            durationMs: Date.now() - startedAt,
          });
          return result;
        } catch (error) {
          emitMeriApiTelemetry({
            name: 'meri.api.tool.finalized',
            boundary: 'api_tool',
            invokedTools: [name],
            outcome: 'error',
            durationMs: Date.now() - startedAt,
          });
          throw error;
        }
      },
    );
  }

  /**
   * Current-authority check. Production/staging require user JWT plus service
   * identity; development/test retain the existing guard's observe-mode policy.
   */
  @Post('procedure-runtime/validate')
  @UseGuards(ToolServiceSecretGuard)
  validateProcedureRuntime(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: ValidateMeriProcedureRuntimeDto,
  ) {
    return this.procedureRuntime.validate(ctx, body);
  }

  // ── MeriV2 legacy write-tool approvals (Workstream B4 + B4.1) — RETIRED ──
  // Phase 0 permanently disables this fingerprint-authorized flow: `check`
  // always reports not-approved, and `pending-actions`/`approve` always 410.
  // New approvals go through MeriActionProposalController
  // (POST /api/clio/action-proposals, approve/dismiss by opaque proposal id
  // only). These three routes stay mounted only so an old/cached browser
  // bundle gets an explicit "expired, propose again" signal instead of a
  // silent 404; `list` below remains live for audit access to historical rows.
  // Propose-time client check (read-only). The gate WARNs before a write runs,
  // so without this a doomed update_client_profile still renders as a clean
  // "pending approval" card and only fails after the user clicks it.
  @Post('clients/check-ref')
  checkClientRef(@CurrentTenant() ctx: TenantContext, @Body() body: { ref?: string }) {
    return this.tools.checkClientRef(ctx, typeof body?.ref === 'string' ? body.ref : '');
  }

  @Post('approvals/check')
  checkApproval(@CurrentTenant() ctx: TenantContext, @Body() body: { fingerprint: string }) {
    return this.approvals.check(ctx, body?.fingerprint);
  }

  @Post('pending-actions')
  recordPendingAction(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: { fingerprint: string; tool: string; input: unknown },
  ) {
    return this.approvals.recordPending(ctx, body);
  }

  @Post('approvals/approve')
  approveAction(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: { fingerprint: string; tool: string },
  ) {
    return this.approvals.approve(ctx, body);
  }

  // Compliance audit store (B2 / SC2.3): the orchestrator posts one row per
  // write-gate decision (PASS/WARN/BLOCK) — fire-and-forget, forwarding the
  // caller bearer, so the audit is tenant+user scoped by CurrentTenant + RLS.
  @Post('compliance-checks')
  recordComplianceCheck(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: RecordComplianceCheckDto,
  ) {
    return this.complianceAudit.record(ctx, {
      trigger: body.trigger,
      decision: body.decision,
      reason: body.reason,
      ruleSource: body.ruleSource ?? null,
      ...(body.requiredApproval !== undefined ? { requiredApproval: body.requiredApproval } : {}),
      entityType: body.entityType ?? null,
      entityId: body.entityId ?? null,
    });
  }

  @Get('compliance-checks')
  listComplianceChecks(@CurrentTenant() ctx: TenantContext, @Query('limit') limit?: string) {
    const parsed = limit ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200) : 50;
    return this.complianceAudit.list(ctx, parsed);
  }

  // Claim/Evidence store writer (Phase-0 tables): the orchestrator's in-editor
  // verifier posts its claims here (fire-and-forget, forwarding the caller
  // bearer) so grounded claims persist tenant-scoped like the chat surface's.
  @Post('claims')
  recordClaims(@CurrentTenant() ctx: TenantContext, @Body() body: RecordClaimsDto) {
    return this.claimWriter.persistClaims(
      ctx.tenantId,
      {
        subjectType: body.subjectType,
        subjectId: body.subjectId,
        artifactId: body.artifactId ?? null,
      },
      body.claims ?? [],
      body.sources ?? [],
    );
  }

  @Get('approvals')
  listApprovals(@CurrentTenant() ctx: TenantContext, @Query('limit') limit?: string) {
    const parsed = limit ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200) : 50;
    return this.approvals.list(ctx, parsed);
  }

  // ── Meri Email endpoints ──

  @Get('emails')
  listEmails(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.tools.executeFromAuthenticatedUser(ctx, 'list_emails', {
      clientId: clientId || undefined,
      limit: limit ? parseInt(limit, 10) : 15,
    });
  }

  @Post('emails/send')
  sendEmail(@CurrentTenant() ctx: TenantContext, @Body() body: Record<string, unknown>) {
    return this.tools.executeFromAuthenticatedUser(ctx, 'send_email', body);
  }

  @Post('emails/reply')
  replyEmail(@CurrentTenant() ctx: TenantContext, @Body() body: Record<string, unknown>) {
    return this.tools.executeFromAuthenticatedUser(ctx, 'reply_email', body);
  }

  // ── Proactive Alerts ──

  @Get('alerts')
  async listAlerts(@CurrentTenant() ctx: TenantContext) {
    return this.service.listAlerts(ctx);
  }

  @Post('alerts/:id/dismiss')
  async dismissAlert(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.dismissAlert(ctx, id);
  }

  // ── Artifact Versioning ──

  @Post('artifacts/:id/version')
  async createArtifactVersion(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { bodyText: string },
  ) {
    return this.service.createArtifactVersion(ctx, id, body.bodyText);
  }

  // ── Message feedback (P1-2) ──

  @Post('messages/:id/feedback')
  async recordMessageFeedback(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { rating?: unknown; reasons?: unknown; note?: unknown },
  ) {
    return this.service.recordMessageFeedback(ctx, id, body);
  }

  @Get('feedback/export')
  @Roles('user_admin')
  exportFeedbackForEvaluation(@CurrentTenant() ctx: TenantContext, @Query('limit') limit?: string) {
    const parsed = limit ? Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500) : 200;
    return this.service.exportFeedbackForEvaluation(ctx, parsed);
  }

  // ── Multimodal / document input (P2-7 + F1) ──

  @Post('attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async uploadAttachment(
    @CurrentTenant() ctx: TenantContext,
    @UploadedFile()
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number } | undefined,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.service.uploadAttachment(ctx, file);
  }

  /**
   * Resolve the extracted text of previously-uploaded attachments by id
   * (Strategy Planner Meri grounding, CRT-5/MRI-7). Tenant + user scoped; the
   * caller (api-strategy) forwards the user's bearer, so RolesGuard authorises
   * the same standard_user who uploaded them.
   */
  @Post('attachments/resolve-text')
  async resolveAttachmentText(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: ResolveAttachmentTextDto,
  ) {
    return this.service.resolveAttachmentText(ctx, body?.attachmentIds ?? []);
  }

  // ── MCP connectors (connector-library v1) ──
  // Any standard_user may browse the catalog and manage their OWN (personal)
  // connectors; the service gates firm-wide connectors to admins. Secrets are
  // write-only. The class-level @Roles('standard_user') applies (no override),
  // so client_portal_user is excluded.

  /** Curated connector library + which entries the caller already connected. */
  @Get('mcp-catalog')
  mcpCatalog(@CurrentTenant() ctx: TenantContext) {
    return this.mcp.catalog(ctx);
  }

  @Get('mcp-servers')
  listMcpServers(@CurrentTenant() ctx: TenantContext) {
    return this.mcp.listServers(ctx);
  }

  @Post('mcp-servers')
  createMcpServer(@CurrentTenant() ctx: TenantContext, @Body() body: McpServerInput) {
    return this.mcp.createServer(ctx, body ?? {});
  }

  /** One-click add from the catalog (pre-fills endpoint/tools; may need OAuth). */
  @Post('mcp-servers/from-catalog')
  addMcpFromCatalog(@CurrentTenant() ctx: TenantContext, @Body() body: CatalogAddInput) {
    return this.mcp.addFromCatalog(ctx, body ?? {});
  }

  @Patch('mcp-servers/:id')
  updateMcpServer(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: McpServerInput,
  ) {
    return this.mcp.updateServer(ctx, id, body ?? {});
  }

  @Delete('mcp-servers/:id')
  deleteMcpServer(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.mcp.deleteServer(ctx, id);
  }

  @Post('mcp-servers/refresh')
  refreshMcpServers(@CurrentTenant() ctx: TenantContext) {
    return this.mcp.refreshNow(ctx);
  }

  /** Begin OAuth for an oauth connector; returns the authorization URL. */
  @Post('mcp-servers/:id/oauth/start')
  startMcpOAuth(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.mcpOAuth.start(ctx, id);
  }

  /** Revoke the locally-stored OAuth tokens for a connector. */
  @Post('mcp-servers/:id/oauth/disconnect')
  async disconnectMcpOAuth(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    await this.mcpOAuth.disconnect(ctx, id);
    this.mcp.invalidate(ctx.tenantId);
    return { disconnected: true };
  }

  // ── Firm-authored skills (F6b) — admin-gated authoring ──

  @Get('firm-skills')
  @Roles('user_admin')
  listFirmSkills(@CurrentTenant() ctx: TenantContext) {
    return this.firmSkills.list(ctx);
  }

  @Post('firm-skills')
  @Roles('user_admin')
  createFirmSkill(@CurrentTenant() ctx: TenantContext, @Body() body: Record<string, unknown>) {
    return this.firmSkills.create(ctx, body ?? {});
  }

  @Patch('firm-skills/:id')
  @Roles('user_admin')
  updateFirmSkill(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.firmSkills.update(ctx, id, body ?? {});
  }

  @Patch('firm-skills/:id/enabled')
  @Roles('user_admin')
  setFirmSkillEnabled(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { enabled?: unknown },
  ) {
    return this.firmSkills.setEnabled(ctx, id, Boolean(body?.enabled));
  }

  @Delete('firm-skills/:id')
  @Roles('user_admin')
  deleteFirmSkill(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.firmSkills.remove(ctx, id);
  }

  @Post('firm-skills/:id/restore')
  @Roles('user_admin')
  restoreFirmSkill(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { version?: unknown },
  ) {
    const version = Number(body?.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new BadRequestException('version must be a positive integer');
    }
    return this.firmSkills.restore(ctx, id, version);
  }

  // Dry run: returns the resolved addendum/template without executing tools.
  @Post('firm-skills/:id/test')
  @Roles('user_admin')
  testFirmSkill(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.firmSkills.testRun(ctx, id);
  }

  // ── Client knowledge base (F5) ──

  // Index status for the Documents-tab chip (counts per source type).
  @Get('kb/:clientId/status')
  kbStatus(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.kb.indexStatus(ctx.tenantId, clientId);
  }

  // Manual re-index for one client (admin affordance / repair). Runs inline so
  // the caller sees real counts; bounded by the per-client chunk quota.
  @Post('kb/:clientId/reindex')
  @Roles('user_admin')
  kbReindex(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.kb.backfillClient(ctx.tenantId, clientId);
  }

  // ── Learned-memory surface (Meri learned X + one-click undo) ──

  @Get('memory/recent')
  async recentLearnedMemories(@CurrentTenant() ctx: TenantContext, @Query('limit') limit?: string) {
    return this.service.listRecentLearnedMemories(ctx, limit ? parseInt(limit, 10) : 5);
  }

  @Delete('memory/:id')
  async forgetMemory(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.forgetMemory(ctx, id);
  }

  /**
   * Propose a correction to a memory the caller is not authorized to edit
   * (Phase 2 Step 9). Deliberately NOT role-gated: the whole point is that a
   * standard user can raise a correction on firm/client memory. It only ever
   * creates a PENDING candidate for admin review — never a direct write.
   */
  @Post('memory/:id/suggest-correction')
  async suggestMemoryCorrection(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { value?: unknown; note?: unknown },
  ) {
    return this.service.suggestMemoryCorrection(ctx, id, body);
  }

  @Get('memory')
  async listMemories(@CurrentTenant() ctx: TenantContext, @Query('limit') limit?: string) {
    return this.service.listMemories(ctx, limit ? parseInt(limit, 10) : 100);
  }

  @Patch('memory/:id')
  async updateMemory(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { value?: unknown },
  ) {
    return this.service.updateMemory(ctx, id, body.value);
  }

  // ── Deep Research ──
  // Flow: POST /research (create) → POST /research/:id/plan/stream (SSE: plan +
  // clarifying questions) → POST /research/:id/clarify (answers) →
  // POST /research/:id/stream (SSE: agentic gather + synthesized cited report).

  @Get('research')
  listResearch(
    @CurrentTenant() ctx: TenantContext,
    @Query('conversationId') conversationId?: string,
  ) {
    return this.research.listSessions(ctx, conversationId);
  }

  @Post('research')
  createResearch(@CurrentTenant() ctx: TenantContext, @Body() body: CreateResearchSessionDto) {
    return this.research.createSession(ctx, body);
  }

  @Get('research/:id')
  getResearch(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.research.getSession(ctx, id);
  }

  @Get('research/:id/runs/:runId/active')
  researchRunActive(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Req() req?: Request,
  ) {
    return this.withResearchRequestTelemetry(
      ctx,
      req,
      'research_checkpoint',
      'researchRunActive',
      true,
      () => this.research.assertRunActive(ctx, id, runId),
    );
  }

  @Post('research/:id/runs/:runId/safe-read/reservations')
  @UseGuards(MeriV3InternalServiceGuard)
  reserveResearchSafeRead(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Body()
    body: {
      leaseEpoch: number;
      providerCallId: string;
      tool: string;
      input: Record<string, unknown>;
    },
    @Req() req?: Request,
  ) {
    return this.withResearchRequestTelemetry(
      ctx,
      req,
      'research_source',
      'reserveResearchSafeRead',
      true,
      () => this.research.reserveSafeReadAttempt(ctx, id, runId, body),
    );
  }

  @Post('research/:id/runs/:runId/provider-budget/reservations')
  @UseGuards(MeriV3InternalServiceGuard)
  reserveResearchProviderAttempt(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Body() body: Parameters<MeriResearchService['reserveProviderAttempt']>[3],
    @Req() req?: Request,
  ) {
    return this.withResearchRequestTelemetry(
      ctx,
      req,
      'research_budget',
      'reserveResearchProviderAttempt',
      true,
      () => this.research.reserveProviderAttempt(ctx, id, runId, body),
    );
  }

  @Post('research/:id/runs/:runId/provider-budget/settlements')
  @UseGuards(MeriV3InternalServiceGuard)
  settleResearchProviderAttempt(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Body() body: Parameters<MeriResearchService['settleProviderAttempt']>[3],
    @Req() req?: Request,
  ) {
    return this.withResearchRequestTelemetry(
      ctx,
      req,
      'research_budget',
      'settleResearchProviderAttempt',
      true,
      () => this.research.settleProviderAttempt(ctx, id, runId, body),
    );
  }

  @Post('research/:id/runs/:runId/safe-read/replay')
  @UseGuards(ToolServiceSecretGuard)
  replayResearchSafeRead(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Body()
    body: {
      leaseEpoch: number;
      providerCallId: string;
      tool: string;
      toolVersion: string;
      input: Record<string, unknown>;
    },
    @Req() req?: Request,
  ) {
    return this.withResearchRequestTelemetry(
      ctx,
      req,
      'research_source',
      'replayResearchSafeRead',
      true,
      () => this.research.replaySafeReadOutcome(ctx, id, runId, body),
    );
  }

  @Post('research/:id/runs/:runId/safe-read/outcomes')
  @UseGuards(ToolServiceSecretGuard)
  commitResearchSafeRead(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Body()
    body: {
      reservationId: string;
      executionId: string;
      leaseEpoch: number;
      providerCallId: string;
      tool: string;
      toolVersion: string;
      input: Record<string, unknown>;
      result: unknown;
    },
    @Req() req?: Request,
  ) {
    return this.withResearchRequestTelemetry(
      ctx,
      req,
      'research_source',
      'commitResearchSafeRead',
      true,
      () => this.research.commitSafeReadOutcome(ctx, id, runId, body),
    );
  }

  @Post('research/:id/runs/:runId/safe-read/failures')
  @UseGuards(ToolServiceSecretGuard)
  failResearchSafeRead(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Body() body: { leaseEpoch: number; reservationId: string; code?: string },
    @Req() req?: Request,
  ) {
    return this.withResearchRequestTelemetry(
      ctx,
      req,
      'research_source',
      'failResearchSafeRead',
      true,
      () => this.research.failSafeReadAttempt(ctx, id, runId, body),
    );
  }

  @Get('research/:id/coordinator')
  researchCoordinator(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query('afterSequence') afterSequence?: string,
    @Req() req?: Request,
  ) {
    return this.withResearchRequestTelemetry(
      ctx,
      req,
      'research_checkpoint',
      'researchCoordinator',
      false,
      () => this.research.getCoordinatorSnapshot(ctx, id, afterSequence),
    );
  }

  @Post('research/:id/steer')
  steerResearch(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: SteerResearchDto,
    @Req() req?: Request,
  ) {
    return this.withResearchRequestTelemetry(
      ctx,
      req,
      'research_checkpoint',
      'steerResearch',
      false,
      () => this.research.steerRun(ctx, id, body),
    );
  }

  @Post('research/:id/cancel')
  cancelResearch(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body?: CancelResearchDto,
    @Req() req?: Request,
  ) {
    return this.withResearchRequestTelemetry(
      ctx,
      req,
      'research_checkpoint',
      'cancelResearch',
      false,
      () => this.research.cancelRun(ctx, id, body),
    );
  }

  @Delete('research/:id')
  deleteResearch(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.research.deleteSession(ctx, id);
  }

  @Post('research/:id/clarify')
  answerResearch(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: AnswerClarificationsDto,
  ) {
    return this.research.answerClarifications(ctx, id, body.answers);
  }

  // Export the completed report as a Microsoft Word–openable document. We emit a
  // Word-compatible HTML `.doc` (opens natively in Word with full formatting),
  // which needs no docx library.
  @Get('research/:id/export/word')
  async exportResearchWord(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { title, markdown } = await this.research.getReportMarkdown(ctx, id);
    const html = renderReportToWordHtml({ title, markdown });
    const filename = `${slugifyFilename(title)}.doc`;
    res.setHeader('Content-Type', 'application/msword');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(html);
  }

  // Render the completed report as a clean, branded, printable HTML page —
  // "write to the browser" / open-in-new-tab surface.
  @Get('research/:id/export/html')
  async exportResearchHtml(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { title, markdown } = await this.research.getReportMarkdown(ctx, id);
    const html = renderReportToBrowserHtml({ title, markdown });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  // Download a Meri-generated document. Native bytes created by the current
  // writer are immutable; legacy rows and alternate Word/PDF exports are
  // regenerated from the same saved spec and labeled as such in the receipt.
  @Get('artifacts/:id/download')
  async downloadArtifact(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Res() res: Response,
    @Query('format') format?: string,
  ) {
    const doc = await this.tools.getDocumentArtifact(ctx, id, format);
    if (!doc) {
      throw new NotFoundException('Document artifact not found');
    }
    let buffer: Buffer;
    try {
      buffer =
        doc.persistedBytes ?? (await this.tools.renderStoredDocument(doc.format, doc.specJson));
      await validateDocumentArtifactBytes(doc.format, buffer);
      if (doc.persistedSha256 && sha256Bytes(buffer) !== doc.persistedSha256) {
        throw new Error('persisted_document_digest_mismatch');
      }
    } catch (error) {
      throw new UnprocessableEntityException({
        code: 'MERI_DOCUMENT_RENDER_FAILED',
        format: doc.format,
        reason: error instanceof MeriPdfRenderError ? error.reason : 'render_failed',
        message:
          error instanceof MeriPdfRenderError
            ? `${error.message} Download Word or adjust the document and try again.`
            : 'The document could not be rendered. Try again or choose another available format.',
      });
    }
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
    // The authenticated web client needs the canonical saved filename when
    // downloading from the API origin. Artifact bytes remain private.
    const sha256 = sha256Bytes(buffer);
    res.setHeader('X-Capiro-Artifact-Id', id);
    res.setHeader('X-Capiro-Artifact-Sha256', sha256);
    res.setHeader('X-Capiro-Artifact-Byte-Authority', doc.byteAuthority);
    if (doc.operationReceipt) {
      res.setHeader('X-Capiro-Artifact-Operation-Id', doc.operationReceipt.operationId);
      res.setHeader('X-Capiro-Artifact-Creation-Receipt', Buffer.from(JSON.stringify(doc.operationReceipt), 'utf8').toString('base64url'));
    }
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Disposition, Content-Length, X-Capiro-Artifact-Id, X-Capiro-Artifact-Sha256, X-Capiro-Artifact-Byte-Authority, X-Capiro-Artifact-Operation-Id, X-Capiro-Artifact-Creation-Receipt',
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  }

  // PNG body for an analysis-chart artifact (F4): rendered inline in chat and
  // embedded into generated Word/PPT documents.
  @Get('artifacts/:id/image')
  async artifactImage(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const image = await this.service.getArtifactImage(ctx, id);
    if (!image) throw new NotFoundException('Image artifact not found');
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Content-Length', String(image.buffer.length));
    res.setHeader('ETag', `"sha256-${image.sha256}"`);
    res.setHeader('X-Capiro-Artifact-Id', id);
    res.setHeader('X-Capiro-Image-Integrity', image.integrityPolicy);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(image.buffer);
  }

  private withResearchRequestTelemetry<T>(
    ctx: TenantContext,
    req: Request | undefined,
    boundary: 'research_run' | 'research_checkpoint' | 'research_budget' | 'research_source',
    operation: string,
    internal: boolean,
    fn: () => Promise<T>,
  ): Promise<T> {
    // Direct in-process callers have no HTTP carrier. Real ingress uses only the
    // authenticated tenant/actor; session/conversation/run authority is added
    // after the service's existing admission, never from route/body identifiers.
    if (!req) return fn();
    const context = internal
      ? admitMeriInternalTelemetry(req, ctx)
      : createMeriApiTelemetryContext(req, ctx, '');
    return runWithMeriApiTelemetry(
      context,
      (line) => this.logger.log(line),
      () => withMeriApiTelemetrySpan({ name: `meri.research.${operation}`, boundary }, fn),
    );
  }

  @Post('research/:id/plan/stream')
  async streamResearchPlan(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    await this.withResearchRequestTelemetry(ctx, req, 'research_run', 'streamPlan', false, () =>
      this.research.streamPlan(ctx, id, res, researchRuntimeAuth(req, res)),
    );
    res.end();
  }

  @Post('research/:id/stream')
  async streamResearchRun(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    await this.withResearchRequestTelemetry(ctx, req, 'research_run', 'streamResearch', false, () =>
      this.research.streamResearch(ctx, id, res, researchRuntimeAuth(req, res)),
    );
    res.end();
  }
}

function researchRuntimeAuth(req: Request, _res: Response) {
  // Browser disconnects detach from durable research; only /cancel stops the run.
  const bearerToken = (req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const impersonate = req.headers['x-capiro-impersonate-tenant'];
  const resumeRunId = req.headers['x-meri-research-resume-run'];
  return {
    bearerToken,
    ...(typeof resumeRunId === 'string' ? { resumeRunId } : {}),
    impersonateTenantId:
      typeof impersonate === 'string' ? impersonate.trim() || undefined : undefined,
  };
}

/** Filesystem-safe slug for a download filename. */
function slugifyFilename(title: string): string {
  const slug = (title || 'research-report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'research-report';
}
