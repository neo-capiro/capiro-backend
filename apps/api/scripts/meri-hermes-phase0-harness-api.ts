/**
 * Phase 0 Hermes harness API — runs the REAL Meri runtime adapter, broker and
 * controllers against the local fixture database, without Clerk or the full
 * AppModule.
 *
 * What is real here: MeriHermesRuntimeAdapter, MeriHermesBrokerService (and its
 * guard/controller), MeriHermesController, MeriHermesRunStore, PrismaService with
 * the tenant-scope query hook, MemoryModule (MemoryCandidateService and the
 * governed candidate rules), the fixture-DB memory_items reads with RLS GUCs.
 *
 * What is substituted (and labelled in every response header
 * `x-meri-harness: phase0`):
 *  - Identity: no Clerk. The runner asserts a FIXTURE identity via
 *    `x-harness-tenant-id` / `x-harness-user-id` headers plus `x-harness-secret`;
 *    the middleware still resolves the membership row from the database and
 *    refuses identities that are not active members (a cross-tenant spoof is a
 *    403, exactly as the production middleware would refuse a bad org claim).
 *  - Context Plane: not loaded. Governed prompt compilation is skipped
 *    (`governedInstructions` empty); the security envelope and recall use the
 *    Direct* ports, which run the same Prisma predicates and label themselves.
 *  - Turn maintenance (search indexing / compaction): no-op.
 *
 * Usage (see scripts/meri-hermes/phase0-harness.mjs, which drives it):
 *   DATABASE_URL=... HARNESS_SECRET=... MERI_HERMES_* ... tsx scripts/meri-hermes-phase0-harness-api.ts
 */
import 'reflect-metadata';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  MiddlewareConsumer,
  Module,
  NestModule,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { TenantContext } from '@capiro/shared';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { validateConfig } from '../src/config/config.schema.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TenantModule } from '../src/tenant/tenant.module.js';
import { MemoryModule } from '../src/memory/memory.module.js';
import { MeriFeatureFlagsService } from '../src/meri/meri-feature-flags.service.js';
import { MERI_TURN_MAINTENANCE } from '../src/meri/meri-turn-maintenance.js';
import { MeriHermesRuntimeClient } from '../src/meri/hermes/meri-hermes-runtime.client.js';
import { MeriHermesRunStore } from '../src/meri/hermes/meri-hermes-run-store.js';
import {
  computeAuthorizationVersion,
  MeriHermesRuntimeAdapter,
} from '../src/meri/hermes/meri-hermes-runtime.adapter.js';
import { MeriHermesBrokerService } from '../src/meri/hermes/meri-hermes-broker.service.js';
import {
  MeriHermesBrokerController,
  MeriHermesWorkerTokenGuard,
} from '../src/meri/hermes/meri-hermes-broker.controller.js';
import { MeriHermesController, projectRun } from '../src/meri/hermes/meri-hermes.controller.js';
import {
  DirectMemoryItemsRecallPort,
  MERI_HERMES_RECALL_PORT,
} from '../src/meri/hermes/meri-hermes-recall.ports.js';
import {
  DirectSecurityEnvelopePort,
  MERI_HERMES_SECURITY_ENVELOPE,
} from '../src/meri/hermes/meri-hermes-security.port.js';
import {
  mintMeriHermesWorkerToken,
  privateExecutionScopeId,
} from '../src/meri/hermes/meri-hermes-worker-token.js';

const HARNESS_SECRET = process.env.HARNESS_SECRET ?? '';
const PORT = Number(process.env.HARNESS_PORT ?? 4450);

// The shared config schema requires Clerk secrets even though this harness never
// authenticates with Clerk (identity is asserted by the runner). ConfigModule.forRoot
// validates eagerly when the @Module decorator below is evaluated, so the
// clearly-fake placeholders must be set at module top level, and ONLY under
// NODE_ENV=test. Any real Clerk call with these values fails loudly.
process.env.NODE_ENV ??= 'test';
if (process.env.NODE_ENV === 'test') {
  process.env.CLERK_SECRET_KEY ??= 'sk_test_phase0_harness_placeholder_not_a_real_key';
  process.env.CLERK_WEBHOOK_SIGNING_SECRET ??= 'whsec_phase0_harness_placeholder_not_a_real_secret';
}

type HarnessRequest = Request & { tenantContext?: TenantContext };

// ---------------------------------------------------------------------------
// Fixture identity middleware (replaces Clerk + TenantContextMiddleware here)
// ---------------------------------------------------------------------------

@Injectable()
class FixtureIdentityMiddleware {
  constructor(private readonly prisma: PrismaService) {}

  use = async (req: HarnessRequest, res: Response, next: NextFunction) => {
    res.setHeader('x-meri-harness', 'phase0');
    // Worker-token routes carry their own auth. Under setGlobalPrefix the
    // middleware may see the path with or without the /api prefix.
    const fullPath = req.originalUrl ?? req.url ?? req.path;
    if (fullPath.startsWith('/api/internal/') || req.path.startsWith('/internal/')) return next();
    const secret = req.header('x-harness-secret');
    if (!HARNESS_SECRET || secret !== HARNESS_SECRET) {
      return next(new UnauthorizedException('harness secret required'));
    }
    const tenantId = req.header('x-harness-tenant-id');
    const userId = req.header('x-harness-user-id');
    if (!tenantId || !userId) return next(); // identity-less harness routes (e.g. worker-token)
    try {
      // Same shape as the production middleware: the asserted identity must be an
      // ACTIVE member of the asserted tenant, or it is refused. Body fields are never consulted.
      const membership = await this.prisma.withSystem((tx) =>
        tx.tenantMembership.findFirst({
          where: { tenantId, userId, status: 'active' },
          select: { role: true, tenant: { select: { slug: true } }, user: { select: { clerkUserId: true } } },
        }),
      );
      if (!membership) return next(new ForbiddenException('asserted identity is not an active member of that tenant'));
      req.tenantContext = {
        tenantId,
        tenantSlug: membership.tenant.slug,
        userId,
        clerkUserId: membership.user.clerkUserId,
        role: membership.role,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

// ---------------------------------------------------------------------------
// Harness-only control routes
// ---------------------------------------------------------------------------

// The global ValidationPipe runs with whitelist:true, so every accepted field
// needs a class-validator decorator (undecorated fields are stripped).
class WorkerTokenDto {
  @IsUUID() tenantId!: string;
  @IsUUID() userId!: string;
  @IsOptional() @IsInt() @Min(60) @Max(43_200) ttlSeconds?: number;
}

class StreamDto {
  @IsString() @Length(0, 24_000) body!: string;
  @IsOptional() @IsIn(['new', 'regenerate', 'resend']) mode?: 'new' | 'regenerate' | 'resend';
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) attachmentIds?: string[];
}

class EnabledDto {
  @IsBoolean() enabled!: boolean;
}

@Controller('harness')
class HarnessController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adapter: MeriHermesRuntimeAdapter,
    private readonly runs: MeriHermesRunStore,
    private readonly client: MeriHermesRuntimeClient,
    private readonly security: DirectSecurityEnvelopePort,
    private readonly flags: MeriFeatureFlagsService,
  ) {}

  @Get('health')
  async health() {
    return {
      ok: true,
      harness: 'phase0',
      hermesConfigured: this.client.configured,
      hermes: this.client.configured ? await this.client.health() : null,
      pilotEnv: {
        MERI_HERMES_ENABLED: process.env.MERI_HERMES_ENABLED ?? null,
        pilotTenantIds: (process.env.MERI_HERMES_PILOT_TENANT_IDS ?? '').split(',').filter(Boolean),
        model: process.env.MERI_HERMES_MODEL ?? null,
      },
    };
  }

  /** Mint the scope-bound credential a worker receives at provisioning. */
  @Post('worker-token')
  async workerToken(@Body() body: WorkerTokenDto) {
    const membership = await this.prisma.withSystem((tx) =>
      tx.tenantMembership.findFirst({
        where: { tenantId: body.tenantId, userId: body.userId, status: 'active' },
        select: { role: true, tenant: { select: { slug: true } }, user: { select: { clerkUserId: true } } },
      }),
    );
    if (!membership) throw new NotFoundException('no active membership for that identity');
    const ctx: TenantContext = {
      tenantId: body.tenantId,
      tenantSlug: membership.tenant.slug,
      userId: body.userId,
      clerkUserId: membership.user.clerkUserId,
      role: membership.role,
    };
    const envelope = await this.security.securityEnvelope(ctx);
    const authorizationVersion = computeAuthorizationVersion({ role: ctx.role, ...envelope });
    const signingKey = process.env.MERI_HERMES_BROKER_SIGNING_KEY ?? '';
    const minted = mintMeriHermesWorkerToken(
      {
        executionScopeId: privateExecutionScopeId(ctx.tenantId, ctx.userId),
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorId: ctx.userId,
        authorizationVersion,
        ttlSeconds: body.ttlSeconds ?? 4 * 3600,
      },
      signingKey,
    );
    return {
      token: minted.token,
      claims: { ...minted.claims, jti: '(redacted)' },
      executionScopeId: minted.claims.executionScopeId,
      authorizationVersion,
      authorizedClientCount: envelope.authorizedClientIds.length,
    };
  }

  /** Does the pilot gate route this (server-resolved) identity to Hermes? */
  @Get('gate')
  async gate(@Req() req: HarnessRequest) {
    const ctx = req.tenantContext;
    if (!ctx) throw new UnauthorizedException('identity headers required');
    return {
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      userId: ctx.userId,
      role: ctx.role,
      hermes: await this.adapter.shouldHandle(ctx),
      env: { MERI_HERMES_ENABLED: process.env.MERI_HERMES_ENABLED ?? null },
    };
  }

  /** Test-only: flip the global switch to prove flag-off behaviour without a restart. */
  @Post('env/hermes-enabled')
  setEnabled(@Body() body: EnabledDto) {
    process.env.MERI_HERMES_ENABLED = body.enabled ? 'true' : 'false';
    this.flags.invalidate('*');
    return { MERI_HERMES_ENABLED: process.env.MERI_HERMES_ENABLED };
  }

  /**
   * Stream a Meri turn exactly as `POST /api/clio/conversations/:id/stream`
   * would after the runtime proxy selected Hermes. When the gate is closed for
   * this identity the request is refused (409) — the harness does not have the
   * legacy/V3 runtimes to fall back to, and must never pretend it did.
   */
  @Post('conversations/:conversationId/stream')
  @HttpCode(200)
  async stream(
    @Req() req: HarnessRequest,
    @Res() res: Response,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: StreamDto,
  ): Promise<void> {
    const ctx = req.tenantContext;
    if (!ctx) throw new UnauthorizedException('identity headers required');
    if (!(await this.adapter.shouldHandle(ctx))) {
      res.status(409).json({ code: 'NOT_ROUTED_TO_HERMES', message: 'pilot gate closed for this tenant; production would use the existing runtime' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const abort = new AbortController();
    const onAbort = () => abort.abort(new DOMException('Client disconnected', 'AbortError'));
    req.once('aborted', onAbort);
    res.once('close', () => {
      if (!res.writableEnded) onAbort();
    });
    const writer = {
      write(data: string) {
        if (!res.writableEnded && !res.destroyed) res.write(data);
      },
    };
    try {
      await this.adapter.streamMessage(ctx, conversationId, body.body ?? '', writer, abort.signal, body.mode ?? 'new', body.attachmentIds ?? []);
    } catch (error) {
      writer.write(`data: ${JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) })}\n\n`);
      writer.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  /** Full run record (all event visibilities) for evidence. Owner-scoped. */
  @Get('runs/:runId/full')
  fullRun(@Req() req: HarnessRequest, @Param('runId', ParseUUIDPipe) runId: string) {
    const ctx = req.tenantContext;
    if (!ctx) throw new UnauthorizedException('identity headers required');
    const run = this.runs.requireOwned(runId, ctx.tenantId, ctx.userId);
    if (!run) throw new NotFoundException('Run not found');
    return {
      run: projectRun(run),
      envelope: { ...run.envelope, authorizedClientIds: run.envelope.authorizedClientIds.length },
      output: run.output,
      events: this.runs.eventsAfter(runId, 0, 'all'),
    };
  }

  @Get('conversations/:conversationId/runs')
  conversationRuns(@Req() req: HarnessRequest, @Param('conversationId', ParseUUIDPipe) conversationId: string) {
    const ctx = req.tenantContext;
    if (!ctx) throw new UnauthorizedException('identity headers required');
    return this.runs.listForConversation(ctx.tenantId, ctx.userId, conversationId).map(projectRun);
  }

  @Get('conversations/:conversationId/messages')
  async messages(@Req() req: HarnessRequest, @Param('conversationId', ParseUUIDPipe) conversationId: string) {
    const ctx = req.tenantContext;
    if (!ctx) throw new UnauthorizedException('identity headers required');
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMessage.findMany({
        where: { conversationId, tenantId: ctx.tenantId, userId: ctx.userId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, body: true, metadata: true, createdAt: true },
      }),
    );
  }

  @Get('memory-candidates')
  async candidates(@Req() req: HarnessRequest) {
    const ctx = req.tenantContext;
    if (!ctx) throw new UnauthorizedException('identity headers required');
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id::text AS id, source_kind, scope, status, governed_status, source_type, source_id::text AS source_id,
               payload_jsonb->>'key' AS key, created_at
        FROM memory_candidate
        WHERE tenant_id = ${ctx.tenantId}::uuid AND proposed_by = ${ctx.userId}::uuid
        ORDER BY created_at DESC LIMIT 20`,
    );
  }
}

// ---------------------------------------------------------------------------
// Module + bootstrap
// ---------------------------------------------------------------------------

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: (raw) => validateConfig(raw as Record<string, unknown>) }),
    // AuthModule is @Global in the real app and is what TenantModule's middleware
    // resolves ClerkService from. With the placeholder key it constructs a Clerk
    // client that is never called here (identity comes from the harness headers).
    AuthModule,
    PrismaModule,
    TenantModule,
    MemoryModule,
  ],
  controllers: [MeriHermesController, MeriHermesBrokerController, HarnessController],
  providers: [
    FixtureIdentityMiddleware,
    MeriFeatureFlagsService,
    MeriHermesRuntimeClient,
    MeriHermesRunStore,
    DirectSecurityEnvelopePort,
    { provide: MERI_HERMES_RECALL_PORT, useClass: DirectMemoryItemsRecallPort },
    { provide: MERI_HERMES_SECURITY_ENVELOPE, useExisting: DirectSecurityEnvelopePort },
    { provide: MERI_TURN_MAINTENANCE, useValue: { scheduleAfterTurnMaintenance: () => undefined } },
    MeriHermesBrokerService,
    MeriHermesWorkerTokenGuard,
    MeriHermesRuntimeAdapter,
  ],
})
class HarnessModule implements NestModule {
  constructor(private readonly identity: FixtureIdentityMiddleware) {}
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(this.identity.use).forRoutes('*');
  }
}

async function main() {
  if (!HARNESS_SECRET) throw new Error('HARNESS_SECRET is required');
  const app = await NestFactory.create<NestExpressApplication>(HarnessModule, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api');
  app.use(express.json({ limit: '8mb' }));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(PORT, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`[harness-api] listening on http://0.0.0.0:${PORT}/api (NODE_ENV=${process.env.NODE_ENV})`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[harness-api] failed to start', error);
  process.exit(1);
});
