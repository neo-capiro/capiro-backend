/**
 * Browser-facing control surface for Hermes runs (pilot-gated).
 *
 * Every route re-checks the server-side pilot gate (a tenant outside the pilot
 * sees 404, exactly like MeriV3's settings surface) and run OWNERSHIP
 * (tenant + actor). Run ids are opaque handles, never authorization.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString, Length } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import type { Request, Response } from 'express';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MeriFeatureFlagsService } from '../meri-feature-flags.service.js';
import type { MeriHermesCapabilityDescriptor, MeriSseFrame } from './hermes-runtime.contracts.js';
import { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import { MeriHermesRuntimeClient } from './meri-hermes-runtime.client.js';
import { MeriHermesArtifactStorageService } from './meri-hermes-artifact-storage.service.js';
import {
  MERI_HERMES_RUN_REPOSITORY,
  type MeriHermesRunRecord,
  type MeriHermesRunRepository,
} from './meri-hermes-run-store.js';

class ApprovalDecisionDto {
  @IsString() @Length(1, 200) requestId!: string;
  @IsIn(['approve_once', 'deny']) decision!: 'approve_once' | 'deny';
}

class ClarificationAnswerDto {
  @IsString() @Length(1, 200) requestId!: string;
  @IsOptional() @IsString() @Length(1, 4000) answer?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) answers?: string[];
}

class SteerDto {
  @IsString() @Length(1, 4000) text!: string;
}

/** Non-secret projection of a run record for the browser / dev harness. */
export function projectRun(run: MeriHermesRunRecord) {
  return {
    runId: run.runId,
    status: run.status,
    conversationId: run.envelope.conversationId,
    executionScopeId: run.envelope.executionScopeId,
    audience: run.envelope.audience,
    hermesRunId: run.hermesRunId,
    hermesSessionId: run.hermesSessionId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
    lastSeq: run.lastSeq,
    finishReason: run.finishReason,
    partial: run.partial,
    error: run.error,
    usage: run.usage,
    detached: run.detached,
    stopRequestedAt: run.stopRequestedAt,
    userMessageId: run.userMessageId,
    assistantMessageId: run.assistantMessageId,
    brokerCalls: run.brokerCalls,
    pendingInteractions: run.pendingInteractions.map((i) => ({
      requestId: i.requestId,
      kind: i.kind,
      prompt: i.prompt,
      choices: i.choices,
      multiSelect: i.multiSelect,
      continuation: i.continuation,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      resolved: Boolean(i.resolution),
      decision: i.resolution?.decision ?? null,
    })),
  };
}

@Controller('clio/hermes')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MeriHermesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: MeriFeatureFlagsService,
    private readonly client: MeriHermesRuntimeClient,
    private readonly adapter: MeriHermesRuntimeAdapter,
    private readonly artifactStorage: MeriHermesArtifactStorageService,
    @Inject(MERI_HERMES_RUN_REPOSITORY) private readonly runs: MeriHermesRunRepository,
  ) {}

  private async assertEnabled(ctx: TenantContext): Promise<void> {
    if (!(await this.flags.isMeriHermesRuntimeEnabled(ctx.tenantId))) {
      throw new NotFoundException('Hermes runtime is not enabled for this tenant');
    }
  }

  private async ownedRun(ctx: TenantContext, runId: string): Promise<MeriHermesRunRecord> {
    await this.assertEnabled(ctx);
    const run = await this.runs.requireOwned(runId, ctx.tenantId, ctx.userId);
    if (!run) throw new NotFoundException('Run not found');
    return run;
  }

  @Get('capabilities')
  async capabilities(@CurrentTenant() ctx: TenantContext): Promise<MeriHermesCapabilityDescriptor> {
    await this.assertEnabled(ctx);
    let caps;
    try {
      caps = await this.client.capabilities();
    } catch (error) {
      throw new ServiceUnavailableException(
        `Hermes runtime unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const [toolsets, skills] = await Promise.all([
      this.client.toolsets().catch(() => null),
      this.client.skills().catch(() => null),
    ]);
    const endpoints: Record<string, { method: string; path: string }> = {};
    for (const [name, value] of Object.entries(caps.endpoints ?? {})) {
      if (value && typeof value === 'object' && 'method' in value && 'path' in value) {
        endpoints[name] = { method: String((value as { method: unknown }).method), path: String((value as { path: unknown }).path) };
      }
    }
    // Pinned build shapes: /v1/toolsets → {object, platform, data:[{name, tools:[…]}]},
    // /v1/skills → {…, data:[…]} (currently 500 on this build; tolerated as null).
    const toolsetList =
      (toolsets as { data?: unknown[]; toolsets?: unknown[] } | null)?.data ??
      (toolsets as { toolsets?: unknown[] } | null)?.toolsets ??
      [];
    const toolsetNames = Array.isArray(toolsetList)
      ? (toolsetList as Array<{ name?: string; id?: string }>).map((t) => String(t.name ?? t.id ?? '')).filter(Boolean)
      : [];
    const skillList =
      (skills as { data?: unknown[]; skills?: unknown[] } | null)?.data ??
      (skills as { skills?: unknown[] } | null)?.skills ??
      null;
    const skillCount = Array.isArray(skillList) ? skillList.length : 0;
    const features: Record<string, boolean | string | number> = {};
    for (const [key, value] of Object.entries(caps.features ?? {})) {
      if (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') features[key] = value;
      else features[key] = JSON.stringify(value);
    }
    return {
      runtime: 'hermes',
      build: {
        tag: process.env.MERI_HERMES_BUILD_TAG ?? 'v2026.9.14',
        commit: process.env.MERI_HERMES_BUILD_COMMIT ?? '7a963716b81be13ba513d4f127633b7da493aff2',
        version: caps.version ?? '0.21.3',
        imageDigest: process.env.MERI_HERMES_IMAGE_DIGEST ?? null,
      },
      features,
      endpoints,
      toolsets: toolsetNames,
      skillCount,
      limits: { maxConcurrentRuns: null, eventBufferTtlSeconds: 300 },
      adaptersRequired: [
        'clarification (no native callback over /v1/runs → broker durable continuation)',
        'file ingestion (API rejects uploads → broker attachment materialisation)',
        'artifact retrieval (worker files → broker publication)',
        'durable run records / reconnect (Hermes buffers 5 min → Meri run store)',
        'native approval UI mapping (pending_approval runtime=hermes → run approval endpoint)',
      ],
    };
  }

  @Get('runs/:runId')
  async run(@CurrentTenant() ctx: TenantContext, @Param('runId', ParseUUIDPipe) runId: string) {
    return projectRun(await this.ownedRun(ctx, runId));
  }

  @Get('runs/:runId/events')
  async events(
    @CurrentTenant() ctx: TenantContext,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Query('after') after: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const run = await this.ownedRun(ctx, runId);
    const afterSeq = Math.max(0, Number.parseInt(after ?? '0', 10) || 0);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const abort = new AbortController();
    const onClose = () => abort.abort();
    req.once('aborted', onClose);
    res.once('close', onClose);
    const write = (frame: MeriSseFrame) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    write({ type: 'progress', runId: run.runId, phase: 'reconnect', note: 'Reconnected to the durable run.', elapsedMs: 0, afterSeq });
    try {
      await this.adapter.attach(run, write, abort.signal, afterSeq);
    } finally {
      req.off('aborted', onClose);
      res.off('close', onClose);
      if (!res.writableEnded) res.end();
    }
  }

  @Post('runs/:runId/stop')
  async stop(@CurrentTenant() ctx: TenantContext, @Param('runId', ParseUUIDPipe) runId: string) {
    const run = await this.ownedRun(ctx, runId);
    return projectRun(await this.adapter.requestStop(run));
  }

  @Post('runs/:runId/approval')
  async approval(
    @CurrentTenant() ctx: TenantContext,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() body: ApprovalDecisionDto,
  ) {
    const run = await this.ownedRun(ctx, runId);
    await this.adapter.resolveApproval(run, body.requestId, body.decision, ctx.userId);
    return projectRun((await this.runs.get(run.runId)) ?? run);
  }

  @Post('runs/:runId/clarification')
  async clarification(
    @CurrentTenant() ctx: TenantContext,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() body: ClarificationAnswerDto,
  ) {
    const run = await this.ownedRun(ctx, runId);
    const answer = body.answers?.length ? body.answers : body.answer;
    if (!answer) throw new BadRequestException('answer or answers is required');
    const result = await this.adapter.answerClarification(run, body.requestId, answer, ctx.userId);
    return { ...result, run: projectRun((await this.runs.get(run.runId)) ?? run) };
  }

  @Post('runs/:runId/steer')
  async steer(
    @CurrentTenant() ctx: TenantContext,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() body: SteerDto,
  ) {
    const run = await this.ownedRun(ctx, runId);
    return { accepted: await this.adapter.steer(run, body.text) };
  }

  /** Authorized retrieval of an artifact a Hermes run published through the broker. */
  @Get('artifacts/:artifactId')
  async artifact(
    @CurrentTenant() ctx: TenantContext,
    @Param('artifactId', ParseUUIDPipe) artifactId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.assertEnabled(ctx);
    const artifact = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.findFirst({
        where: { id: artifactId, tenantId: ctx.tenantId, userId: ctx.userId },
        select: { id: true, title: true, kind: true, contentType: true, bodyText: true, s3Key: true, metadata: true },
      }),
    );
    if (!artifact) throw new NotFoundException('Artifact not found');
    const metadata = (artifact.metadata ?? {}) as Record<string, unknown>;
    if (metadata.runtime !== 'hermes') throw new NotFoundException('Artifact not found');
    const filename = typeof metadata.filename === 'string' && metadata.filename ? metadata.filename : `${artifact.title}.txt`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\- ]+/g, '_')}"`);
    res.setHeader('X-Meri-Artifact-Sha256', String(metadata.sha256 ?? ''));
    if (artifact.s3Key) {
      // Phase 1 backlog #11: real bytes now live in S3 (see
      // MeriHermesArtifactStorageService), not inlined in `metadata`.
      const bytes = await this.artifactStorage.getBytes(artifact.s3Key);
      res.setHeader('Content-Type', artifact.contentType ?? 'application/octet-stream');
      res.end(bytes);
      return;
    }
    // Phase 0 prototype rows published before this migration inlined bytes
    // as base64 in `metadata.inlineBase64`; keep serving those unchanged.
    if (typeof metadata.inlineBase64 === 'string') {
      res.setHeader('Content-Type', artifact.contentType ?? 'application/octet-stream');
      res.end(Buffer.from(metadata.inlineBase64, 'base64'));
      return;
    }
    res.setHeader('Content-Type', artifact.contentType ?? 'text/plain; charset=utf-8');
    res.end(artifact.bodyText ?? '');
  }
}
