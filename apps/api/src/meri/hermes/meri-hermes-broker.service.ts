/**
 * MeriAgentToolBroker — the ONLY path a Hermes worker has into application
 * data. Every call is authenticated with a scope-bound worker token plus the
 * Hermes run id, re-resolved against Meri's own run record, and re-authorized
 * against CURRENT server state (membership still active, authorization
 * version unchanged, run still live, tool allowed by the run's policy).
 *
 * Phase 0 exposes six representative operations:
 *   memory.recall        — governed institutional-memory read (recall port)
 *   memory.propose       — governed candidate write (real MemoryCandidateService,
 *                          never admin, source_kind = model_extraction)
 *   attachments.read     — owner-scoped chat attachment materialisation
 *   artifacts.publish    — authorized artifact publication (ClioArtifact row)
 *   clarifications.create— durable-continuation clarification request
 *   turns.record         — provider sync_turn receipt (no memory write)
 *
 * It deliberately does NOT expose raw SQL, the platform service secret, or any
 * tool not named in the run envelope's tool policy.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MemoryCandidateService } from '../../memory/memory-candidate.service.js';
import type { MeriHermesPendingInteraction } from './hermes-runtime.contracts.js';
import { MERI_HERMES_RECALL_PORT, type MeriHermesRecallPort } from './meri-hermes-recall.ports.js';
import {
  MERI_HERMES_RUN_REPOSITORY,
  type MeriHermesRunRecord,
  type MeriHermesRunRepository,
} from './meri-hermes-run-store.js';
import {
  verifyMeriHermesWorkerToken,
  type MeriHermesWorkerTokenClaims,
} from './meri-hermes-worker-token.js';
import {
  MERI_HERMES_BROKER_TOOLS,
  MERI_HERMES_TERMINAL_STATUSES,
  type MeriHermesBrokerTool,
} from './hermes-runtime.contracts.js';
import { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import { MeriHermesArtifactStorageService } from './meri-hermes-artifact-storage.service.js';

export interface MeriHermesBrokerAuth {
  claims: MeriHermesWorkerTokenClaims;
  run: MeriHermesRunRecord;
  membershipRole: string;
}

export { MERI_HERMES_BROKER_TOOLS, type MeriHermesBrokerTool };

const MUTATING_TOOLS: ReadonlySet<MeriHermesBrokerTool> = new Set([
  'meri_memory_propose',
  'meri_publish_artifact',
]);

@Injectable()
export class MeriHermesBrokerService {
  private readonly logger = new Logger(MeriHermesBrokerService.name);

  /** Not a constructor parameter (Nest would try to inject it); overridable in tests. */
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MERI_HERMES_RUN_REPOSITORY) private readonly runs: MeriHermesRunRepository,
    private readonly candidates: MemoryCandidateService,
    @Inject(MERI_HERMES_RECALL_PORT) private readonly recallPort: MeriHermesRecallPort,
    private readonly adapter: MeriHermesRuntimeAdapter,
    private readonly artifactStorage: MeriHermesArtifactStorageService,
  ) {}

  /**
   * Authenticate a worker call. Throws HTTP exceptions with stable codes.
   * Order matters: token → run binding → scope match → liveness → CURRENT
   * membership → authorization version. Nothing is cached from the token.
   *
   * contracts.md §2: checking the NEXT tool call cannot undo context the
   * model already loaded into its window, so a live authorization failure
   * (expiry, version mismatch, membership removal) does not just deny THIS
   * call -- it fences the whole run. Before throwing, we ask the adapter to
   * stop the Hermes worker's execution of this run and finalize the Meri run
   * record to a terminal state (`expired` / `interrupted`), so the browser
   * sees an honest terminal frame instead of a silently hung run. A stale
   * transcript therefore can never be resumed: `authorize()` rejects the
   * NEXT call on this run with `run_not_live` (MERI_HERMES_TERMINAL_STATUSES
   * check above) rather than re-triggering another stop.
   */
  async authorize(token: string | null, hermesRunId: string | null, now = new Date()): Promise<MeriHermesBrokerAuth> {
    const signingKey = this.env.MERI_HERMES_BROKER_SIGNING_KEY?.trim() ?? '';
    if (!signingKey || signingKey.length < 32) {
      throw new ForbiddenException({ code: 'broker_not_configured', message: 'Broker signing key is not configured' });
    }
    if (!token) throw new UnauthorizedException({ code: 'missing_worker_token' });
    const verified = verifyMeriHermesWorkerToken(token, signingKey, now);
    if (!verified.ok) throw new UnauthorizedException({ code: `worker_token_${verified.reason}` });
    if (!hermesRunId) throw new UnauthorizedException({ code: 'missing_run_binding' });
    const run = await this.runs.findByHermesRunId(hermesRunId);
    if (!run) throw new NotFoundException({ code: 'run_not_found' });
    const { claims } = verified;
    if (
      run.envelope.tenantId !== claims.tenantId ||
      run.envelope.actorId !== claims.actorId ||
      run.envelope.executionScopeId !== claims.executionScopeId
    ) {
      this.logger.warn(`broker scope mismatch for run ${run.runId}`);
      throw new ForbiddenException({ code: 'scope_mismatch' });
    }
    if (MERI_HERMES_TERMINAL_STATUSES.has(run.status)) {
      throw new ConflictException({ code: 'run_not_live', status: run.status });
    }
    if (Date.parse(run.envelope.expiresAt) <= now.getTime()) {
      await this.runs.append(run.runId, 'error', { code: 'run_expired', frames: [] }, 'internal');
      await this.adapter.stopWorkerAndFinalize(run, {
        finishReason: 'expired',
        partial: true,
        output: null,
        error: 'Run authorization envelope expired.',
      });
      throw new ConflictException({ code: 'run_expired' });
    }
    if (run.envelope.authorizationVersion !== claims.authorizationVersion) {
      this.logger.warn(`authorization version mismatch for run ${run.runId}; stopping and fencing to interrupted`);
      await this.runs.append(run.runId, 'error', { code: 'authorization_version_mismatch', frames: [] }, 'internal');
      await this.adapter.stopWorkerAndFinalize(run, {
        finishReason: 'interrupted',
        partial: true,
        output: null,
        error: 'authorization_downgrade: authorization version changed mid-run.',
      });
      throw new ForbiddenException({ code: 'authorization_version_mismatch' });
    }
    // Recheck CURRENT membership on every call: removal fences a live run.
    const membership = await this.prisma.withTenant(run.envelope.tenantId, (tx) =>
      tx.tenantMembership.findFirst({
        where: { tenantId: run.envelope.tenantId, userId: run.envelope.actorId, status: 'active' },
        select: { role: true },
      }),
    );
    if (!membership) {
      this.logger.warn(`membership revoked mid-run for run ${run.runId}; stopping and fencing to interrupted`);
      await this.runs.append(run.runId, 'error', { code: 'authorization_revoked', frames: [] }, 'internal');
      await this.adapter.stopWorkerAndFinalize(run, {
        finishReason: 'interrupted',
        partial: true,
        output: null,
        error: 'authorization_downgrade: membership is no longer active.',
      });
      throw new ForbiddenException({ code: 'authorization_revoked' });
    }
    return { claims, run, membershipRole: membership.role };
  }

  async assertTool(auth: MeriHermesBrokerAuth, tool: MeriHermesBrokerTool): Promise<void> {
    const policy = auth.run.envelope.toolPolicy;
    if (policy.deny.includes(tool)) throw new ForbiddenException({ code: 'tool_denied', tool });
    if (policy.allow.length && !policy.allow.includes(tool)) {
      throw new ForbiddenException({ code: 'tool_not_allowed', tool });
    }
    if (policy.readOnly && MUTATING_TOOLS.has(tool)) {
      throw new ForbiddenException({ code: 'read_only_run', tool });
    }
    const calls = auth.run.brokerCalls + 1;
    if (calls > auth.run.envelope.budget.maxToolCalls) {
      throw new ForbiddenException({ code: 'tool_budget_exhausted', tool });
    }
    await this.runs.update(auth.run.runId, { brokerCalls: calls });
  }

  async recall(auth: MeriHermesBrokerAuth, input: { query: string; clientId?: string | null; limit?: number }) {
    await this.assertTool(auth, 'meri_memory_search');
    const query = input.query?.trim();
    if (!query) throw new BadRequestException('query is required');
    const limit = Math.max(1, Math.min(50, input.limit ?? 8));
    const result = await this.recallPort.recall(auth.run.actorContext, {
      query,
      clientId: input.clientId ?? null,
      limit,
      authorizedClientIds: auth.run.envelope.authorizedClientIds,
    });
    await this.runs.append(
      auth.run.runId,
      'memory.recalled',
      { path: result.path, returned: result.items.length, coverage: result.coverage, frames: [] },
      'internal',
    );
    return result;
  }

  async proposeMemory(
    auth: MeriHermesBrokerAuth,
    input: {
      key: string;
      value: string;
      scope: 'user_private' | 'firm' | 'client';
      clientId?: string | null;
      confidence?: number | null;
      sourceExcerpt?: string | null;
    },
  ) {
    await this.assertTool(auth, 'meri_memory_propose');
    if (input.scope === 'client') {
      if (!input.clientId) throw new BadRequestException('client scope requires clientId');
      if (!auth.run.envelope.authorizedClientIds.includes(input.clientId)) {
        throw new NotFoundException('Client not found');
      }
    }
    // The runtime is NEVER an admin: shared scopes always land pending in the
    // existing review queue; personal scope follows the existing PASS rule.
    const result = await this.candidates.proposeSaveMemory(
      auth.run.envelope.tenantId,
      auth.run.envelope.actorId,
      {
        scope: input.scope,
        ownerUserId: input.scope === 'user_private' ? auth.run.envelope.actorId : null,
        clientId: input.scope === 'client' ? input.clientId ?? null : null,
        key: input.key.trim().slice(0, 200),
        value: input.value.trim().slice(0, 8000),
        source: 'hermes_runtime',
        confidence: typeof input.confidence === 'number' ? input.confidence : null,
        sourceConversationId: auth.run.envelope.conversationId,
        sourceMessageId: auth.run.userMessageId,
        sourceExcerpt: input.sourceExcerpt?.slice(0, 1000) ?? null,
        sourceType: 'steward_extraction',
        sourceId: auth.run.runId,
      },
      false,
      'model_extraction',
    );
    await this.runs.append(
      auth.run.runId,
      'memory.proposed',
      { candidateId: result.candidateId, status: result.status, scope: input.scope, frames: [] },
      'public',
    );
    return result;
  }

  async getAttachment(auth: MeriHermesBrokerAuth, attachmentId: string) {
    await this.assertTool(auth, 'meri_fetch_attachment');
    const row = await this.prisma.withTenant(auth.run.envelope.tenantId, (tx) =>
      tx.clioAttachment.findFirst({
        where: { id: attachmentId, tenantId: auth.run.envelope.tenantId, userId: auth.run.envelope.actorId },
        select: {
          id: true,
          filename: true,
          kind: true,
          status: true,
          mediaType: true,
          byteSize: true,
          pages: true,
          textContent: true,
          data: true,
        },
      }),
    );
    if (!row) throw new NotFoundException('Attachment not found');
    await this.runs.append(
      auth.run.runId,
      'run.status',
      { attachmentRead: row.id, bytes: row.byteSize, hasOriginalBytes: Boolean(row.data), frames: [] },
      'internal',
    );
    return {
      id: row.id,
      filename: row.filename,
      kind: row.kind,
      status: row.status,
      mediaType: row.mediaType,
      byteSize: row.byteSize,
      pages: row.pages,
      /** Meri application-side extraction (ClioAttachment pipeline), when available. */
      textContent: row.textContent,
      /** Original bytes for native Hermes file handling; null for historical rows. */
      dataBase64: row.data ? Buffer.from(row.data).toString('base64') : null,
    };
  }

  async publishArtifact(
    auth: MeriHermesBrokerAuth,
    input: { title: string; kind: string; contentType?: string | null; filename?: string | null; bodyText?: string | null; dataBase64?: string | null },
  ) {
    await this.assertTool(auth, 'meri_publish_artifact');
    const bytes = input.dataBase64 ? Buffer.from(input.dataBase64, 'base64') : null;
    if (!bytes && !input.bodyText) throw new BadRequestException('bodyText or dataBase64 is required');
    const sha256 = createHash('sha256').update(bytes ?? Buffer.from(input.bodyText ?? '', 'utf8')).digest('hex');
    // Real bytes go to S3 (Phase 1 backlog #11 — no size cap once real
    // storage is used, unlike the Phase 0 inline-base64 prototype's 2 MiB
    // limit); a bodyText-only artifact (no bytes) is unaffected and keeps
    // working exactly as before.
    let s3Key: string | null = null;
    if (bytes) {
      s3Key = this.artifactStorage.buildKey({
        tenantId: auth.run.envelope.tenantId,
        runId: auth.run.runId,
        filename: input.filename ?? null,
      });
      await this.artifactStorage.putBytes(s3Key, bytes, input.contentType ?? null);
    }
    const artifact = await this.prisma.withTenant(auth.run.envelope.tenantId, (tx) =>
      tx.clioArtifact.create({
        data: {
          tenantId: auth.run.envelope.tenantId,
          userId: auth.run.envelope.actorId,
          conversationId: auth.run.envelope.conversationId,
          title: input.title.trim().slice(0, 200) || 'Hermes artifact',
          kind: input.kind.trim().slice(0, 60) || 'hermes_file',
          contentType: input.contentType ?? null,
          bodyText: input.bodyText ?? null,
          s3Key,
          metadata: {
            runtime: 'hermes',
            meriRunId: auth.run.runId,
            hermesRunId: auth.run.hermesRunId,
            filename: input.filename ?? null,
            sha256,
            byteLength: bytes?.byteLength ?? Buffer.byteLength(input.bodyText ?? '', 'utf8'),
            storage: s3Key ? 's3' : 'body_text',
          } as Prisma.InputJsonValue,
        },
        select: { id: true, title: true, kind: true, contentType: true },
      }),
    );
    await this.runs.append(auth.run.runId, 'artifact.published', {
      artifactId: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      sha256,
      frames: [
        {
          type: 'artifact',
          artifact: {
            id: artifact.id,
            title: artifact.title,
            kind: artifact.kind,
            ...(input.bodyText && input.bodyText.length <= 20000 ? { bodyText: input.bodyText } : {}),
            filename: input.filename ?? undefined,
            mimeType: artifact.contentType ?? undefined,
            downloadUrl: `/api/clio/hermes/artifacts/${artifact.id}`,
          },
        },
      ],
    });
    return { artifactId: artifact.id, sha256, downloadUrl: `/api/clio/hermes/artifacts/${artifact.id}` };
  }

  async requestClarification(
    auth: MeriHermesBrokerAuth,
    input: { question: string; choices?: string[]; multiSelect?: boolean },
  ) {
    await this.assertTool(auth, 'meri_request_clarification');
    const question = input.question?.trim();
    if (!question) throw new BadRequestException('question is required');
    const choices = (input.choices ?? []).map((c) => String(c).trim()).filter(Boolean).slice(0, 4);
    const requestId = `clar_${randomUUID()}`;
    const interaction: MeriHermesPendingInteraction = {
      requestId,
      kind: 'clarification',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      prompt: question,
      choices,
      multiSelect: Boolean(input.multiSelect) && choices.length > 0,
      continuation: 'durable_continuation',
      resolution: null,
    };
    await this.runs.addInteraction(auth.run.runId, interaction);
    await this.runs.update(auth.run.runId, { status: 'waiting_for_clarification' });
    await this.runs.append(auth.run.runId, 'clarification.requested', {
      requestId,
      question,
      choices,
      multiSelect: interaction.multiSelect,
      frames: [
        {
          type: 'clarify',
          runtime: 'hermes',
          requestId,
          questions: [{ id: requestId, question, choices, multiSelect: interaction.multiSelect }],
          continuation: 'durable_continuation',
        },
      ],
    });
    return {
      requestId,
      instruction:
        'The question has been delivered to the user in Meri. End your turn now with one short sentence saying you are waiting for their answer. Do not guess; the answer arrives as the next user message.',
    };
  }

  async recordTurn(auth: MeriHermesBrokerAuth, input: { userChars?: number; assistantChars?: number }) {
    await this.assertTool(auth, 'meri_record_turn');
    await this.runs.append(
      auth.run.runId,
      'run.status',
      { providerSyncTurn: true, userChars: input.userChars ?? null, assistantChars: input.assistantChars ?? null, frames: [] },
      'internal',
    );
    return { recorded: true, authoritativeMemory: 'meri_institutional_memory' };
  }

  whoami(auth: MeriHermesBrokerAuth) {
    return {
      tenantId: auth.run.envelope.tenantId,
      actorId: auth.run.envelope.actorId,
      executionScopeId: auth.run.envelope.executionScopeId,
      meriRunId: auth.run.runId,
      hermesRunId: auth.run.hermesRunId,
      audience: auth.run.envelope.audience,
      toolPolicy: auth.run.envelope.toolPolicy,
      authorizedClientCount: auth.run.envelope.authorizedClientIds.length,
      authorizationVersion: auth.run.envelope.authorizationVersion,
      membershipRole: auth.membershipRole,
    };
  }
}
