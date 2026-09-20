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
  isReadOnlySafeTool,
  type MeriHermesBrokerTool,
} from './hermes-runtime.contracts.js';
import { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import { MeriHermesArtifactStorageService } from './meri-hermes-artifact-storage.service.js';
import { MeriHermesDbGovernor, meriHermesSharedDbGovernor } from './meri-hermes-db-governor.js';
import { meriHermesBoundedPage, meriHermesScalingLimits } from './meri-hermes-scaling.config.js';

export interface MeriHermesBrokerAuth {
  claims: MeriHermesWorkerTokenClaims;
  run: MeriHermesRunRecord;
  membershipRole: string;
}

export { MERI_HERMES_BROKER_TOOLS, type MeriHermesBrokerTool };

/**
 * Closeout defect A5. The hand-maintained `MUTATING_TOOLS` set that used to
 * live here has been replaced by the exhaustive, fail-closed
 * `MERI_HERMES_TOOL_EFFECTS` classification in hermes-runtime.contracts.ts
 * (`isReadOnlySafeTool`). A set of "the mutating ones" is fail-OPEN by
 * construction — every tool nobody remembered to add to it was treated as
 * read-only — and the growth path this broker exists to serve is exactly
 * "Phase 2 adds more tools".
 */

/** S-4: governed-recall page size. Unchanged values, now named and centrally clamped. */
const RECALL_DEFAULT_LIMIT = 8;
const RECALL_MAX_LIMIT = 50;

@Injectable()
export class MeriHermesBrokerService {
  private readonly logger = new Logger(MeriHermesBrokerService.name);

  /** Not a constructor parameter (Nest would try to inject it); overridable in tests. */
  env: NodeJS.ProcessEnv = process.env;

  /**
   * S-4 — bounded database and tool usage.
   *
   * A public, lazily-created FIELD rather than a constructor parameter, the
   * same convention `env` already uses here, and for the same reason: seven
   * specs construct this service positionally and widening the constructor
   * would break every one of them for no benefit.
   *
   * Every broker tool below runs inside `governor.guard(...)`, which is one
   * bounded-concurrency slot (default: 20 % of the API connection pool — 6 of
   * 33 on this host's configured URL) plus one deadline (default 30 s). The
   * slot cap is what leaves application traffic its headroom; the deadline is
   * what stops one stuck tool call from holding a slot indefinitely, together
   * with the `SET LOCAL statement_timeout` the governor applies to the
   * transactions it opens.
   */
  dbGovernor: MeriHermesDbGovernor = meriHermesSharedDbGovernor();

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
    // At entry the authorization version is checked against the CREDENTIAL's
    // claims: a token minted under a newer version must not drive an older run.
    const live = await this.assertLiveAuthorization(run, claims.authorizationVersion, now, 'entry');
    return { claims, run: live.run, membershipRole: live.membershipRole };
  }

  /**
   * Re-verify a run's LIVE authorization against CURRENT server state:
   * run liveness/fence, envelope expiry, `authorizationVersion` equality with
   * `expectedAuthorizationVersion`, and CURRENT active membership.
   *
   * What that version is depends on the phase, and the difference matters:
   *   - 'entry' compares the run envelope against the CREDENTIAL's claims, so
   *     a token minted under a different authorization version cannot drive
   *     this run (the check contracts.md §2 describes).
   *   - 'release' compares the FRESHLY RE-READ envelope against the version
   *     this call was admitted under, so what it detects is the stored
   *     authorization changing WHILE the read was in flight. Re-comparing the
   *     credential's claims there would only repeat the entry check, since
   *     claims are immutable for the life of a call.
   *
   * Every failure branch behaves exactly as the entry-time revocation branch
   * always did: append the durable `error` event, ask the adapter to stop the
   * Hermes worker and finalize the Meri run to a terminal state
   * (`expired` / `interrupted`), then throw the stable-coded HTTP exception.
   * Calling it twice is safe: the second call short-circuits on the terminal
   * status with `run_not_live` instead of re-fencing.
   *
   * `phase` is diagnostic only: 'entry' is the pre-handler check
   * (`authorize()`), 'release' is the post-read, pre-return check
   * (`assertStillAuthorizedBeforeRelease()`).
   */
  private async assertLiveAuthorization(
    run: MeriHermesRunRecord,
    expectedAuthorizationVersion: string | undefined,
    now: Date,
    phase: 'entry' | 'release',
  ): Promise<{ run: MeriHermesRunRecord; membershipRole: string }> {
    // At 'entry' the caller has just loaded the run by its Hermes run id, so
    // the record is already fresh and a second read would only add a round
    // trip to every tool call. At 'release' it may be minutes old and a fence
    // may have landed in between, so re-read.
    //
    // Closeout defect A6: that re-read used to be `(await get()) ?? run`. A
    // missing row silently substituted the ENTRY-TIME snapshot and the
    // release check then validated stale state — precisely what F-1 exists to
    // prevent, and it failed open in the one branch whose entire job is to
    // catch a change that landed while the read was in flight. A live run
    // whose record has vanished (deleted, pruned, wrong replica's view, a
    // repository returning null for any reason) is not a run we can certify
    // as still authorized, so it is a hard failure in the `run_not_live`
    // shape the worker already handles.
    //
    // Nothing is fenced here: fencing means appending an `error` event to the
    // run and finalizing it, and there is no row to append to or finalize.
    // Withholding the payload is the whole of the available remedy.
    let current: MeriHermesRunRecord;
    if (phase === 'release') {
      const reread = await this.runs.get(run.runId);
      if (!reread) {
        this.logger.error(
          `run record ${run.runId} disappeared before release; refusing to validate the entry-time snapshot`,
        );
        throw new ConflictException({ code: 'run_not_live', status: 'missing' });
      }
      current = reread;
    } else {
      current = run;
    }
    if (MERI_HERMES_TERMINAL_STATUSES.has(current.status)) {
      throw new ConflictException({ code: 'run_not_live', status: current.status });
    }
    if (Date.parse(current.envelope.expiresAt) <= now.getTime()) {
      await this.runs.append(current.runId, 'error', { code: 'run_expired', phase, frames: [] }, 'internal');
      await this.adapter.stopWorkerAndFinalize(current, {
        finishReason: 'expired',
        partial: true,
        output: null,
        error: 'Run authorization envelope expired.',
      });
      throw new ConflictException({ code: 'run_expired' });
    }
    if (current.envelope.authorizationVersion !== expectedAuthorizationVersion) {
      this.logger.warn(
        `authorization version mismatch for run ${current.runId} (${phase}); stopping and fencing to interrupted`,
      );
      await this.runs.append(
        current.runId,
        'error',
        { code: 'authorization_version_mismatch', phase, frames: [] },
        'internal',
      );
      await this.adapter.stopWorkerAndFinalize(current, {
        finishReason: 'interrupted',
        partial: true,
        output: null,
        error: 'authorization_downgrade: authorization version changed mid-run.',
      });
      throw new ForbiddenException({ code: 'authorization_version_mismatch' });
    }
    // Recheck CURRENT membership on every call: removal fences a live run.
    const membership = await this.prisma.withTenant(current.envelope.tenantId, (tx) =>
      tx.tenantMembership.findFirst({
        where: { tenantId: current.envelope.tenantId, userId: current.envelope.actorId, status: 'active' },
        select: { role: true },
      }),
    );
    if (!membership) {
      this.logger.warn(`membership revoked mid-run for run ${current.runId} (${phase}); stopping and fencing to interrupted`);
      await this.runs.append(current.runId, 'error', { code: 'authorization_revoked', phase, frames: [] }, 'internal');
      await this.adapter.stopWorkerAndFinalize(current, {
        finishReason: 'interrupted',
        partial: true,
        output: null,
        error: 'authorization_downgrade: membership is no longer active.',
      });
      throw new ForbiddenException({ code: 'authorization_revoked' });
    }
    return { run: current, membershipRole: membership.role };
  }

  /**
   * RELEASE GUARD (Phase 1 finding F-1). `authorize()` runs once, at entry to a
   * tool call. A governed read that takes real time — the Context Plane recall
   * is a multi-table query — can therefore be authorized microseconds before a
   * revocation lands and still hand its payload to the worker, and from there
   * to the model, where contracts.md §2 says no later check can remove it.
   *
   * So every broker path that RETURNS DATA re-verifies the same live state
   * AFTER the underlying read resolves and BEFORE the payload is returned. On
   * failure the payload is discarded by construction (this throws, so the
   * caller's `return` is never reached — the bytes are only ever a local
   * variable), the attempt is fenced exactly as the entry-time branch fences
   * it, and the worker gets the same stable-coded 403/409.
   *
   * Mutating paths (`proposeMemory`, `publishArtifact`, `requestClarification`)
   * deliberately do NOT carry this guard: their work is already committed by
   * the time it would run, so a 403 there would report failure for a write that
   * happened. Their protection remains the entry check plus the fact that a
   * fenced run rejects every subsequent call with `run_not_live`.
   */
  private async assertStillAuthorizedBeforeRelease(auth: MeriHermesBrokerAuth): Promise<void> {
    /**
     * The version compared here is the one this call was ADMITTED under
     * (`auth.run.envelope.authorizationVersion`, already checked against the
     * credential's claims at entry), re-read from the store. That is the
     * comparison that can actually change while a read is in flight; the
     * credential's own claims are immutable for the life of the call, so
     * re-comparing against them would only repeat the entry check.
     */
    await this.assertLiveAuthorization(auth.run, auth.run.envelope.authorizationVersion, new Date(), 'release');
  }

  /**
   * The tool gate. Every broker operation calls this first, and it is the
   * only place the run's tool policy and tool budget are enforced.
   *
   * Order is deliberate and each step is fail-CLOSED:
   *
   *   1. `deny` wins over everything (defense in depth).
   *   2. `allow` is an ALLOW-LIST, applied unconditionally. Empty permits
   *      nothing — which is what `MeriHermesToolPolicy.allow` has always
   *      documented ("Empty = none") and what the code did not do (A3: the
   *      guard was `policy.allow.length && !policy.allow.includes(tool)`, so
   *      `allow: []` short-circuited on falsy `0` and permitted EVERY tool).
   *   3. A `readOnly` run admits only tools explicitly classified read-only-
   *      safe, so an unclassified tool is refused rather than assumed
   *      harmless (A5).
   *   4. The budget is consumed with ONE atomic conditional statement and the
   *      cap is enforced on its RESULT, so N concurrent calls against a
   *      budget of M admit exactly M (A4).
   *
   * Budget consumption is last on purpose: a call refused by policy must not
   * burn budget, and the reservation must be the final thing that can fail,
   * so an admitted reservation is always followed by the tool actually
   * running.
   */
  async assertTool(auth: MeriHermesBrokerAuth, tool: MeriHermesBrokerTool): Promise<void> {
    const policy = auth.run.envelope.toolPolicy;
    if (policy.deny.includes(tool)) throw new ForbiddenException({ code: 'tool_denied', tool });
    if (!policy.allow.includes(tool)) {
      throw new ForbiddenException({ code: 'tool_not_allowed', tool });
    }
    if (policy.readOnly && !isReadOnlySafeTool(tool)) {
      throw new ForbiddenException({ code: 'read_only_run', tool });
    }
    const reservation = await this.runs.reserveBrokerCall(
      auth.run.runId,
      auth.run.envelope.budget.maxToolCalls,
    );
    if (!reservation.admitted) {
      throw new ForbiddenException({ code: 'tool_budget_exhausted', tool });
    }
    // Keep the in-flight auth snapshot consistent with what was actually
    // reserved, so `whoami()` and any later read of `auth.run` in THIS call
    // report the post-reservation count rather than the entry-time one.
    auth.run.brokerCalls = reservation.brokerCalls;
  }

  /** S-4: bounded slot + deadline; the body is `recallGoverned`. */
  async recall(auth: MeriHermesBrokerAuth, input: { query: string; clientId?: string | null; limit?: number }) {
    return this.dbGovernor.guard('meri_memory_search', () => this.recallGoverned(auth, input));
  }

  private async recallGoverned(auth: MeriHermesBrokerAuth, input: { query: string; clientId?: string | null; limit?: number }) {
    await this.assertTool(auth, 'meri_memory_search');
    const query = input.query?.trim();
    if (!query) throw new BadRequestException('query is required');
    /**
     * S-4 — an EXPLICIT, configured result limit on a read that would otherwise
     * be unbounded. The numbers are unchanged from what this line already did
     * (default 8, hard ceiling 50) — a "bounded usage" change must not widen an
     * existing bound — but they now go through the shared `meriHermesBoundedPage`
     * primitive and are additionally capped by the global `maxPageSize`, so one
     * place governs every paged broker read rather than each one carrying its
     * own literals.
     */
    const scaling = meriHermesScalingLimits(this.env);
    const page = meriHermesBoundedPage(
      { limit: input.limit ?? RECALL_DEFAULT_LIMIT },
      { defaultPageSize: RECALL_DEFAULT_LIMIT, maxPageSize: Math.min(RECALL_MAX_LIMIT, scaling.maxPageSize) },
    );
    const limit = page.limit;
    const result = await this.recallPort.recall(auth.run.actorContext, {
      query,
      clientId: input.clientId ?? null,
      limit,
      authorizedClientIds: auth.run.envelope.authorizedClientIds,
    });
    // F-1 release guard: `result` is still only a local variable here. If
    // authorization changed while the governed read was running, this throws
    // and the payload is discarded without ever reaching the worker.
    await this.assertStillAuthorizedBeforeRelease(auth);
    await this.runs.append(
      auth.run.runId,
      'memory.recalled',
      { path: result.path, returned: result.items.length, coverage: result.coverage, frames: [] },
      'internal',
    );
    return result;
  }

  /** S-4: bounded slot + deadline; the body is `proposeMemoryGoverned`. */
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
    return this.dbGovernor.guard('meri_memory_propose', () => this.proposeMemoryGoverned(auth, input));
  }

  private async proposeMemoryGoverned(
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

  /** S-4: bounded slot + deadline; the body is `getAttachmentGoverned`. */
  async getAttachment(auth: MeriHermesBrokerAuth, attachmentId: string) {
    return this.dbGovernor.guard('meri_fetch_attachment', () => this.getAttachmentGoverned(auth, attachmentId));
  }

  private async getAttachmentGoverned(auth: MeriHermesBrokerAuth, attachmentId: string) {
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
    // F-1 release guard, same rule as `recall()`: the attachment bytes are
    // still only a local variable, and a revocation that landed while this
    // read was in flight must withhold them rather than hand them to the model.
    await this.assertStillAuthorizedBeforeRelease(auth);
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

  /** S-4: bounded slot + deadline; the body is `publishArtifactGoverned`. */
  async publishArtifact(
    auth: MeriHermesBrokerAuth,
    input: { title: string; kind: string; contentType?: string | null; filename?: string | null; bodyText?: string | null; dataBase64?: string | null },
  ) {
    return this.dbGovernor.guard('meri_publish_artifact', () => this.publishArtifactGoverned(auth, input));
  }

  private async publishArtifactGoverned(
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

  /** S-4: bounded slot + deadline; the body is `requestClarificationGoverned`. */
  async requestClarification(
    auth: MeriHermesBrokerAuth,
    input: { question: string; choices?: string[]; multiSelect?: boolean },
  ) {
    return this.dbGovernor.guard('meri_request_clarification', () => this.requestClarificationGoverned(auth, input));
  }

  private async requestClarificationGoverned(
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

  /** S-4: bounded slot + deadline; the body is `recordTurnGoverned`. */
  async recordTurn(auth: MeriHermesBrokerAuth, input: { userChars?: number; assistantChars?: number }) {
    return this.dbGovernor.guard('meri_record_turn', () => this.recordTurnGoverned(auth, input));
  }

  private async recordTurnGoverned(auth: MeriHermesBrokerAuth, input: { userChars?: number; assistantChars?: number }) {
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
