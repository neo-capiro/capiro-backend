import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  NotFoundException,
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
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateIf,
} from 'class-validator';
import type { Request, Response } from 'express';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MeriService } from './meri.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { MeriResearchService } from './meri-research.service.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { MeriMcpService, type CatalogAddInput, type McpServerInput } from './meri-mcp.service.js';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { MeriApprovalService } from './meri-approval.service.js';
import { MeriComplianceAuditService } from './meri-compliance-audit.service.js';
import { renderReportToBrowserHtml, renderReportToWordHtml } from './meri-research.helpers.js';

class CreateMeriConversationDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

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
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  clientId?: string | null;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  title?: string;
}

class AnswerClarificationsDto {
  @IsObject()
  answers!: Record<string, string>;
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

@Controller('clio')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MeriController {
  constructor(
    private readonly service: MeriService,
    private readonly tools: MeriToolsService,
    private readonly research: MeriResearchService,
    private readonly kb: ClientKbService,
    private readonly mcp: MeriMcpService,
    private readonly mcpOAuth: MeriMcpOAuthService,
    private readonly firmSkills: MeriFirmSkillsService,
    private readonly approvals: MeriApprovalService,
    private readonly complianceAudit: MeriComplianceAuditService,
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
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // Cancel the model stream when the client disconnects or hits Stop, so we
    // stop burning tokens for an answer no one is reading (P0-4).
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    res.on('error', () => {
      /* swallow socket errors on client disconnect */
    });
    // The raw bearer rides along for the MeriV2 full-chat proxy branch only
    // (delegated tools + the approval check re-authenticate with it); the
    // legacy in-process path ignores it.
    //
    // IMPERSONATED turns (x-capiro-impersonate-tenant) must NOT route to
    // MeriV2: impersonation is app-level (middleware swaps ctx.tenantId), but
    // the orchestrator resolves tenant purely from the admin's JWT claims — the
    // forwarded bearer would execute every delegated tool against the admin's
    // HOME tenant while the reply persists (and the BYOK key bills) under the
    // impersonated tenant. Withholding the bearer makes the service branch fall
    // through to the legacy in-process path, which runs entirely under the one
    // swapped ctx and handles impersonation correctly.
    const impersonated = Boolean(req.headers['x-capiro-impersonate-tenant']);
    const bearerMatch = (req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
    const bearerToken = impersonated ? undefined : bearerMatch?.[1]?.trim() || undefined;
    await this.service.streamMessage(
      ctx,
      id,
      body.body,
      res,
      abort.signal,
      body.mode ?? 'new',
      body.attachmentIds ?? [],
      bearerToken,
    );
    res.end();
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
  toolSchemas() {
    return { schemas: this.tools.anthropicToolSchemas() };
  }

  @Post('tools/:name')
  executeTool(
    @CurrentTenant() ctx: TenantContext,
    @Param('name') name: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.tools.executeFromAuthenticatedUser(ctx, name, body);
  }

  // ── MeriV2 write-tool approvals (Workstream B4) ──
  // Backs the orchestrator's ApprovalStore: check whether a proposed write
  // (identified by its meriv2-core fingerprint) is approved, and record an
  // approval. Tenant+user scoped by CurrentTenant + the meri_action_approval
  // RLS policy. `check` is called by the orchestrator (forwarding the caller
  // bearer); `approve`/`list` are the human/surface actions.
  @Post('approvals/check')
  checkApproval(@CurrentTenant() ctx: TenantContext, @Body() body: { fingerprint: string }) {
    return this.approvals.check(ctx, body?.fingerprint);
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
    @Body() body: { rating?: unknown; note?: unknown },
  ) {
    return this.service.recordMessageFeedback(ctx, id, body);
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
  listResearch(@CurrentTenant() ctx: TenantContext) {
    return this.research.listSessions(ctx);
  }

  @Post('research')
  createResearch(@CurrentTenant() ctx: TenantContext, @Body() body: CreateResearchSessionDto) {
    return this.research.createSession(ctx, body);
  }

  @Get('research/:id')
  getResearch(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.research.getSession(ctx, id);
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

  // Download a Meri-generated Office document (.docx/.xlsx/.pptx). The binary is
  // regenerated on demand from the spec stored on the artifact — no blob storage.
  @Get('artifacts/:id/download')
  async downloadArtifact(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const doc = await this.tools.getDocumentArtifact(ctx, id);
    if (!doc) {
      throw new NotFoundException('Document artifact not found');
    }
    const buffer = await this.tools.renderStoredDocument(doc.format, doc.specJson);
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
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
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(image.buffer);
  }

  @Post('research/:id/plan/stream')
  async streamResearchPlan(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Req() _req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    await this.research.streamPlan(ctx, id, res);
    res.end();
  }

  @Post('research/:id/stream')
  async streamResearchRun(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Req() _req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    await this.research.streamResearch(ctx, id, res);
    res.end();
  }
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
