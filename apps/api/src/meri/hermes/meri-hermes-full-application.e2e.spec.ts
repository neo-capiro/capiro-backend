/**
 * CLOSEOUT GATE — full-application evidence for the Meri ⇄ Hermes governed path.
 *
 * `meri-hermes-governed-recall.integration.spec.ts` (kept, still runs) proves the
 * governed recall RAIL against real Postgres, but it hand-constructs the broker,
 * substitutes `ContextPlaneGatewayService` with a shim and never passes through
 * the authentication boundary. The closeout order requires the missing layer:
 *
 *   "Boot the actual application modules, authentication boundary, Context Plane
 *    gateway, durable run repository and broker against controlled fixtures.
 *    Exercise a real Hermes turn through the authenticated Meri route. Do not
 *    substitute the central governance path with a shim and call it full API
 *    validation."
 *
 * ── WHAT IS REAL HERE ────────────────────────────────────────────────────────
 *  * A real Nest HTTP server (`app.listen(0)`) configured by the production
 *    `configureApiHttpApp()` (global prefix, ValidationPipe, Prisma filter),
 *    over `AppModule`'s real infrastructure spine (the same
 *    `ConfigModule.forRoot` + zod validation, `PrismaModule`, global
 *    `AuthModule` / `TenantModule` / `TangoModule`) plus the real `MeriModule`
 *    and everything it transitively imports. See the `CloseoutApplicationModule`
 *    comment in `beforeAll` for exactly why the literal `AppModule` import is
 *    not used here and how to reproduce it (jest heap, not a code defect).
 *  * The real authentication boundary: `TenantContextMiddleware` (membership
 *    resolution, tenant/org cross-checks, AsyncLocalStorage propagation) and
 *    the real `RolesGuard`. Requests arrive over real HTTP with a real
 *    `Authorization: Bearer` header.
 *  * The real Context Plane: `MeriContextPlaneRuntimeService.runChatTurn` and
 *    the REAL `ContextPlaneGatewayService` (via `MeriContextPlaneService`), the
 *    real `ContextResolverService`, the real `InstitutionalKnowledgeRetrievalAdapter`.
 *  * The real `ContextPlaneRecallPort` bound to `MERI_HERMES_RECALL_PORT` by the
 *    production `MeriModule` — not the harness `DirectMemoryItemsRecallPort`.
 *  * The real durable run repository (`MeriHermesPrismaRunRepository`, Prisma,
 *    `meri_agent_runs` / `_run_events` / `_interactions`) — resolved from DI, not
 *    the in-memory `MeriHermesRunStore`.
 *  * The real broker (`MeriHermesBrokerService` + `MeriHermesBrokerController` +
 *    `MeriHermesWorkerTokenGuard`), reached over real HTTP on /api/internal.
 *  * A REAL Hermes worker: the pinned `meri-hermes-worker:v2026.9.14-meri`
 *    container, launched by this spec, pointed at the API this spec booted, with
 *    a freshly minted scope-bound worker token — so the worker's own memory
 *    provider calls back into this broker, and a real model runs the turn.
 *  * Real local Postgres fixtures (tenants, users, memberships, clients, ethical
 *    wall grants, governed `memory_items`).
 *
 * ── WHAT IS SUBSTITUTED, AND WHY (nothing else) ──────────────────────────────
 *  1. `ClerkService.verifySessionToken` is replaced by a deterministic verifier
 *     that maps an opaque test bearer to `{ sub: <clerkUserId> }`. Clerk is an
 *     external SaaS; there is no way to mint a genuine Clerk session JWT
 *     offline, and `CLERK_SECRET_KEY` is not available locally. EVERYTHING the
 *     middleware does after claim verification — user lookup, membership scan,
 *     tenant resolution, cross-checks, denial auditing, ALS propagation — is the
 *     real code. Claims are per-token and a token for a user is never accepted
 *     as another user.
 *  2. The model provider is OpenAI through the worker's own baked
 *     `OPENAI_API_KEY` (read out of the already-running `meri-hermes-p0-alice`
 *     container at runtime, never printed). That is a real model, not a stub.
 *  3. `sanitize-html` is replaced by an identity function, ONLY so that
 *     `AppModule` can be imported at all under jest. `sanitize-html@2.17`
 *     pulls `htmlparser2@12`, which is ESM-only, and this repo's
 *     `transformIgnorePatterns` carves out exactly one package (`@makegov`), so
 *     jest dies at `src/users/users.controller.ts` → `src/common/sanitize-signature.ts`.
 *     This is a PRE-EXISTING branch defect, not something this spec introduced:
 *     `src/app.module.spec.ts` (the DI-graph boot smoke test) fails at the same
 *     line today. The sanitizer is used by exactly one route
 *     (PUT /api/me/email-signature) which this gate never calls; nothing in the
 *     Meri/Hermes path reads it. See the closeout report for the one-line
 *     jest.config.cjs fix (left unmade: shared file, concurrent sessions).
 *
 * Everything else in the chain is the production class.
 *
 * ── OBSERVATION AND FAULT INJECTION (neither is a substitution) ──────────────
 * Three jest spies wrap production code without replacing its logic, so that
 * what the governed path actually returned can be asserted, and so that a
 * failure/race can be provoked deterministically:
 *  a. `MeriHermesBrokerService.recall` — calls the real method and records its
 *     real return value (`recallCalls`); the caller gets that same value.
 *  b. the `MERI_HERMES_RECALL_PORT` instance's `recall` in section B — gates
 *     the FIRST governed read on a promise so a membership revocation can land
 *     strictly mid-read, then calls the real port and restores itself.
 *  c. `MeriContextPlaneService.searchToolData` in assertion 6 — made to reject
 *     once, to observe what the broker hands a worker when the governed
 *     boundary is unavailable. Restored immediately, and the following
 *     assertion proves the real path still works.
 *
 * ── PRECONDITIONS ────────────────────────────────────────────────────────────
 *  * local Postgres (`capiro-postgres`) reachable via DATABASE_URL (asserted
 *    local-only below — this suite writes and deletes rows).
 *  * docker, and the pinned image `meri-hermes-worker:v2026.9.14-meri`.
 *  * the reference container `meri-hermes-p0-alice` present, only as the source
 *    of the model key / gateway key (its own env points at the retired Phase 0
 *    harness, so it cannot be used for broker callbacks).
 *
 * Containers created here are named `meri-hermes-closeout-*` and are removed in
 * afterAll. No other container is touched.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';

/**
 * Substitution (3) in the header: the ONLY reason is that jest cannot parse
 * `htmlparser2@12` (ESM-only) which `sanitize-html` requires, so importing
 * `AppModule` explodes before any Meri code runs. Identity is safe here because
 * no route this suite touches reads an email signature.
 */
jest.mock('sanitize-html', () => {
  const identity = (html: string) => html;
  const simpleTransform = (tagName: string, attribs: Record<string, string>) => () => ({ tagName, attribs });
  Object.assign(identity, {
    simpleTransform,
    defaults: { allowedTags: [], allowedAttributes: {}, allowedSchemes: [], selfClosing: [] },
  });
  return { __esModule: true, default: identity, simpleTransform, defaults: (identity as never as { defaults: unknown }).defaults };
});

// ---------------------------------------------------------------------------
// Environment MUST be established before AppModule is imported (ConfigModule
// validates at module construction). Every import of application code below is
// therefore dynamic, inside beforeAll.
// ---------------------------------------------------------------------------
function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-full-application.e2e.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-full-application.e2e.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

process.env.CLERK_SECRET_KEY ??= 'sk_test_meri_hermes_closeout';
process.env.CLERK_WEBHOOK_SIGNING_SECRET ??= 'whsec_meri_hermes_closeout';
process.env.NODE_ENV ??= 'test';

/** jest's node sandbox does not forward Node's global fetch; jest.setup.ts installs a rejecting stub. */
function installRealFetch(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const undici = require('undici') as { fetch: typeof fetch; Headers: unknown; Request: unknown; Response: unknown };
  (globalThis as Record<string, unknown>).fetch = undici.fetch;
  (globalThis as Record<string, unknown>).Headers = undici.Headers;
  (globalThis as Record<string, unknown>).Request = undici.Request;
  (globalThis as Record<string, unknown>).Response = undici.Response;
}
installRealFetch();

const REFERENCE_CONTAINER = process.env.MERI_HERMES_REFERENCE_CONTAINER ?? 'meri-hermes-p0-alice';
const WORKER_IMAGE = process.env.HERMES_IMAGE ?? 'meri-hermes-worker:v2026.9.14-meri';
const WORKER_CONTAINER = 'meri-hermes-closeout-alice';
const WORKER_VOLUME = 'meri-hermes-closeout-alice-home';
const WORKER_PORT = Number(process.env.MERI_HERMES_CLOSEOUT_PORT ?? 18743);

function sh(bin: string, argv: string[]): string {
  return execFileSync(bin, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}
/** Reads one env var out of a container WITHOUT ever logging it. */
function containerEnv(container: string, name: string): string {
  const all = sh('docker', ['inspect', container, '--format', '{{range .Config.Env}}{{println .}}{{end}}']);
  for (const line of all.split('\n')) {
    if (line.startsWith(`${name}=`)) return line.slice(name.length + 1).trim();
  }
  throw new Error(`container ${container} has no ${name}`);
}
function dockerRm(name: string): void {
  try {
    sh('docker', ['rm', '-f', name]);
  } catch {
    /* absent */
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fixture seeding and teardown run as ONE interactive transaction each and do
 * real work (two tenants, three users, two clients, a grant, five conversations
 * and six governed `memory_items`). Prisma's default interactive-transaction
 * budget is 5 000 ms, which a cold or loaded box can exceed — and when it does,
 * every test in the file fails from `beforeAll` for a reason that has nothing
 * to do with what is being proven.
 */
const FIXTURE_TX_TIMEOUT_MS = 60_000;

/**
 * Retry a cold-start-sensitive Prisma call. Only transaction-timeout /
 * connection-pool errors are retried, and only twice: a genuine authorization
 * or query defect must still fail immediately and loudly.
 */
async function withTransientRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient =
        /Transaction already closed|expired transaction|Timed out fetching a new connection|connection pool/i.test(message);
      if (!transient || attempt === attempts) {
        throw new Error(`${label} failed (attempt ${attempt}/${attempts}): ${message}`, { cause: error });
      }
      last = error;
      await sleep(1_000 * attempt);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

interface SseResult {
  status: number;
  contentType: string | null;
  frames: Array<Record<string, unknown>>;
  raw: string;
}

describe('CLOSEOUT — real AppModule + real auth boundary + real Context Plane + real broker + a REAL Hermes worker', () => {
  jest.setTimeout(900_000);

  // ── fixture identity ─────────────────────────────────────────────────────
  const pilotTenantId = randomUUID();
  const outsideTenantId = randomUUID();
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const carolId = randomUUID();
  const openClientId = randomUUID();
  const walledClientId = randomUUID();
  const convAliceId = randomUUID();
  const convAlice2Id = randomUUID();
  const convAlice3Id = randomUUID();
  const convAlice4Id = randomUUID();
  const convBobId = randomUUID();
  const convBob2Id = randomUUID();

  // ── fixture governed memory ──────────────────────────────────────────────
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const FIRM_MARKER = `CLOSEOUT-${tag}-FIRM-DILIGENCE`;
  const ALICE_MARKER = `CLOSEOUT-${tag}-ALICE-PRIVATE`;
  const BOB_MARKER = `CLOSEOUT-${tag}-BOB-PRIVATE`;
  const WALLED_MARKER = `CLOSEOUT-${tag}-WALLED-CLIENT`;
  const QUARANTINE_MARKER = `CLOSEOUT-${tag}-QUARANTINED`;
  const OUTSIDE_MARKER = `CLOSEOUT-${tag}-OUTSIDE-TENANT`;
  const PROPOSED_MARKER = `CLOSEOUT-${tag}-PROPOSED`;
  const ARTIFACT_MARKER = `CLOSEOUT-${tag}-ARTIFACT`;
  const firmFactId = randomUUID();
  const aliceFactId = randomUUID();
  const bobFactId = randomUUID();
  const walledFactId = randomUUID();
  const quarantinedFactId = randomUUID();
  const outsideFactId = randomUUID();

  /**
   * A turn that parks. `HERMES_EXEC_ASK=1` makes the pinned worker surface a
   * guarded shell command as a native `approval.request` and BLOCK inside the
   * run until Meri answers, which is what gives this suite a genuinely live,
   * non-terminal run to issue worker-facing broker probes against.
   */
  const PARK_PROMPT =
    'Create the directory /opt/data/workspace/tmp-fixture with mkdir -p, then run exactly ' +
    '`chmod -R 777 /opt/data/workspace/tmp-fixture` with the terminal tool. ' +
    'If the command is denied, say "DENIED" and stop; if it runs, say "RAN".';

  /** Real results of every `MeriHermesBrokerService.recall()` call, observed, never altered. */
  const recallCalls: Array<{
    actorId: string;
    input: { query: string; clientId?: string | null; limit?: number };
    result: import('./meri-hermes-recall.ports.js').MeriHermesRecallResult;
  }> = [];

  // ── process state ────────────────────────────────────────────────────────
  let app: INestApplication;
  let apiPort: number;
  let apiBase: string;
  let prisma: import('../../prisma/prisma.service.js').PrismaService;
  let broker: import('./meri-hermes-broker.service.js').MeriHermesBrokerService;
  let runRepo: import('./meri-hermes-run-store.js').MeriHermesRunRepository;
  let mintToken: typeof import('./meri-hermes-worker-token.js').mintMeriHermesWorkerToken;
  let scopeIdFor: typeof import('./meri-hermes-worker-token.js').privateExecutionScopeId;
  let computeVersion: typeof import('./meri-hermes-runtime.adapter.js').computeAuthorizationVersion;
  let aliceCtx: TenantContext;
  let bobCtx: TenantContext;
  const brokerSigningKey = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  let workerGatewayKey: string;
  let aliceScopeId: string;
  let aliceAuthorizationVersion: string;
  let aliceWorkerToken: string;
  let bobScopeId: string;
  let bobAuthorizationVersion: string;
  let bobWorkerToken: string;
  /**
   * The conversation A1's real Hermes turn ran in. Hoisted to the suite scope
   * because D1 needs a COMPLETED (stale) Hermes run id, and A1's run is the
   * only naturally terminal one in the file.
   */
  let a1ConversationId = '';
  let a1Attempts: string[] = [];
  let contextPlane: import('../meri-context-plane.service.js').MeriContextPlaneService;
  let candidates: import('../../memory/memory-candidate.service.js').MemoryCandidateService;
  const savedEnv: Record<string, string | undefined> = {};
  const openStreams: AbortController[] = [];

  // ── tiny HTTP helpers (real HTTP against the booted server) ──────────────
  const bearerFor = (userId: string) => `closeout-session:${userId}`;

  async function api(
    method: string,
    path: string,
    opts: { as?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; json: unknown; text: string }> {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.as ? { authorization: `Bearer ${bearerFor(opts.as)}` } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  }

  /** POST a turn through the authenticated Meri route and collect the SSE frames. */
  async function streamTurn(as: string, conversationId: string, body: string, timeoutMs = 240_000): Promise<SseResult> {
    const response = await fetch(`${apiBase}/api/clio/conversations/${conversationId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerFor(as)}`, accept: 'text/event-stream' },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    const frames: Array<Record<string, unknown>> = [];
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        frames.push(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        /* keepalive / partial */
      }
    }
    return { status: response.status, contentType: response.headers.get('content-type'), frames, raw };
  }

  /** A raw worker-style broker call: exactly what the Hermes plugin sends. */
  async function brokerCall(
    method: string,
    path: string,
    opts: { token: string; hermesRunId: string | null; body?: unknown },
  ): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const response = await fetch(`${apiBase}/api/internal/hermes/broker${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.token}`,
        ...(opts.hermesRunId === null ? {} : { 'x-meri-hermes-run-id': opts.hermesRunId }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }

  interface LiveRun {
    runId: string;
    hermesRunId: string;
    approvalRequestId: string | null;
    status: string;
  }

  /**
   * Start a REAL turn through the authenticated Meri route and leave it LIVE.
   *
   * The turn asks for a guarded shell command. With `HERMES_EXEC_ASK=1` the
   * pinned worker emits `approval.request` and BLOCKS inside the run until
   * `POST /v1/runs/{id}/approval` (contracts.md §6, harness D5b–d), which gives
   * a genuinely live, non-terminal Meri run (`waiting_for_approval`) that the
   * worker-facing broker probes below can be issued against — with the same
   * worker token and the same `x-meri-hermes-run-id` binding the worker's own
   * plugin uses. The browser stream is deliberately not awaited (a detached
   * run is the documented behaviour), and is aborted in afterAll.
   */
  async function startLiveRun(userId: string, conversationId: string, prompt: string): Promise<LiveRun> {
    const abort = new AbortController();
    openStreams.push(abort);
    void fetch(`${apiBase}/api/clio/conversations/${conversationId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerFor(userId)}`, accept: 'text/event-stream' },
      body: JSON.stringify({ body: prompt }),
      signal: abort.signal,
    }).catch(() => undefined);

    const deadline = Date.now() + 180_000;
    let last: Record<string, unknown> | null = null;
    for (;;) {
      const active = await api('GET', `/api/clio/hermes/conversations/${conversationId}/active`, { as: userId });
      const body = active.json as {
        run?: { runId: string; status: string; hermesRunId: string | null } | null;
        pendingInteractions?: Array<{ requestId: string; kind: string }>;
      } | null;
      last = body as Record<string, unknown> | null;
      const run = body?.run ?? null;
      const approval = (body?.pendingInteractions ?? []).find((i) => i.kind === 'approval');
      if (run?.hermesRunId && (approval || run.status === 'waiting_for_approval')) {
        return { runId: run.runId, hermesRunId: run.hermesRunId, approvalRequestId: approval?.requestId ?? null, status: run.status };
      }
      if (run && TERMINAL.includes(run.status)) {
        throw new Error(
          `live run for ${conversationId} reached ${run.status} without parking at an approval gate; ` +
            `HERMES_EXEC_ASK may be off on the worker. last=${JSON.stringify(last).slice(0, 600)}`,
        );
      }
      if (Date.now() > deadline) {
        const rows = await prisma.withSystem((tx) =>
          tx.$queryRaw<Array<{ id: string; status: string; finish_reason: string | null; error: string | null }>>`
            SELECT id::text AS id, status, finish_reason, error FROM meri_agent_runs
            WHERE conversation_id = ${conversationId}::uuid ORDER BY created_at DESC LIMIT 5`,
        );
        throw new Error(
          `live run for ${conversationId} never parked at an approval gate. active=${JSON.stringify(last)} ` +
            `runs=${JSON.stringify(rows)}`.slice(0, 1200),
        );
      }
      await sleep(1_000);
    }
  }

  const TERMINAL = ['completed', 'cancelled', 'failed', 'interrupted', 'expired'];

  /**
   * A parked run is released by Hermes's own `approvals.timeout` (300 s on the
   * pinned build), so a long section can outlive it. Re-park in a spare
   * conversation rather than failing on a timing artefact.
   */
  async function ensureLive(userId: string, current: LiveRun, spareConversationId: string): Promise<LiveRun> {
    const projection = await runProjection(userId, current.runId);
    if (!TERMINAL.includes(String(projection.status))) return current;
    return startLiveRun(userId, spareConversationId, PARK_PROMPT);
  }

  async function runProjection(userId: string, runId: string): Promise<Record<string, unknown>> {
    const response = await api('GET', `/api/clio/hermes/runs/${runId}`, { as: userId });
    return (response.json ?? {}) as Record<string, unknown>;
  }

  /** Durable event log for a run, read straight out of Postgres (no projection). */
  async function runEvents(runId: string): Promise<Array<{ kind: string; payload: Record<string, unknown> }>> {
    const rows = await prisma.withSystem((tx) =>
      tx.$queryRaw<Array<{ kind: string; payload: Record<string, unknown> }>>`
        SELECT kind, payload_jsonb AS payload FROM meri_agent_run_events WHERE run_id = ${runId}::uuid ORDER BY seq ASC`,
    );
    return rows;
  }

  // =========================================================================
  beforeAll(async () => {
    // -- env: pilot gate open for the fixture tenant only --------------------
    for (const key of [
      'MERI_HERMES_ENABLED',
      'MERI_HERMES_PILOT_TENANT_IDS',
      'MERI_HERMES_RUNTIME_URL',
      'MERI_HERMES_API_KEY',
      'MERI_HERMES_BROKER_SIGNING_KEY',
      'MERI_HERMES_SCOPE_RUNTIMES',
      'MERI_HERMES_MODEL',
      'MERI_HERMES_RUN_MAX_WALL_MS',
      'MERI_COMPLIANCE_BLOCK',
      'MEMORY_GOVERNANCE_LIFECYCLE',
    ]) {
      savedEnv[key] = process.env[key];
    }

    workerGatewayKey = containerEnv(REFERENCE_CONTAINER, 'API_SERVER_KEY');
    const modelKey = containerEnv(REFERENCE_CONTAINER, 'OPENAI_API_KEY');
    const model = containerEnv(REFERENCE_CONTAINER, 'MERI_HERMES_MODEL');
    const provider = containerEnv(REFERENCE_CONTAINER, 'MERI_HERMES_PROVIDER');
    const baseUrl = containerEnv(REFERENCE_CONTAINER, 'MERI_HERMES_BASE_URL');

    process.env.MERI_HERMES_ENABLED = 'true';
    process.env.MERI_HERMES_PILOT_TENANT_IDS = pilotTenantId;
    process.env.MERI_HERMES_RUNTIME_URL = `http://127.0.0.1:${WORKER_PORT}`;
    process.env.MERI_HERMES_API_KEY = workerGatewayKey;
    process.env.MERI_HERMES_BROKER_SIGNING_KEY = brokerSigningKey;
    process.env.MERI_HERMES_MODEL = model;
    process.env.MERI_HERMES_RUN_MAX_WALL_MS = '1800000';
    process.env.MERI_COMPLIANCE_BLOCK = 'false';
    // Default configuration for the suite is the DARK memory-governance
    // lifecycle (production default today). The enforce-mode case sets it
    // explicitly in its own test and restores it.
    delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;

    // -- fixtures -------------------------------------------------------------
    const { PrismaService } = await import('../../prisma/prisma.service.js');
    const { MERI_HERMES_RUNTIME_FLAG } = await import('../../common/meri-hermes-flags.js');
    const seedPrisma = new PrismaService();
    await seedPrisma.$connect();
    await seedPrisma.withSystem(async (tx) => {
      await tx.tenant.create({
        data: {
          id: pilotTenantId,
          slug: `meri-hermes-closeout-${pilotTenantId}`,
          name: 'Meri Hermes closeout — pilot fixture',
          status: 'active',
          settings: { clioFeatureFlags: { [MERI_HERMES_RUNTIME_FLAG]: true } },
        },
      });
      await tx.tenant.create({
        data: {
          id: outsideTenantId,
          slug: `meri-hermes-closeout-outside-${outsideTenantId}`,
          name: 'Meri Hermes closeout — outside tenant fixture',
          status: 'active',
          // Even with its own flag true it is not on the canonical allowlist.
          settings: { clioFeatureFlags: { [MERI_HERMES_RUNTIME_FLAG]: true } },
        },
      });
      for (const [id, tenantId] of [
        [aliceId, pilotTenantId],
        [bobId, pilotTenantId],
        [carolId, outsideTenantId],
      ] as const) {
        await tx.user.create({ data: { id, clerkUserId: id, email: `${id}@meri-hermes-closeout.example.test` } });
        await tx.tenantMembership.create({
          data: { tenantId, userId: id, role: 'standard_user', status: 'active', joinedAt: new Date() },
        });
      }
      await tx.client.create({
        data: { id: openClientId, tenantId: pilotTenantId, name: 'Closeout open client', memoryWall: false },
      });
      await tx.client.create({
        data: { id: walledClientId, tenantId: pilotTenantId, name: 'Closeout walled client', memoryWall: true },
      });
      // Only Alice holds the ethical-wall grant for the walled client.
      await tx.clientMemoryAccess.create({
        data: { tenantId: pilotTenantId, clientId: walledClientId, userId: aliceId },
      });
      for (const [id, tenantId, userId, title] of [
        [convAliceId, pilotTenantId, aliceId, 'Closeout Alice conversation'],
        [convAlice2Id, pilotTenantId, aliceId, 'Closeout Alice conversation 2'],
        [convAlice3Id, pilotTenantId, aliceId, 'Closeout Alice conversation 3'],
        [convAlice4Id, pilotTenantId, aliceId, 'Closeout Alice conversation 4'],
        [convBobId, pilotTenantId, bobId, 'Closeout Bob conversation'],
        [convBob2Id, pilotTenantId, bobId, 'Closeout Bob conversation 2'],
      ] as const) {
        await tx.clioConversation.create({ data: { id, tenantId, userId, title } });
      }

      /**
       * Governed fixtures. The schema DEFAULTS for `memory_class` /
       * `governed_status` are the quarantine pair ('legacy_unclassified',
       * 'pending_review'), which the REAL production predicate
       * (governedRecallEligibilitySql + filterGovernedMemory) deliberately
       * excludes; `institutional_authoritative` additionally requires a real
       * source_type and an approver. A fixture missing any of those is silently
       * invisible — which is exactly how a weaker fixture can make an isolation
       * test pass for the wrong reason.
       */
      const insertGoverned = (
        id: string,
        opts: {
          visibility: string;
          ownerUserId?: string | null;
          clientId?: string | null;
          memoryScope: string;
          authority: string;
          slug: string;
          title: string;
          body: string;
        },
      ) => {
        const sections = JSON.stringify([
          { key: 'summary', heading: 'Summary', owner: 'human', body: opts.body },
        ]);
        return tx.$executeRaw`
          INSERT INTO memory_items (
            id, tenant_id, client_id, owner_user_id, type, visibility, slug, title,
            source, provenance, sections_jsonb, status,
            memory_class, memory_authority, governed_status, memory_scope,
            source_type, source_ref, approved_by_user_id, approved_at
          ) VALUES (
            ${id}::uuid, ${pilotTenantId}::uuid, ${opts.clientId ?? null}::uuid, ${opts.ownerUserId ?? null}::uuid,
            'note', ${opts.visibility}, ${opts.slug}, ${opts.title},
            'manual', 'human', ${sections}::jsonb, 'active',
            'institutional_authoritative', ${opts.authority}, 'active', ${opts.memoryScope},
            'manual', ${'closeout-fixture:' + id}, ${aliceId}::uuid, now()
          )`;
      };
      await insertGoverned(firmFactId, {
        visibility: 'tenant',
        memoryScope: 'firm',
        authority: 'firm_approved',
        slug: `closeout-firm-${firmFactId}`,
        title: `Firm diligence checklist ${FIRM_MARKER}`,
        body: `Firm diligence checklist. ${FIRM_MARKER}. Always confirm the filing deadline with the client lead.`,
      });
      await insertGoverned(aliceFactId, {
        visibility: 'user',
        ownerUserId: aliceId,
        memoryScope: 'user_private',
        authority: 'user_asserted',
        slug: `closeout-alice-${aliceFactId}`,
        title: `Alice private note ${ALICE_MARKER}`,
        body: `Alice's private note. ${ALICE_MARKER}. Nobody else may ever read this.`,
      });
      await insertGoverned(bobFactId, {
        visibility: 'user',
        ownerUserId: bobId,
        memoryScope: 'user_private',
        authority: 'user_asserted',
        slug: `closeout-bob-${bobFactId}`,
        title: `Bob private note ${BOB_MARKER}`,
        body: `Bob's private note. ${BOB_MARKER}. Nobody else may ever read this.`,
      });
      await insertGoverned(walledFactId, {
        visibility: 'tenant',
        clientId: walledClientId,
        memoryScope: 'client',
        authority: 'firm_approved',
        slug: `closeout-walled-${walledFactId}`,
        title: `Walled client strategy ${WALLED_MARKER}`,
        body: `Walled client strategy. ${WALLED_MARKER}. Restricted to users granted access to this client.`,
      });

      /**
       * QUARANTINE control. Identical to the firm fact except that it carries
       * the SCHEMA DEFAULT governance columns ('legacy_unclassified' /
       * 'pending_review', source_type 'unknown', no approver). The production
       * recall predicate must exclude it in BOTH lifecycle modes — that is the
       * point of `governedRecallEligibilitySql`, which is applied
       * unconditionally, unlike the lifecycle-gated
       * `governedRecallSuppressionSql`.
       */
      const quarantineSections = JSON.stringify([
        {
          key: 'summary',
          heading: 'Summary',
          owner: 'human',
          body: `Unreviewed draft. ${QUARANTINE_MARKER}. Must never be recalled while pending review.`,
        },
      ]);
      await tx.$executeRaw`
        INSERT INTO memory_items (id, tenant_id, type, visibility, slug, title, source, provenance, sections_jsonb, status)
        VALUES (${quarantinedFactId}::uuid, ${pilotTenantId}::uuid, 'note', 'tenant',
                ${'closeout-quarantined-' + quarantinedFactId}, ${'Unreviewed draft ' + QUARANTINE_MARKER},
                'manual', 'human', ${quarantineSections}::jsonb, 'active')`;

      /**
       * OUTSIDE-TENANT control: a fully governed, fully eligible institutional
       * fact that belongs to the other tenant. The pilot tenant's recall must
       * never return it, which is what makes the tenant-isolation assertion
       * non-vacuous.
       */
      const outsideSections = JSON.stringify([
        { key: 'summary', heading: 'Summary', owner: 'human', body: `Outside tenant fact. ${OUTSIDE_MARKER}. Never visible to the pilot tenant.` },
      ]);
      await tx.$executeRaw`
        INSERT INTO memory_items (
          id, tenant_id, type, visibility, slug, title, source, provenance, sections_jsonb, status,
          memory_class, memory_authority, governed_status, memory_scope, source_type, approved_by_user_id, approved_at
        ) VALUES (
          ${outsideFactId}::uuid, ${outsideTenantId}::uuid, 'note', 'tenant',
          ${'closeout-outside-' + outsideFactId}, ${'Outside tenant fact ' + OUTSIDE_MARKER},
          'manual', 'human', ${outsideSections}::jsonb, 'active',
          'institutional_authoritative', 'firm_approved', 'active', 'firm', 'manual', ${carolId}::uuid, now()
        )`;
    }, { timeoutMs: FIXTURE_TX_TIMEOUT_MS });
    await seedPrisma.$disconnect();

    // -- boot the real application graph as a real HTTP server ----------------
    const { Test } = await import('@nestjs/testing');
    const { Module, RequestMethod } = await import('@nestjs/common');
    const { ConfigModule } = await import('@nestjs/config');
    const { validateConfig } = await import('../../config/config.schema.js');
    const { PrismaModule } = await import('../../prisma/prisma.module.js');
    const { AuthModule } = await import('../../auth/auth.module.js');
    const { TenantModule } = await import('../../tenant/tenant.module.js');
    const { TenantContextMiddleware } = await import('../../tenant/tenant-context.middleware.js');
    const { MeriModule } = await import('../meri.module.js');
    // AppModule-level globals that MeriModule's subgraph depends on.
    const { TangoModule } = await import('../../external/tango/tango.module.js');
    const { ClerkService } = await import('../../auth/clerk.service.js');
    const { configureApiHttpApp } = await import('../../bootstrap/configure-api-http-app.js');

    /**
     * The ONLY authentication substitution: Clerk's JWKS signature check. The
     * verifier is per-token and deterministic; a token minted for one user can
     * never resolve to another. Everything downstream (user row lookup,
     * membership scan, tenant resolution, org/slug cross-checks, ALS) is the
     * real `TenantContextMiddleware`.
     */
    const clerkStub = {
      verifySessionToken: async (token: string) => {
        const match = /^closeout-session:([0-9a-f-]{36})$/.exec(token);
        if (!match) throw new Error('invalid session token');
        return { sub: match[1]!, iss: 'https://closeout.test', email: `${match[1]}@meri-hermes-closeout.example.test` };
      },
      get backend() {
        throw new Error('Clerk backend API is not available in this spec');
      },
    };

    /**
     * The application graph under test.
     *
     * This is `AppModule`'s real infrastructure spine — the same
     * `ConfigModule.forRoot` with the same zod validation, the real
     * `PrismaModule`, the real (global) `AuthModule` and `TenantModule` — plus
     * the real `MeriModule`, which transitively pulls in the real
     * Context/Retrieval/Memory/Embeddings/Clients/Engagement/Intelligence
     * subgraph, the real Meri + Meri-Hermes controllers, the real broker, the
     * real durable Prisma run repository and the production
     * `MERI_HERMES_RECALL_PORT` → `ContextPlaneRecallPort` binding. The real
     * `TenantContextMiddleware` is applied with AppModule's own exclusion list
     * (notably `/api/internal/*`, which is how the broker routes are reached
     * with a worker token instead of a browser session).
     *
     * `AppModule` ITSELF also boots and passes here — verified during
     * development — but importing it costs more than jest's default
     * ~4.3 GB old-space limit under `--runInBand`, so the mandated gate command
     * (`npx jest --forceExit --runInBand src/meri/hermes`) dies with
     * "JavaScript heap out of memory" before any assertion runs. Reproduce the
     * whole-AppModule variant with
     * `NODE_OPTIONS=--max-old-space-size=12288` and `imports: [AppModule]`.
     * The modules this graph leaves out (users, webhooks, billing, workspace,
     * explorer, admin, engagement-workers, …) contribute no provider on the
     * Meri ⇄ Hermes path; MeriModule declares both Hermes controllers itself.
     */
    class CloseoutApplicationModule {
      configure(consumer: import('@nestjs/common').MiddlewareConsumer): void {
        consumer
          .apply(TenantContextMiddleware)
          .exclude(
            { path: 'health', method: RequestMethod.ALL },
            { path: 'webhooks/(.*)', method: RequestMethod.ALL },
            { path: '/api/internal/(.*)', method: RequestMethod.ALL },
            { path: 'api/internal/(.*)', method: RequestMethod.ALL },
          )
          .forRoutes('*');
      }
    }
    Module({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          validate: (raw) => validateConfig(raw as Record<string, unknown>),
        }),
        TangoModule,
        PrismaModule,
        AuthModule,
        TenantModule,
        MeriModule,
      ],
    })(CloseoutApplicationModule);

    const moduleRef = await Test.createTestingModule({ imports: [CloseoutApplicationModule] })
      .overrideProvider(ClerkService)
      .useValue(clerkStub)
      .compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApiHttpApp(app, {
      includeClerkRawBody: false,
      includeRecallRawBody: false,
      includeTangoRawBody: false,
      includeEmailSignatureLargeBody: false,
      defaultJsonLimit: '10mb',
    });
    await app.init();
    await app.listen(0, '0.0.0.0');
    apiPort = (app.getHttpServer().address() as AddressInfo).port;
    apiBase = `http://127.0.0.1:${apiPort}`;

    // -- resolve REAL collaborators out of the booted graph -------------------
    const { PrismaService: PrismaClass } = await import('../../prisma/prisma.service.js');
    const { MeriHermesBrokerService } = await import('./meri-hermes-broker.service.js');
    const { MERI_HERMES_RUN_REPOSITORY } = await import('./meri-hermes-run-store.js');
    const { MERI_HERMES_SECURITY_ENVELOPE } = await import('./meri-hermes-security.port.js');
    const workerToken = await import('./meri-hermes-worker-token.js');
    const adapterModule = await import('./meri-hermes-runtime.adapter.js');
    mintToken = workerToken.mintMeriHermesWorkerToken;
    scopeIdFor = workerToken.privateExecutionScopeId;
    computeVersion = adapterModule.computeAuthorizationVersion;
    prisma = app.get(PrismaClass, { strict: false });
    broker = app.get(MeriHermesBrokerService, { strict: false });
    runRepo = app.get(MERI_HERMES_RUN_REPOSITORY, { strict: false });
    const security = app.get<import('./meri-hermes-security.port.js').MeriHermesSecurityEnvelopePort>(
      MERI_HERMES_SECURITY_ENVELOPE,
      { strict: false },
    );
    // Assert the production binding, not a test double: the durable repository
    // and the Context Plane recall port must be the real classes.
    const { MeriHermesPrismaRunRepository } = await import('./meri-hermes-prisma-run-repository.js');
    const { ContextPlaneRecallPort, MERI_HERMES_RECALL_PORT } = await import('./meri-hermes-recall.ports.js');
    expect(runRepo).toBeInstanceOf(MeriHermesPrismaRunRepository);
    expect(app.get(MERI_HERMES_RECALL_PORT, { strict: false })).toBeInstanceOf(ContextPlaneRecallPort);

    aliceCtx = { tenantId: pilotTenantId, tenantSlug: 'closeout', userId: aliceId, clerkUserId: aliceId, role: 'standard_user' };
    bobCtx = { tenantId: pilotTenantId, tenantSlug: 'closeout', userId: bobId, clerkUserId: bobId, role: 'standard_user' };

    // -- mint the worker credential for Alice's scope -------------------------
    //
    // `securityEnvelope()` is the FIRST query this suite issues through the
    // booted app's Prisma client, so it pays the whole cold cost — pool
    // connect, TLS-less handshake, prepared-statement warm-up — inside an
    // interactive transaction whose default budget is 5 000 ms. On a loaded or
    // cold box that is genuinely tight (observed: 5 865 ms, which failed every
    // test in the suite from beforeAll). Warm the pool with a trivial query
    // first, and retry the envelope reads, so a cold start is slow rather than
    // red. Neither changes what is being measured: the envelope is re-read
    // from the real resolver either way.
    await withTransientRetry('prisma warm-up', () => prisma.withSystem((tx) => tx.$queryRaw`SELECT 1`));
    aliceScopeId = scopeIdFor(pilotTenantId, aliceId);
    const aliceEnvelope = await withTransientRetry('alice security envelope', () => security.securityEnvelope(aliceCtx));
    aliceAuthorizationVersion = computeVersion({
      role: 'standard_user',
      authorizedClientIds: aliceEnvelope.authorizedClientIds,
      authorizedMailboxConnectionIds: aliceEnvelope.authorizedMailboxConnectionIds,
    });
    aliceWorkerToken = mintToken(
      {
        executionScopeId: aliceScopeId,
        tenantId: pilotTenantId,
        actorType: 'user',
        actorId: aliceId,
        authorizationVersion: aliceAuthorizationVersion,
        ttlSeconds: 3600,
      },
      brokerSigningKey,
    ).token;

    bobScopeId = scopeIdFor(pilotTenantId, bobId);
    const bobEnvelope = await withTransientRetry('bob security envelope', () => security.securityEnvelope(bobCtx));
    bobAuthorizationVersion = computeVersion({
      role: 'standard_user',
      authorizedClientIds: bobEnvelope.authorizedClientIds,
      authorizedMailboxConnectionIds: bobEnvelope.authorizedMailboxConnectionIds,
    });
    bobWorkerToken = mintToken(
      {
        executionScopeId: bobScopeId,
        tenantId: pilotTenantId,
        actorType: 'user',
        actorId: bobId,
        authorizationVersion: bobAuthorizationVersion,
        ttlSeconds: 3600,
      },
      brokerSigningKey,
    ).token;

    // Real, server-derived ethical-wall envelopes. These must differ, and the
    // authorization versions must differ with them — otherwise every
    // "Bob cannot see the walled fact" assertion below would be vacuous.
    expect(aliceEnvelope.authorizedClientIds).toContain(walledClientId);
    expect(bobEnvelope.authorizedClientIds).not.toContain(walledClientId);
    expect(aliceAuthorizationVersion).not.toBe(bobAuthorizationVersion);

    /**
     * OBSERVATION, not substitution: wrap the real `recall()` so every governed
     * result the broker hands back to a worker is captured verbatim. The real
     * method runs, unchanged, and its own return value is what is returned.
     */
    const realBrokerRecall = broker.recall.bind(broker);
    jest.spyOn(broker, 'recall').mockImplementation(async (auth, input) => {
      const result = await realBrokerRecall(auth, input);
      recallCalls.push({ actorId: auth.run.envelope.actorId, input, result });
      return result;
    });

    const { MeriContextPlaneService } = await import('../meri-context-plane.service.js');
    const { MemoryCandidateService } = await import('../../memory/memory-candidate.service.js');
    contextPlane = app.get(MeriContextPlaneService, { strict: false });
    candidates = app.get(MemoryCandidateService, { strict: false });

    // -- launch a REAL worker bound to THIS api -------------------------------
    dockerRm(WORKER_CONTAINER);
    try {
      sh('docker', ['volume', 'rm', WORKER_VOLUME]);
    } catch {
      /* absent */
    }
    sh('docker', [
      'run',
      '-d',
      '--name',
      WORKER_CONTAINER,
      '-p',
      `${WORKER_PORT}:8642`,
      '-v',
      `${WORKER_VOLUME}:/opt/data`,
      '--cpus',
      '1',
      '--memory',
      '2g',
      '--add-host',
      'host.docker.internal:host-gateway',
      '-e',
      `API_SERVER_KEY=${workerGatewayKey}`,
      '-e',
      `MERI_BROKER_URL=http://host.docker.internal:${apiPort}/api/internal/hermes/broker`,
      '-e',
      `MERI_WORKER_TOKEN=${aliceWorkerToken}`,
      '-e',
      `MERI_EXECUTION_SCOPE_ID=${aliceScopeId}`,
      '-e',
      `OPENAI_API_KEY=${modelKey}`,
      '-e',
      `MERI_HERMES_MODEL=${model}`,
      '-e',
      `MERI_HERMES_PROVIDER=${provider}`,
      '-e',
      `MERI_HERMES_BASE_URL=${baseUrl}`,
      '-e',
      // This suite deliberately keeps several runs PARKED at an approval gate
      // at the same time (one per section, plus the spares `refreshLive()`
      // re-parks into). The Phase 0 harness value of 4 is below that, and the
      // worker then refuses admission with "Too many concurrent runs (max 4)",
      // which surfaces as an unrelated-looking `interrupted` run several
      // sections later. The pilot envelope's own limits are enforced by MERI,
      // not by this number.
      'MERI_MAX_CONCURRENT_RUNS=16',
      '-e',
      'HERMES_EXEC_ASK=1',
      WORKER_IMAGE,
    ]);
    const deadline = Date.now() + 240_000;
    for (;;) {
      try {
        const health = await fetch(`http://127.0.0.1:${WORKER_PORT}/health`, {
          headers: { authorization: `Bearer ${workerGatewayKey}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (health.ok) break;
      } catch {
        /* booting */
      }
      if (Date.now() > deadline) throw new Error(`worker ${WORKER_CONTAINER} did not become healthy`);
      await sleep(1_000);
    }

    // The scope→runtime map is the documented local override the client honours
    // (MERI_HERMES_SCOPE_RUNTIMES); it selects the worker for Alice's scope
    // exactly as the Phase 1 lifecycle resolver would in a deployed environment.
    process.env.MERI_HERMES_SCOPE_RUNTIMES = JSON.stringify({
      [aliceScopeId]: { url: `http://127.0.0.1:${WORKER_PORT}`, apiKey: workerGatewayKey },
      [scopeIdFor(pilotTenantId, bobId)]: { url: `http://127.0.0.1:${WORKER_PORT}`, apiKey: workerGatewayKey },
    });
  });

  afterAll(async () => {
    for (const abort of openStreams) {
      try {
        abort.abort();
      } catch {
        /* already gone */
      }
    }
    try {
      dockerRm(WORKER_CONTAINER);
      try {
        sh('docker', ['volume', 'rm', WORKER_VOLUME]);
      } catch {
        /* absent */
      }
    } catch {
      /* best effort */
    }
    if (app) {
      await app.close().catch(() => undefined);
    }
    const { PrismaService } = await import('../../prisma/prisma.service.js');
    const cleanup = new PrismaService();
    await cleanup.$connect();
    await cleanup
      .withSystem(async (tx) => {
        await tx.$executeRaw`DELETE FROM memory_items WHERE tenant_id = ${pilotTenantId}::uuid`;
        await tx.tenant.delete({ where: { id: pilotTenantId } }).catch(() => undefined);
        await tx.tenant.delete({ where: { id: outsideTenantId } }).catch(() => undefined);
        for (const id of [aliceId, bobId, carolId]) {
          await tx.user.delete({ where: { id } }).catch(() => undefined);
        }
      }, { timeoutMs: FIXTURE_TX_TIMEOUT_MS })
      .catch(() => undefined);
    await cleanup.$disconnect();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.MERI_HERMES_SCOPE_RUNTIMES;
  });

  // =========================================================================
  // Boot / boundary sanity — these are the claims the rest of the file rests on
  // =========================================================================
  describe('the application graph that is actually under test', () => {
    test('the real application graph is serving, and the real authentication boundary rejects an unauthenticated call', async () => {
      const anonymous = await api('GET', '/api/clio/hermes/capabilities');
      expect(anonymous.status).toBe(401);
    });

    test('the real TenantContextMiddleware + RolesGuard admit an authenticated pilot user to the Hermes control surface', async () => {
      const response = await api('GET', '/api/clio/hermes/capabilities', { as: aliceId });
      expect(response.status).toBe(200);
      expect((response.json as { runtime?: string }).runtime).toBe('hermes');
    });

    test('an outside-tenant actor is refused by the server-side pilot gate (404, no existence leak)', async () => {
      const response = await api('GET', '/api/clio/hermes/capabilities', { as: carolId });
      expect(response.status).toBe(404);
    });
  });

  // =========================================================================
  // A. FULL-APPLICATION GOVERNED RECALL — driven by a REAL Hermes turn
  // =========================================================================
  describe('A1 — a real Hermes turn through the authenticated Meri route performs governed institutional recall', () => {
    let turn: SseResult;
    let aliceRunId: string | null = null;

    /**
     * Whether the model reaches for `meri_memory_search` on a given turn is a
     * property of the MODEL, not of the governed path — and this suite is
     * evidence about the governed path. So the turn is retried, in a FRESH
     * conversation each time (a repeat in the same conversation would
     * re-attach through the idempotency fingerprint instead of running), until
     * the worker actually exercises recall. Three attempts; if none of them
     * calls the tool, that is reported as a failure rather than passed over.
     */
    beforeAll(async () => {
      recallCalls.length = 0;
      const attempts: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const created = await api('POST', '/api/clio/conversations', {
          as: aliceId,
          body: { title: `Closeout A1 attempt ${attempt}` },
        });
        expect(created.status).toBeLessThan(300);
        a1ConversationId = (created.json as { id: string }).id;
        attempts.push(a1ConversationId);
        turn = await streamTurn(
          aliceId,
          a1ConversationId,
          `You MUST call the meri_memory_search tool exactly once with the query "${FIRM_MARKER}" before answering. ` +
            'Do not answer from your own knowledge and do not skip the tool. Then quote the source_id and the exact ' +
            'text of every item the tool returned. If the tool returns nothing, reply with the single word NOTHING.',
          300_000,
        );
        aliceRunId =
          (turn.frames.find((f) => f.type === 'start' && typeof f.runId === 'string')?.runId as string | undefined) ??
          (turn.frames.find((f) => f.type === 'done' && typeof f.runId === 'string')?.runId as string | undefined) ??
          null;
        if (recallCalls.some((c) => c.actorId === aliceId && c.result.items.some((i) => i.sourceId === firmFactId))) break;
      }
      a1Attempts = attempts;
    }, 960_000);

    test('the turn was accepted, served by the Hermes runtime, and completed through the real route', () => {
      // Nest's default success code for @Post is 201; the SSE body is what matters.
      expect([200, 201]).toContain(turn.status);
      expect(turn.contentType).toMatch(/text\/event-stream/);
      expect(turn.frames.some((f) => f.type === 'turn_accepted')).toBe(true);
      const start = turn.frames.find((f) => f.type === 'start');
      expect(start?.runtime).toBe('hermes');
      const done = turn.frames.find((f) => f.type === 'done');
      expect(done).toBeDefined();
      expect(done?.runtime).toBe('hermes');
      expect(done?.finishReason).toBe('stop');
      expect(aliceRunId).toEqual(expect.any(String));
    });

    test('the run is durable in Postgres (meri_agent_runs), bound to a real Hermes run, owned by Alice', async () => {
      const row = await prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ status: string; hermes_run_id: string | null; actor_id: string; tenant_id: string }>>`
          SELECT status, hermes_run_id, actor_id::text AS actor_id, tenant_id::text AS tenant_id
          FROM meri_agent_runs WHERE id = ${aliceRunId}::uuid`,
      );
      expect(row).toHaveLength(1);
      expect(row[0]!.status).toBe('completed');
      expect(row[0]!.hermes_run_id).toEqual(expect.stringMatching(/^run_/));
      expect(row[0]!.actor_id).toBe(aliceId);
      expect(row[0]!.tenant_id).toBe(pilotTenantId);
    });

    test('ASSERTION 1 — permitted institutional-memory retrieval returned the fixture fact with a real sourceId, provenance and coverage, via path=context_plane', () => {
      // Every recall on this run came from the REAL worker: either the memory
      // provider's automatic `prefetch` or its `meri_memory_search` tool, both
      // over the broker HTTP route with the scope-bound worker token.
      const aliceRecalls = recallCalls.filter((c) => c.actorId === aliceId);
      if (aliceRecalls.length === 0) {
        throw new Error(
          `the real worker never called the governed recall path across ${a1Attempts.length} turn(s) ` +
            `(conversations ${a1Attempts.join(', ')}); the turn itself completed, so this is the model declining ` +
            'the tool rather than a governed-path failure — re-run, and if it persists strengthen the prompt.',
        );
      }
      expect(aliceRecalls.length).toBeGreaterThan(0);
      const hit = aliceRecalls.find((c) => c.result.items.some((i) => i.sourceId === firmFactId));
      expect(hit).toBeDefined();
      expect(hit!.result.path).toBe('context_plane');
      const item = hit!.result.items.find((i) => i.sourceId === firmFactId)!;
      expect(item.sourceId).toBe(firmFactId);
      expect(item.excerpt).toContain(FIRM_MARKER);
      expect(item.provenance).toMatchObject({ source: 'memory_items', recordId: firmFactId, sourceType: 'manual' });
      expect(hit!.result.coverage.returned).toBeGreaterThan(0);
      expect(hit!.result.coverage.sourceStatus).toBe('healthy');
      expect(typeof hit!.result.coverage.complete).toBe('boolean');
    });

    test('the durable event log records the governed recall with path=context_plane (never the prototype port)', async () => {
      const events = await runEvents(aliceRunId!);
      const recalls = events.filter((e) => e.kind === 'memory.recalled');
      expect(recalls.length).toBeGreaterThan(0);
      for (const event of recalls) {
        expect(event.payload.path).toBe('context_plane');
        expect(event.payload.path).not.toBe('direct_memory_items_prototype');
      }
    });

    test('the assistant message was persisted by the real adapter with runtime=hermes', async () => {
      const rows = await prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ metadata: Record<string, unknown> }>>`
          SELECT metadata_jsonb AS metadata FROM clio_messages
          WHERE conversation_id = ${a1ConversationId}::uuid AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.metadata.runtime).toBe('hermes');
      expect(rows[0]!.metadata.meriRunId).toBe(aliceRunId);
    });
  });

  // =========================================================================
  // A2–A7, C and D — probes issued against LIVE runs created by real
  // authenticated turns, over the real worker-facing broker HTTP route.
  // =========================================================================
  describe('worker-facing probes against LIVE runs created by real authenticated turns', () => {
    let aliceLive: LiveRun;
    let bobLive: LiveRun;

    beforeAll(async () => {
      aliceLive = await startLiveRun(aliceId, convAlice2Id, PARK_PROMPT);
      bobLive = await startLiveRun(bobId, convBobId, PARK_PROMPT);
    }, 420_000);

    const refreshLive = async () => {
      aliceLive = await ensureLive(aliceId, aliceLive, convAlice4Id);
      bobLive = await ensureLive(bobId, bobLive, convBob2Id);
    };

    /**
     * Release every run this section parked. A parked run holds a slot in the
     * worker's concurrency budget until Hermes's own approvals timeout (300 s)
     * expires it, and section B parks another one immediately after — without
     * this, B's admission can be refused with "Too many concurrent runs" and
     * surface as an unrelated `interrupted` run.
     */
    afterAll(async () => {
      for (const [userId, runId] of [
        [aliceId, aliceLive?.runId],
        [bobId, bobLive?.runId],
      ] as const) {
        if (!runId) continue;
        await api('POST', `/api/clio/hermes/runs/${runId}/stop`, { as: userId }).catch(() => undefined);
      }
    });

    const recall = (token: string, hermesRunId: string, query: string, clientId?: string) =>
      brokerCall('POST', '/memory/recall', {
        token,
        hermesRunId,
        body: { query, limit: 50, ...(clientId ? { clientId } : {}) },
      });

    type RecallBody = {
      path?: string;
      items?: Array<{ sourceId: string; excerpt: string; title: string }>;
      coverage?: Record<string, unknown>;
    };

    test('baseline — both live runs are genuinely live, owned by the right actors, and reachable with their own worker tokens', async () => {
      expect(aliceLive.hermesRunId).toEqual(expect.stringMatching(/^run_/));
      expect(bobLive.hermesRunId).toEqual(expect.stringMatching(/^run_/));
      const aliceWho = await brokerCall('GET', '/whoami', { token: aliceWorkerToken, hermesRunId: aliceLive.hermesRunId });
      expect(aliceWho.status).toBe(200);
      expect(aliceWho.json).toMatchObject({ tenantId: pilotTenantId, actorId: aliceId, executionScopeId: aliceScopeId });
      const bobWho = await brokerCall('GET', '/whoami', { token: bobWorkerToken, hermesRunId: bobLive.hermesRunId });
      expect(bobWho.status).toBe(200);
      expect(bobWho.json).toMatchObject({ tenantId: pilotTenantId, actorId: bobId, executionScopeId: bobScopeId });
    });

    test('ASSERTION 2 — personal ownership: another user\'s private fact is never returned, in either direction', async () => {
      const aliceLooksForBob = await recall(aliceWorkerToken, aliceLive.hermesRunId, BOB_MARKER);
      expect(aliceLooksForBob.status).toBeLessThan(300);
      const a = aliceLooksForBob.json as RecallBody;
      expect(a.path).toBe('context_plane');
      expect(a.items!.some((i) => i.sourceId === bobFactId)).toBe(false);
      expect(JSON.stringify(a.items)).not.toContain(BOB_MARKER);

      const bobLooksForAlice = await recall(bobWorkerToken, bobLive.hermesRunId, ALICE_MARKER);
      expect(bobLooksForAlice.status).toBeLessThan(300);
      const b = bobLooksForAlice.json as RecallBody;
      expect(b.path).toBe('context_plane');
      expect(b.items!.some((i) => i.sourceId === aliceFactId)).toBe(false);
      expect(JSON.stringify(b.items)).not.toContain(ALICE_MARKER);

      // Positive controls: the exclusions above are ownership, not a query miss.
      const aliceOwn = (await recall(aliceWorkerToken, aliceLive.hermesRunId, ALICE_MARKER)).json as RecallBody;
      expect(aliceOwn.items!.some((i) => i.sourceId === aliceFactId)).toBe(true);
      const bobOwn = (await recall(bobWorkerToken, bobLive.hermesRunId, BOB_MARKER)).json as RecallBody;
      expect(bobOwn.items!.some((i) => i.sourceId === bobFactId)).toBe(true);
    });

    test('ASSERTION 3 — tenant isolation: an outside-tenant actor gets nothing, at the browser routes AND at the broker', async () => {
      // (a) browser control surface: every Hermes route refuses the outside identity.
      for (const path of [
        '/api/clio/hermes/capabilities',
        `/api/clio/hermes/runs/${aliceLive.runId}`,
        `/api/clio/hermes/conversations/${convAliceId}/active`,
      ]) {
        const response = await api('GET', path, { as: carolId });
        expect(response.status).toBe(404);
      }

      // (b) broker: a validly SIGNED worker token for the outside tenant's scope,
      //     presented with a real live Hermes run id, is refused as a scope
      //     mismatch — signature validity is never authorization.
      const carolToken = mintToken(
        {
          executionScopeId: scopeIdFor(outsideTenantId, carolId),
          tenantId: outsideTenantId,
          actorType: 'user',
          actorId: carolId,
          authorizationVersion: aliceAuthorizationVersion,
          ttlSeconds: 600,
        },
        brokerSigningKey,
      ).token;
      const spoofed = await recall(carolToken, aliceLive.hermesRunId, FIRM_MARKER);
      expect(spoofed.status).toBe(403);
      expect((spoofed.json as { code?: string; message?: { code?: string } }).code ?? (spoofed.json as { message?: { code?: string } }).message?.code).toBe(
        'scope_mismatch',
      );

      // (c) data plane: the pilot tenant's governed recall never crosses into
      //     the outside tenant's institutional memory.
      const inside = (await recall(aliceWorkerToken, aliceLive.hermesRunId, OUTSIDE_MARKER)).json as RecallBody;
      expect(inside.items!.some((i) => i.sourceId === outsideFactId)).toBe(false);
      expect(JSON.stringify(inside.items)).not.toContain(OUTSIDE_MARKER);
    });

    test('ASSERTION 4 — restricted client: a walled client\'s PRIVATE material is denied to a non-granted user and fails closed on an explicit request', async () => {
      // POSITIVE CONTROL: the granted user, asking explicitly for that client,
      // does receive the walled client's private fact — so the exclusions
      // below are the ethical wall, not an unreachable fixture.
      const explicitGranted = await recall(aliceWorkerToken, aliceLive.hermesRunId, WALLED_MARKER, walledClientId);
      expect(explicitGranted.status).toBeLessThan(300);
      const granted = explicitGranted.json as RecallBody;
      expect(granted.path).toBe('context_plane');
      expect(granted.items!.some((i) => i.sourceId === walledFactId)).toBe(true);
      expect(JSON.stringify(granted.items)).toContain(WALLED_MARKER);

      // The non-granted user making the SAME explicit request fails CLOSED with
      // a refusal (`MeriContextPlaneService.searchToolData` → "Client not
      // found"), not an empty-looking success that reads as "nothing found".
      const explicitDenied = await recall(bobWorkerToken, bobLive.hermesRunId, WALLED_MARKER, walledClientId);
      expect(explicitDenied.status).toBe(404);
      expect(JSON.stringify(explicitDenied.json)).not.toContain(WALLED_MARKER);

      // A general (non-client-scoped) search never leaks it to the non-granted
      // user either.
      const denied = (await recall(bobWorkerToken, bobLive.hermesRunId, WALLED_MARKER)).json as RecallBody;
      expect(denied.items!.some((i) => i.sourceId === walledFactId)).toBe(false);
      expect(JSON.stringify(denied.items)).not.toContain(WALLED_MARKER);

      // Documented behaviour worth pinning: a GENERAL search returns no
      // client-scoped memory at all, even to the granted user — the governed
      // SQL restricts `client_id` to the explicitly requested (and
      // wall-checked) client set, which is empty for subjectScope 'general'.
      // Client material is therefore reachable only through an explicit,
      // authorized client scope.
      const generalForGranted = (await recall(aliceWorkerToken, aliceLive.hermesRunId, WALLED_MARKER)).json as RecallBody;
      expect(generalForGranted.items!.some((i) => i.sourceId === walledFactId)).toBe(false);
    });

    test('ASSERTION 5 — both MEMORY_GOVERNANCE_LIFECYCLE modes: authorization applies in both, and each mode\'s documented lifecycle semantics hold', async () => {
      const { governedRecallSuppressionEnabled } = await import('../../memory/memory-recall-suppression.helpers.js');

      const probe = async (label: string) => {
        const mine = (await recall(aliceWorkerToken, aliceLive.hermesRunId, FIRM_MARKER)).json as RecallBody;
        const others = (await recall(bobWorkerToken, bobLive.hermesRunId, `${ALICE_MARKER} ${WALLED_MARKER}`)).json as RecallBody;
        const walled = await recall(bobWorkerToken, bobLive.hermesRunId, WALLED_MARKER, walledClientId);
        const grantedWalled = await recall(aliceWorkerToken, aliceLive.hermesRunId, WALLED_MARKER, walledClientId);
        const quarantine = (await recall(aliceWorkerToken, aliceLive.hermesRunId, QUARANTINE_MARKER)).json as RecallBody;
        return { label, mine, others, quarantine, walled, grantedWalled };
      };

      // DARK (the production default today): the lifecycle SUPPRESSION switch
      // is off, so `governedRecallSuppressionSql` emits nothing and the legacy
      // clio projection is not narrowed.
      delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
      expect(governedRecallSuppressionEnabled()).toBe(false);
      const dark = await probe('dark');

      // ENFORCE: the same switch is on.
      process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
      expect(governedRecallSuppressionEnabled()).toBe(true);
      const enforce = await probe('enforce');

      for (const run of [dark, enforce]) {
        // Authorization is identical in both modes.
        expect(run.mine.path).toBe('context_plane');
        expect(run.mine.items!.some((i) => i.sourceId === firmFactId)).toBe(true);
        expect(run.others.items!.some((i) => i.sourceId === aliceFactId)).toBe(false);
        expect(run.others.items!.some((i) => i.sourceId === walledFactId)).toBe(false);
        // The ethical wall holds in both modes, on the explicit client path…
        expect(run.walled.status).toBe(404);
        expect(JSON.stringify(run.walled.json)).not.toContain(WALLED_MARKER);
        // …and the granted user still gets her client's material in both.
        expect(run.grantedWalled.status).toBeLessThan(300);
        expect((run.grantedWalled.json as RecallBody).items!.some((i) => i.sourceId === walledFactId)).toBe(true);
        // …and so is governed ELIGIBILITY: the institutional rail applies
        // `governedRecallEligibilitySql` + `filterGovernedMemory`
        // UNCONDITIONALLY, so a row left in the schema-default quarantine
        // state ('legacy_unclassified' / 'pending_review', no approver) is
        // invisible in BOTH modes. Governance on this rail is not "dark".
        expect(run.quarantine.items!.some((i) => i.sourceId === quarantinedFactId)).toBe(false);
        expect(JSON.stringify(run.quarantine.items)).not.toContain(QUARANTINE_MARKER);
      }

      // The documented lifecycle difference itself: the canonical-governance
      // write path is gated, the recall predicate is not.
      process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
      const enforceProposal = await brokerCall('POST', '/memory/propose', {
        token: aliceWorkerToken,
        hermesRunId: aliceLive.hermesRunId,
        body: { key: `closeout-enforce-${tag}`, value: `Enforce-mode proposal ${tag}`, scope: 'user_private' },
      });
      delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
      const darkProposal = await brokerCall('POST', '/memory/propose', {
        token: aliceWorkerToken,
        hermesRunId: aliceLive.hermesRunId,
        body: { key: `closeout-dark-${tag}`, value: `Dark-mode proposal ${tag}`, scope: 'user_private' },
      });
      // Runtime-proposed memory is review-only in BOTH modes: the rule that
      // decides it (`memory.model_extraction.requires_review`) is evaluated
      // before scope and is not lifecycle-gated, so the lifecycle flag can
      // never weaken what the agent runtime is allowed to commit.
      for (const proposal of [enforceProposal, darkProposal]) {
        expect(proposal.status).toBeLessThan(300);
        expect(proposal.json).toMatchObject({ status: 'pending', memoryId: null, ruleId: 'memory.model_extraction.requires_review' });
      }
    });

    test('ASSERTION 6 — no fallback: the prototype port is not in the container, and a failing governed path returns an honest error instead of ungoverned data', async () => {
      const { DirectMemoryItemsRecallPort, ContextPlaneRecallPort, MERI_HERMES_RECALL_PORT } = await import('./meri-hermes-recall.ports.js');

      // (a) the production binding is the Context Plane port…
      expect(app.get(MERI_HERMES_RECALL_PORT, { strict: false })).toBeInstanceOf(ContextPlaneRecallPort);
      // …and the harness prototype port is not a provider anywhere in the
      // booted application graph, so nothing can resolve or fall back to it.
      expect(() => app.get(DirectMemoryItemsRecallPort, { strict: false })).toThrow();

      // (b) FAULT INJECTION (not a substitution of governance): make the real
      //     governed boundary fail, exactly as an unavailable Context Plane
      //     would, and observe what the worker is handed.
      const { ServiceUnavailableException } = await import('@nestjs/common');
      const failure = jest
        .spyOn(contextPlane, 'searchToolData')
        .mockRejectedValue(new ServiceUnavailableException('Governed retrieval did not run; no data was searched'));
      let broken: { status: number; json: Record<string, unknown> | null };
      try {
        broken = await recall(aliceWorkerToken, aliceLive.hermesRunId, FIRM_MARKER);
      } finally {
        failure.mockRestore();
      }
      expect(broken.status).toBeGreaterThanOrEqual(500);
      const body = JSON.stringify(broken.json ?? {});
      expect(body).not.toContain(FIRM_MARKER);
      expect(body).not.toContain('direct_memory_items_prototype');
      expect((broken.json as RecallBody).items).toBeUndefined();

      // (c) no event claiming a successful recall was written for the failure…
      const events = await runEvents(aliceLive.runId);
      expect(events.filter((e) => e.kind === 'memory.recalled').every((e) => e.payload.path === 'context_plane')).toBe(true);

      // (d) …and the governed path still works immediately afterwards, so the
      //     failure above was the injected fault and not a broken fixture.
      const recovered = (await recall(aliceWorkerToken, aliceLive.hermesRunId, FIRM_MARKER)).json as RecallBody;
      expect(recovered.path).toBe('context_plane');
      expect(recovered.items!.some((i) => i.sourceId === firmFactId)).toBe(true);
    });

    test('ASSERTION 6 (worker side) — the real worker has no local factual-memory store to fall back to', () => {
      const rendered = sh('docker', ['exec', WORKER_CONTAINER, 'cat', '/opt/data/config.yaml']);
      expect(rendered).toMatch(/provider:\s*"?meri_memory"?/);
      expect(rendered).toMatch(/memory_enabled:\s*false/);
      expect(rendered).toMatch(/user_profile_enabled:\s*false/);
    });

    test('ASSERTION 7 — a proposed memory is reported as pending and is NOT saved until the authoritative service commits it', async () => {
      const key = `closeout-proposed-${tag}`;
      const value = `${PROPOSED_MARKER}: the runtime proposed this, nothing may treat it as saved.`;
      const proposed = await brokerCall('POST', '/memory/propose', {
        token: aliceWorkerToken,
        hermesRunId: aliceLive.hermesRunId,
        body: { key, value, scope: 'user_private', confidence: 0.9, sourceExcerpt: 'closeout evidence' },
      });
      expect(proposed.status).toBeLessThan(300);
      const result = proposed.json as { candidateId: string; status: string; memoryId: string | null; ruleId: string };
      expect(result.status).toBe('pending');
      expect(result.memoryId).toBeNull();
      expect(result.ruleId).toBe('memory.model_extraction.requires_review');

      // The candidate row exists and is pending; NO canonical memory exists.
      const pendingRows = await prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ status: string; source_kind: string }>>`
          SELECT status, source_kind FROM memory_candidate WHERE id = ${result.candidateId}::uuid`,
      );
      expect(pendingRows[0]).toMatchObject({ status: 'pending', source_kind: 'model_extraction' });
      const committedBefore = await prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM clio_memory WHERE tenant_id = ${pilotTenantId}::uuid AND key = ${key}`,
      );
      expect(Number(committedBefore[0]!.n)).toBe(0);

      // The run event the browser sees says "proposed", never "saved".
      const events = await runEvents(aliceLive.runId);
      const proposedEvent = events.filter((e) => e.kind === 'memory.proposed').at(-1);
      expect(proposedEvent).toBeDefined();
      expect(proposedEvent!.payload.status).toBe('pending');

      // Governed recall does not surface it while it is pending.
      const stillHidden = (await recall(aliceWorkerToken, aliceLive.hermesRunId, PROPOSED_MARKER)).json as RecallBody;
      expect(JSON.stringify(stillHidden.items)).not.toContain(PROPOSED_MARKER);

      // Only the AUTHORITATIVE service commits it.
      const committed = await candidates.approve(pilotTenantId, result.candidateId, aliceId, {
        tenantId: pilotTenantId,
        userId: aliceId,
        role: 'standard_user',
      });
      expect(committed.memoryId).toEqual(expect.any(String));
      const committedAfter = await prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM clio_memory WHERE tenant_id = ${pilotTenantId}::uuid AND key = ${key}`,
      );
      expect(Number(committedAfter[0]!.n)).toBe(1);
    });

    // -----------------------------------------------------------------------
    // C. AUTHORIZATION IS RECHECKED EVERYWHERE, NOT JUST ON THE TOOL CALL
    // -----------------------------------------------------------------------
    describe('C. current-permission rechecks on every surface', () => {
      let artifactId: string;

      beforeAll(async () => {
        await refreshLive();
        const published = await brokerCall('POST', '/artifacts', {
          token: aliceWorkerToken,
          hermesRunId: aliceLive.hermesRunId,
          body: { title: 'Closeout artifact', kind: 'hermes_file', bodyText: `${ARTIFACT_MARKER} artifact body`, contentType: 'text/plain' },
        });
        expect(published.status).toBeLessThan(300);
        artifactId = (published.json as { artifactId: string }).artifactId;
      }, 420_000);

      test('C1 run status — owner 200, a different user in the SAME tenant 404, unauthenticated 401', async () => {
        expect((await api('GET', `/api/clio/hermes/runs/${aliceLive.runId}`, { as: aliceId })).status).toBe(200);
        expect((await api('GET', `/api/clio/hermes/runs/${aliceLive.runId}`, { as: bobId })).status).toBe(404);
        expect((await api('GET', `/api/clio/hermes/runs/${aliceLive.runId}`)).status).toBe(401);
      });

      test('C2 event replay — owner streams, a different user 404, unauthenticated 401', async () => {
        const abort = new AbortController();
        const owner = await fetch(`${apiBase}/api/clio/hermes/runs/${aliceLive.runId}/events?after=0`, {
          headers: { authorization: `Bearer ${bearerFor(aliceId)}`, accept: 'text/event-stream' },
          signal: abort.signal,
        });
        expect(owner.status).toBe(200);
        expect(owner.headers.get('content-type')).toMatch(/text\/event-stream/);
        abort.abort();
        await owner.body?.cancel().catch(() => undefined);

        expect((await api('GET', `/api/clio/hermes/runs/${aliceLive.runId}/events?after=0`, { as: bobId })).status).toBe(404);
        expect((await api('GET', `/api/clio/hermes/runs/${aliceLive.runId}/events?after=0`)).status).toBe(401);
      });

      test('C3 artifact retrieval — owner 200, a different user 404, an outside tenant 404, unauthenticated 401', async () => {
        const owner = await api('GET', `/api/clio/hermes/artifacts/${artifactId}`, { as: aliceId });
        expect(owner.status).toBe(200);
        expect(owner.text).toContain(ARTIFACT_MARKER);
        const other = await api('GET', `/api/clio/hermes/artifacts/${artifactId}`, { as: bobId });
        expect(other.status).toBe(404);
        expect(other.text).not.toContain(ARTIFACT_MARKER);
        expect((await api('GET', `/api/clio/hermes/artifacts/${artifactId}`, { as: carolId })).status).toBe(404);
        expect((await api('GET', `/api/clio/hermes/artifacts/${artifactId}`)).status).toBe(401);
      });

      test('C4 interaction answers — approval and clarification refuse a non-owner and an unauthenticated caller', async () => {
        const requestId = aliceLive.approvalRequestId ?? 'req_unknown';
        const asBob = await api('POST', `/api/clio/hermes/runs/${aliceLive.runId}/approval`, {
          as: bobId,
          body: { requestId, decision: 'deny' },
        });
        expect(asBob.status).toBe(404);
        expect((await api('POST', `/api/clio/hermes/runs/${aliceLive.runId}/approval`, { body: { requestId, decision: 'deny' } })).status).toBe(401);

        const clarifyAsBob = await api('POST', `/api/clio/hermes/runs/${aliceLive.runId}/clarification`, {
          as: bobId,
          body: { requestId: 'clar_x', answer: 'no' },
        });
        expect(clarifyAsBob.status).toBe(404);
        // The run is still owned by Alice and still pending her decision — the
        // refusals above changed nothing.
        const projection = await runProjection(aliceId, aliceLive.runId);
        expect((projection.pendingInteractions as Array<{ resolved: boolean }>).some((i) => !i.resolved)).toBe(true);
      });

      test('C5 artifact publication — the broker refuses a publish bound to another actor\'s run', async () => {
        const crossed = await brokerCall('POST', '/artifacts', {
          token: bobWorkerToken,
          hermesRunId: aliceLive.hermesRunId,
          body: { title: 'Cross-actor artifact', kind: 'hermes_file', bodyText: 'should never exist' },
        });
        expect(crossed.status).toBe(403);
        const leaked = await prisma.withSystem((tx) =>
          tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM clio_artifacts WHERE title = 'Cross-actor artifact'`,
        );
        expect(Number(leaked[0]!.n)).toBe(0);
      });

      test('C6 the pilot gate is re-read LIVE, and its documented drain split holds: new work is refused while an already-admitted run stays controllable by its OWNER only', async () => {
        const { MeriFeatureFlagsService } = await import('../meri-feature-flags.service.js');
        const { MERI_HERMES_RUNTIME_FLAG } = await import('../../common/meri-hermes-flags.js');
        const flags = app.get(MeriFeatureFlagsService, { strict: false });
        const setFlag = async (value: boolean) => {
          await prisma.withSystem((tx) =>
            tx.tenant.update({ where: { id: pilotTenantId }, data: { settings: { clioFeatureFlags: { [MERI_HERMES_RUNTIME_FLAG]: value } } } }),
          );
          flags.invalidate(pilotTenantId);
        };
        const requestId = aliceLive.approvalRequestId ?? 'req_unknown';
        await setFlag(false);
        try {
          // Anything that CREATES NEW WORK or GRANTS NEW EXECUTION is refused
          // the moment the flag closes — no cached decision, no deploy.
          expect((await api('GET', '/api/clio/hermes/capabilities', { as: aliceId })).status).toBe(404);
          expect((await api('GET', `/api/clio/hermes/conversations/${convAlice2Id}/active`, { as: aliceId })).status).toBe(404);
          expect(
            (await api('POST', `/api/clio/hermes/runs/${aliceLive.runId}/approval`, { as: aliceId, body: { requestId, decision: 'deny' } })).status,
          ).toBe(404);
          expect(
            (await api('POST', `/api/clio/hermes/runs/${aliceLive.runId}/clarification`, { as: aliceId, body: { requestId: 'clar_x', answer: 'x' } }))
              .status,
          ).toBe(404);
          expect((await api('POST', `/api/clio/hermes/runs/${aliceLive.runId}/steer`, { as: aliceId, body: { text: 'more guidance' } })).status).toBe(404);
          expect((await api('GET', `/api/clio/hermes/artifacts/${artifactId}`, { as: aliceId })).status).toBe(404);

          // Observation/control of an ALREADY-ADMITTED run deliberately stays
          // open to its owner so the kill switch is a drain rather than a way
          // to strand a live worker (see the `ownedRun` doc comment) — but
          // OWNERSHIP is still the real authorization, so a different user in
          // the same tenant is refused identically with the flag either way.
          expect((await api('GET', `/api/clio/hermes/runs/${aliceLive.runId}`, { as: aliceId })).status).toBe(200);
          expect((await api('GET', `/api/clio/hermes/runs/${aliceLive.runId}/events?after=0`, { as: bobId })).status).toBe(404);
          expect((await api('GET', `/api/clio/hermes/runs/${aliceLive.runId}`, { as: bobId })).status).toBe(404);
          expect((await api('GET', `/api/clio/hermes/runs/${aliceLive.runId}`)).status).toBe(401);
        } finally {
          await setFlag(true);
        }
        expect((await api('GET', '/api/clio/hermes/capabilities', { as: aliceId })).status).toBe(200);
        expect((await api('GET', `/api/clio/hermes/artifacts/${artifactId}`, { as: aliceId })).status).toBe(200);
      });

      /**
       * C7 — the DRAIN itself, which is the half of the rollback contract C6
       * does not exercise.
       *
       * `deployment-validation-and-rollback.md`: after the kill switch,
       * in-flight runs are drained or stopped via `POST .../runs/:id/stop`,
       * and "a flag change must not make active workers uncontrollable". The
       * controller used to route Stop through `assertEnabled()`, so closing
       * the flag 404'd Stop and left a REAL Hermes worker executing with no
       * way to reach it. This proves the fixed behaviour end to end against
       * the live worker: flag off, owner stops, the run actually reaches a
       * terminal state — and never reports success.
       *
       * It drains the SHARED `aliceLive` run rather than parking a dedicated
       * one. That is deliberate: the worker enforces
       * `MERI_MAX_CONCURRENT_RUNS=4`, and the sections above already hold
       * several parked runs, so an extra park here made admission fail with
       * "Too many concurrent runs (max 4)" — a fixture limit, not a defect,
       * but one that would have made this test's failure mean nothing.
       * Draining `aliceLive` is safe because every later section begins with
       * `refreshLive()`, which re-parks a terminal run in a spare
       * conversation.
       */
      test('C7 after the kill switch the OWNER can still stop an already-admitted run and it really terminates; a non-owner cannot, and no new run is admitted', async () => {
        const { MeriFeatureFlagsService } = await import('../meri-feature-flags.service.js');
        const { MERI_HERMES_RUNTIME_FLAG } = await import('../../common/meri-hermes-flags.js');
        const { MeriHermesRuntimeAdapter } = await import('./meri-hermes-runtime.adapter.js');
        const flags = app.get(MeriFeatureFlagsService, { strict: false });
        const adapter = app.get(MeriHermesRuntimeAdapter, { strict: false });
        const setFlag = async (value: boolean) => {
          await prisma.withSystem((tx) =>
            tx.tenant.update({ where: { id: pilotTenantId }, data: { settings: { clioFeatureFlags: { [MERI_HERMES_RUNTIME_FLAG]: value } } } }),
          );
          flags.invalidate(pilotTenantId);
        };

        // Drain the run this section already has parked (see the note above on
        // MERI_MAX_CONCURRENT_RUNS); re-park it first if Hermes's own
        // approvals.timeout has already released it.
        await refreshLive();
        const drain = aliceLive;
        const drainConversationId = String((await runProjection(aliceId, drain.runId)).conversationId);
        expect(drainConversationId).toEqual(expect.any(String));
        expect(TERMINAL).not.toContain(String((await runProjection(aliceId, drain.runId)).status));
        const runsBefore = await prisma.withSystem((tx) =>
          tx.$queryRaw<Array<{ n: bigint }>>`
            SELECT count(*) AS n FROM meri_agent_runs WHERE conversation_id = ${drainConversationId}::uuid`,
        );

        await setFlag(false);
        try {
          // Observation of the admitted run survives the gate closing…
          const status = await api('GET', `/api/clio/hermes/runs/${drain.runId}`, { as: aliceId });
          expect(status.status).toBe(200);
          expect((status.json as { runId?: string }).runId).toBe(drain.runId);
          // Raw fetch + abort, not `api()`: this run is LIVE, so the replay
          // stream stays open until it goes terminal and reading the body to
          // completion would block the test rather than assert anything.
          const replayAbort = new AbortController();
          const replay = await fetch(`${apiBase}/api/clio/hermes/runs/${drain.runId}/events?after=0`, {
            headers: { authorization: `Bearer ${bearerFor(aliceId)}`, accept: 'text/event-stream' },
            signal: replayAbort.signal,
          });
          expect(replay.status).toBe(200);
          expect(replay.headers.get('content-type')).toMatch(/text\/event-stream/);
          replayAbort.abort();
          await replay.body?.cancel().catch(() => undefined);

          // …but ownership is still the real authorization for the control path.
          expect((await api('POST', `/api/clio/hermes/runs/${drain.runId}/stop`, { as: bobId })).status).toBe(404);
          expect((await api('POST', `/api/clio/hermes/runs/${drain.runId}/stop`)).status).toBe(401);

          // NEW work is still refused. Asserted at the admission seam rather
          // than by firing a turn: `shouldHandle` is the only thing the
          // runtime proxy consults, and with the flag off the turn would be
          // served by the legacy/V3 runtime, whose behaviour is not what this
          // test is about.
          expect(await adapter.shouldHandle(aliceCtx)).toBe(false);

          // The drain: the owner stops a live Hermes worker with the gate shut.
          const stopped = await api('POST', `/api/clio/hermes/runs/${drain.runId}/stop`, { as: aliceId });
          expect([200, 201]).toContain(stopped.status);
          expect((stopped.json as { stopRequestedAt?: string | null }).stopRequestedAt).toEqual(expect.any(String));

          const deadline = Date.now() + 120_000;
          let finalStatus = String((stopped.json as { status?: string }).status ?? '');
          while (!TERMINAL.includes(finalStatus) && Date.now() < deadline) {
            await sleep(1_000);
            const row = await prisma.withSystem((tx) =>
              tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM meri_agent_runs WHERE id = ${drain.runId}::uuid`,
            );
            finalStatus = row[0]!.status;
          }
          expect(TERMINAL).toContain(finalStatus);
          // A stopped run never publishes success (contracts.md §6).
          expect(finalStatus).not.toBe('completed');

          // No new run was admitted to that conversation while the gate was shut.
          const runsAfter = await prisma.withSystem((tx) =>
            tx.$queryRaw<Array<{ n: bigint }>>`
              SELECT count(*) AS n FROM meri_agent_runs WHERE conversation_id = ${drainConversationId}::uuid`,
          );
          expect(Number(runsAfter[0]!.n)).toBe(Number(runsBefore[0]!.n));
        } finally {
          await setFlag(true);
        }
      }, 420_000);
    });

    // -----------------------------------------------------------------------
    // D. WORKER CREDENTIAL BINDING, ROTATION AND EXPIRY (HTTP level)
    // -----------------------------------------------------------------------
    describe('D. worker credential binding, rotation and expiry, through the real broker route', () => {
      const codeOf = (json: Record<string, unknown> | null): unknown =>
        (json as { code?: unknown } | null)?.code ?? (json as { message?: { code?: unknown } } | null)?.message?.code;

      beforeAll(async () => {
        await refreshLive();
      }, 420_000);

      test('D1 the native Hermes run id is bound to the CURRENT attempt server-side', async () => {
        // baseline: the live attempt authorizes
        expect((await brokerCall('GET', '/whoami', { token: aliceWorkerToken, hermesRunId: aliceLive.hermesRunId })).status).toBe(200);

        // no binding at all
        const unbound = await brokerCall('GET', '/whoami', { token: aliceWorkerToken, hermesRunId: null });
        expect(unbound.status).toBe(401);
        expect(codeOf(unbound.json)).toBe('missing_run_binding');

        // a run id this broker has never admitted
        const unknown = await brokerCall('GET', '/whoami', { token: aliceWorkerToken, hermesRunId: `run_${randomUUID().replace(/-/g, '')}` });
        expect(unknown.status).toBe(404);
        expect(codeOf(unknown.json)).toBe('run_not_found');

        // a STALE attempt: the completed run from A1, with a perfectly valid token
        const staleHermesRunId = await prisma.withSystem(async (tx) => {
          const rows = await tx.$queryRaw<Array<{ hermes_run_id: string }>>`
            SELECT hermes_run_id FROM meri_agent_runs
            WHERE conversation_id = ${a1ConversationId}::uuid AND hermes_run_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
          return rows[0]?.hermes_run_id ?? null;
        });
        expect(staleHermesRunId).toEqual(expect.any(String));
        const stale = await brokerCall('GET', '/whoami', { token: aliceWorkerToken, hermesRunId: staleHermesRunId! });
        expect(stale.status).toBe(409);
        expect(codeOf(stale.json)).toBe('run_not_live');

        // a MISMATCHED attempt: another actor's live run in the same tenant
        const mismatched = await brokerCall('GET', '/whoami', { token: aliceWorkerToken, hermesRunId: bobLive.hermesRunId });
        expect(mismatched.status).toBe(403);
        expect(codeOf(mismatched.json)).toBe('scope_mismatch');
      });

      test('D2 rotation — a freshly minted replacement credential works without touching the run, and the retired one keeps working only until it expires', async () => {
        const rotated = mintToken(
          {
            executionScopeId: aliceScopeId,
            tenantId: pilotTenantId,
            actorType: 'user',
            actorId: aliceId,
            authorizationVersion: aliceAuthorizationVersion,
            ttlSeconds: 600,
          },
          brokerSigningKey,
        );
        // Distinct credential (new jti), same scope binding.
        expect(rotated.token).not.toBe(aliceWorkerToken);
        const withRotated = await brokerCall('GET', '/whoami', { token: rotated.token, hermesRunId: aliceLive.hermesRunId });
        expect(withRotated.status).toBe(200);
        expect(withRotated.json).toMatchObject({ actorId: aliceId, executionScopeId: aliceScopeId });
        // The previous credential is still inside its own TTL, so rotation is
        // non-disruptive: an in-flight worker is never locked out mid-run.
        expect((await brokerCall('GET', '/whoami', { token: aliceWorkerToken, hermesRunId: aliceLive.hermesRunId })).status).toBe(200);

        // A credential signed with a DIFFERENT key is refused regardless of scope.
        const foreign = mintToken(
          {
            executionScopeId: aliceScopeId,
            tenantId: pilotTenantId,
            actorType: 'user',
            actorId: aliceId,
            authorizationVersion: aliceAuthorizationVersion,
            ttlSeconds: 600,
          },
          `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`,
        ).token;
        const foreignCall = await brokerCall('GET', '/whoami', { token: foreign, hermesRunId: aliceLive.hermesRunId });
        expect(foreignCall.status).toBe(401);
        expect(codeOf(foreignCall.json)).toBe('worker_token_bad_signature');
      });

      test('D3 expiry — an expired credential is refused server-side even on a perfectly live run, and a not-yet-valid one is too', async () => {
        const longAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
        const expired = mintToken(
          {
            executionScopeId: aliceScopeId,
            tenantId: pilotTenantId,
            actorType: 'user',
            actorId: aliceId,
            authorizationVersion: aliceAuthorizationVersion,
            ttlSeconds: 60,
          },
          brokerSigningKey,
          longAgo,
        );
        expect(expired.claims.exp * 1000).toBeLessThan(Date.now());
        const expiredCall = await brokerCall('POST', '/memory/recall', {
          token: expired.token,
          hermesRunId: aliceLive.hermesRunId,
          body: { query: FIRM_MARKER, limit: 5 },
        });
        expect(expiredCall.status).toBe(401);
        expect(codeOf(expiredCall.json)).toBe('worker_token_expired');
        expect(JSON.stringify(expiredCall.json)).not.toContain(FIRM_MARKER);

        const future = new Date(Date.now() + 60 * 60 * 1000);
        const notYet = mintToken(
          {
            executionScopeId: aliceScopeId,
            tenantId: pilotTenantId,
            actorType: 'user',
            actorId: aliceId,
            authorizationVersion: aliceAuthorizationVersion,
            ttlSeconds: 3600,
          },
          brokerSigningKey,
          future,
        ).token;
        const notYetCall = await brokerCall('GET', '/whoami', { token: notYet, hermesRunId: aliceLive.hermesRunId });
        expect(notYetCall.status).toBe(401);
        expect(codeOf(notYetCall.json)).toBe('worker_token_not_yet_valid');

        // The same claims, freshly minted, still work — it is expiry, not scope.
        const fresh = mintToken(
          {
            executionScopeId: aliceScopeId,
            tenantId: pilotTenantId,
            actorType: 'user',
            actorId: aliceId,
            authorizationVersion: aliceAuthorizationVersion,
            ttlSeconds: 600,
          },
          brokerSigningKey,
        ).token;
        expect((await brokerCall('GET', '/whoami', { token: fresh, hermesRunId: aliceLive.hermesRunId })).status).toBe(200);
      });

      test('D4 an authorization-version rotation FENCES the run: the stale credential is refused and the REAL Hermes worker is actually stopped', async () => {
        // Bob's live run is the sacrifice here so Alice's stays usable.
        const staleVersion = mintToken(
          {
            executionScopeId: bobScopeId,
            tenantId: pilotTenantId,
            actorType: 'user',
            actorId: bobId,
            authorizationVersion: `${bobAuthorizationVersion}-stale`,
            ttlSeconds: 600,
          },
          brokerSigningKey,
        ).token;
        const fenced = await brokerCall('POST', '/memory/recall', {
          token: staleVersion,
          hermesRunId: bobLive.hermesRunId,
          body: { query: BOB_MARKER, limit: 5 },
        });
        expect(fenced.status).toBe(403);
        expect(codeOf(fenced.json)).toBe('authorization_version_mismatch');
        expect(JSON.stringify(fenced.json)).not.toContain(BOB_MARKER);

        // The run is fenced to a terminal state, not merely denied…
        const projection = await runProjection(bobId, bobLive.runId);
        expect(projection.status).toBe('interrupted');
        expect(projection.finishReason).toBe('interrupted');
        expect(String(projection.error)).toContain('authorization_downgrade');

        // …and the real Hermes worker was asked to stop this run.
        const hermesStatus = await fetch(`http://127.0.0.1:${WORKER_PORT}/v1/runs/${bobLive.hermesRunId}`, {
          headers: { authorization: `Bearer ${workerGatewayKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        const hermesBody = (await hermesStatus.json().catch(() => ({}))) as { status?: string };
        expect(['cancelled', 'stopped', 'interrupted', 'completed', 'failed', 'stopping']).toContain(String(hermesBody.status));

        // Stale callbacks from the fenced attempt are rejected, with the
        // correct (unrotated) credential too.
        const staleCallback = await brokerCall('POST', '/memory/recall', {
          token: bobWorkerToken,
          hermesRunId: bobLive.hermesRunId,
          body: { query: BOB_MARKER, limit: 5 },
        });
        expect(staleCallback.status).toBe(409);
        expect(codeOf(staleCallback.json)).toBe('run_not_live');
        expect(JSON.stringify(staleCallback.json)).not.toContain(BOB_MARKER);
      });
    });
  });

  // =========================================================================
  // B. REVOCATION DURING AN IN-FLIGHT TOOL READ
  // =========================================================================
  describe('B. membership revoked while a governed tool read is in flight', () => {
    let live: LiveRun;
    let inFlightStatus = 0;
    let inFlightBody: Record<string, unknown> | null = null;
    let releaseRead: (() => void) | null = null;
    let readEntered: Promise<void>;
    /**
     * `memory.recalled` events already on the run BEFORE the probe. The real
     * worker's memory provider prefetches on its own, so the honest assertion
     * is that the BLOCKED read added none — not that the run has none.
     */
    let recalledBefore = 0;

    beforeAll(async () => {
      live = await startLiveRun(aliceId, convAlice3Id, PARK_PROMPT);

      // Deliberately delay ONE governed read so the revocation lands strictly
      // while that read is in flight. The real port still does all the real
      // work; the spy only adds a gate around it.
      const port = app.get<import('./meri-hermes-recall.ports.js').MeriHermesRecallPort>(
        (await import('./meri-hermes-recall.ports.js')).MERI_HERMES_RECALL_PORT,
        { strict: false },
      );
      const realRecall = port.recall.bind(port);
      let entered: () => void;
      readEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const delayed = jest.spyOn(port, 'recall').mockImplementation(async (ctx, input) => {
        entered();
        await gate;
        delayed.mockRestore();
        return realRecall(ctx, input);
      });

      recalledBefore = (await runEvents(live.runId)).filter((e) => e.kind === 'memory.recalled').length;

      const inFlight = brokerCall('POST', '/memory/recall', {
        token: aliceWorkerToken,
        hermesRunId: live.hermesRunId,
        body: { query: FIRM_MARKER, limit: 10 },
      });
      await readEntered;

      // REVOKE while the read is in flight.
      await prisma.withSystem((tx) =>
        tx.tenantMembership.updateMany({ where: { tenantId: pilotTenantId, userId: aliceId }, data: { status: 'removed' } }),
      );
      releaseRead!();
      const settled = await inFlight;
      inFlightStatus = settled.status;
      inFlightBody = settled.json;
    }, 420_000);

    afterAll(async () => {
      await prisma
        .withSystem((tx) =>
          tx.tenantMembership.updateMany({ where: { tenantId: pilotTenantId, userId: aliceId }, data: { status: 'active' } }),
        )
        .catch(() => undefined);
    });

    /**
     * contracts.md §2 requires that an authorization downgrade cannot leave
     * already-loaded context in the model's window, so the payload of a read
     * that was authorized microseconds before the revocation must never be
     * handed to the worker. `MeriHermesBrokerService.recall()` re-verifies the
     * live state AFTER the governed read resolves and BEFORE returning
     * (`assertStillAuthorizedBeforeRelease`), so the throw happens while the
     * result is still a local variable.
     */
    test('B1 the in-flight governed read is BLOCKED before it reaches the worker (and therefore before the model)', () => {
      expect(inFlightStatus).toBe(403);
      const code =
        (inFlightBody as { code?: string } | null)?.code ?? (inFlightBody as { message?: { code?: string } } | null)?.message?.code;
      expect(code).toBe('authorization_revoked');
      const body = JSON.stringify(inFlightBody ?? {});
      expect(body).not.toContain(FIRM_MARKER);
      expect(body).not.toContain(firmFactId);
      expect((inFlightBody as { items?: unknown }).items).toBeUndefined();
    });

    test('B2 the attempt is FENCED, not merely denied: terminal run, authorization_downgrade, and no "recalled" event for the blocked read', async () => {
      const row = await prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ status: string; finish_reason: string | null; error: string | null }>>`
          SELECT status, finish_reason, error FROM meri_agent_runs WHERE id = ${live.runId}::uuid`,
      );
      expect(row[0]!.status).toBe('interrupted');
      expect(row[0]!.finish_reason).toBe('interrupted');
      expect(String(row[0]!.error)).toContain('authorization_downgrade');

      const events = await runEvents(live.runId);
      const revoked = events.filter((e) => e.kind === 'error' && e.payload.code === 'authorization_revoked');
      expect(revoked.length).toBeGreaterThan(0);
      // The fence fired on the RELEASE check (after the read resolved), which
      // is the window this guard exists to close.
      expect(revoked.some((e) => e.payload.phase === 'release')).toBe(true);
      // …and no event claims the BLOCKED read was delivered: the release guard
      // throws before `memory.recalled` is appended, so the count is unchanged
      // from before the probe (the worker's own earlier prefetches remain).
      const recalled = events.filter((e) => e.kind === 'memory.recalled');
      expect(recalled.length).toBe(recalledBefore);
    });

    test('B3 stale callbacks from the fenced attempt are rejected (409 run_not_live), and the browser surfaces are closed by the real auth boundary', async () => {
      for (const attempt of [0, 1]) {
        const stale = await brokerCall('POST', attempt === 0 ? '/memory/recall' : '/artifacts', {
          token: aliceWorkerToken,
          hermesRunId: live.hermesRunId,
          body: attempt === 0 ? { query: FIRM_MARKER, limit: 5 } : { title: 'post-fence artifact', kind: 'hermes_file', bodyText: 'nope' },
        });
        expect(stale.status).toBe(409);
        expect((stale.json as { code?: string; message?: { code?: string } }).code ?? (stale.json as { message?: { code?: string } }).message?.code).toBe(
          'run_not_live',
        );
        expect(JSON.stringify(stale.json)).not.toContain(FIRM_MARKER);
      }
      const leaked = await prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM clio_artifacts WHERE title = 'post-fence artifact'`,
      );
      expect(Number(leaked[0]!.n)).toBe(0);

      // The revoked user has no route back in through the browser either: the
      // real TenantContextMiddleware refuses the session outright.
      const browser = await api('GET', `/api/clio/hermes/runs/${live.runId}`, { as: aliceId });
      expect([401, 403]).toContain(browser.status);
    });

    test('B4 a newly authorized attempt REBUILDS context instead of resuming the fenced transcript', async () => {
      const fenced = await prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ hermes_session_id: string | null }>>`
          SELECT hermes_session_id FROM meri_agent_runs WHERE id = ${live.runId}::uuid`,
      );
      const fencedSessionId = fenced[0]!.hermes_session_id;
      expect(fencedSessionId).toEqual(expect.any(String));

      // The fence already severed the conversation ⇄ transcript binding…
      const afterFence = await prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ metadata: Record<string, unknown> }>>`
          SELECT metadata_jsonb AS metadata FROM clio_conversations WHERE id = ${convAlice3Id}::uuid`,
      );
      const hermesMeta = (afterFence[0]!.metadata.hermes ?? {}) as {
        sessionId?: string | null;
        sessionEpoch?: number;
        supersededSessionIds?: string[];
        invalidatedReason?: string;
      };
      expect(hermesMeta.sessionId ?? null).toBeNull();
      expect(Number(hermesMeta.sessionEpoch ?? 0)).toBeGreaterThan(0);
      expect(hermesMeta.supersededSessionIds ?? []).toContain(fencedSessionId);

      // …so the next, freshly authorized attempt starts a different transcript.
      await prisma.withSystem((tx) =>
        tx.tenantMembership.updateMany({ where: { tenantId: pilotTenantId, userId: aliceId }, data: { status: 'active' } }),
      );
      const reAuthorized = await streamTurn(aliceId, convAlice3Id, 'Reply with exactly: REBUILD-CHECK.', 300_000);
      const done = reAuthorized.frames.find((f) => f.type === 'done');
      expect(done?.runtime).toBe('hermes');
      const newRunId = done?.runId as string | undefined;
      expect(newRunId).toEqual(expect.any(String));

      const fresh = await prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ hermes_session_id: string | null }>>`
          SELECT hermes_session_id FROM meri_agent_runs WHERE id = ${newRunId}::uuid`,
      );
      expect(fresh[0]!.hermes_session_id).toEqual(expect.any(String));
      expect(fresh[0]!.hermes_session_id).not.toBe(fencedSessionId);
    }, 330_000);
  });
});
