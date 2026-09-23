import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { MERI_HERMES_RUNTIME_FLAG } from '../src/common/meri-hermes-flags.js';
import { MeriFeatureFlagsService } from '../src/meri/meri-feature-flags.service.js';
import { MeriHermesAdmissionControlService } from '../src/meri/hermes/meri-hermes-admission-control.service.js';
import { MeriHermesBudgetService } from '../src/meri/hermes/meri-hermes-budget.service.js';
import { MeriHermesDbGovernor } from '../src/meri/hermes/meri-hermes-db-governor.js';
import { MeriHermesPrismaRunRepository } from '../src/meri/hermes/meri-hermes-prisma-run-repository.js';
import { MeriHermesProfileLeaseService } from '../src/meri/hermes/meri-hermes-profile-lease.service.js';
import { MeriHermesRuntimeAdapter } from '../src/meri/hermes/meri-hermes-runtime.adapter.js';
import { MeriHermesRuntimeClient } from '../src/meri/hermes/meri-hermes-runtime.client.js';
import { MERI_HERMES_TERMINAL_STATUSES } from '../src/meri/hermes/hermes-runtime.contracts.js';
import { privateExecutionScopeId } from '../src/meri/hermes/meri-hermes-worker-token.js';
import type { MeriHermesSecurityEnvelopePort } from '../src/meri/hermes/meri-hermes-security.port.js';
import type { MeriTurnMaintenance } from '../src/meri/meri-turn-maintenance.js';
import {
  MERI_HERMES_STAGING_PROOF_TENANT_ID,
  MERI_HERMES_STAGING_PROOF_TENANT_SLUG,
  assertMeriHermesStagingProofEvidence,
  assertMeriHermesStagingProofGuards,
  type MeriHermesStagingProofEvidence,
} from './lib/meri-hermes-staging-proof-guard.js';

const CHILD_MARKER = 'MERI_HERMES_PROOF_CHILD=';
const PROOF_RUNTIME_KEY = 'staging-proof-not-a-secret';
const PROOF_SIGNING_KEY = 'staging-proof-signing-key-000000000000000000000000';
const POLL_MS = 100;
const WAIT_MS = 45_000;
const TERMINAL_STATUSES: ReadonlySet<string> = MERI_HERMES_TERMINAL_STATUSES;

type WireEvent = Record<string, unknown> & { event: string };
type ProofRun = {
  id: string;
  sessionId: string;
  status: string;
  output: string;
  events: WireEvent[];
  subscribers: Set<ServerResponse>;
  timers: Set<NodeJS.Timeout>;
};

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function requestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** A local, deterministic replacement for model generation only. */
class DeterministicProofRuntime {
  private readonly runs = new Map<string, ProofRun>();
  private readonly idempotency = new Map<string, string>();
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (this.server.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    for (const run of this.runs.values()) {
      for (const timer of run.timers) clearTimeout(timer);
      for (const subscriber of run.subscribers) subscriber.end();
    }
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private authorized(req: IncomingMessage): boolean {
    return req.headers.authorization === `Bearer ${PROOF_RUNTIME_KEY}`;
  }

  private emit(run: ProofRun, event: WireEvent): void {
    if (TERMINAL_STATUSES.has(run.status)) return;
    run.events.push(event);
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const subscriber of run.subscribers) subscriber.write(line);
    if (event.event === 'message.delta' && typeof event.delta === 'string') run.output += event.delta;
    if (event.event === 'run.completed') run.status = 'completed';
    if (event.event === 'run.cancelled') run.status = 'cancelled';
    if (TERMINAL_STATUSES.has(run.status)) {
      setTimeout(() => {
        for (const subscriber of run.subscribers) subscriber.end();
        run.subscribers.clear();
      }, 25).unref?.();
    }
  }

  private schedule(run: ProofRun, input: string): void {
    const stoppingProof = input.includes('PROOF_STOP');
    const schedule = (ms: number, fn: () => void) => {
      const timer = setTimeout(() => {
        run.timers.delete(timer);
        fn();
      }, ms);
      run.timers.add(timer);
    };
    schedule(700, () => this.emit(run, { event: 'message.delta', delta: 'deterministic-' }));
    schedule(stoppingProof ? 10_000 : 1_500, () =>
      this.emit(run, { event: 'message.delta', delta: 'staging-proof' }),
    );
    schedule(stoppingProof ? 15_000 : 2_300, () =>
      this.emit(run, {
        event: 'run.completed',
        output: run.output,
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      }),
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/health') return json(res, 200, { ok: true });
      if (!this.authorized(req)) return json(res, 401, { error: { message: 'unauthorized' } });

      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        const key = String(req.headers['idempotency-key'] ?? '');
        const existingId = key ? this.idempotency.get(key) : undefined;
        if (existingId) {
          res.setHeader('idempotency-replayed', 'true');
          const existing = this.runs.get(existingId)!;
          return json(res, 200, { run_id: existing.id, status: existing.status, session_id: existing.sessionId });
        }
        const body = await requestJson(req);
        const id = randomUUID();
        const run: ProofRun = {
          id,
          sessionId: `proof-session-${randomUUID()}`,
          status: 'running',
          output: '',
          events: [],
          subscribers: new Set(),
          timers: new Set(),
        };
        this.runs.set(id, run);
        if (key) this.idempotency.set(key, id);
        this.schedule(run, typeof body.input === 'string' ? body.input : '');
        return json(res, 202, { run_id: id, status: 'running', session_id: run.sessionId });
      }

      const eventMatch = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
      if (req.method === 'GET' && eventMatch) {
        const run = this.runs.get(decodeURIComponent(eventMatch[1]!));
        if (!run) return json(res, 404, { error: { message: 'not found' } });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const event of run.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (TERMINAL_STATUSES.has(run.status)) {
          res.end();
          return;
        }
        run.subscribers.add(res);
        req.once('close', () => run.subscribers.delete(res));
        return;
      }

      const stopMatch = /^\/v1\/runs\/([^/]+)\/stop$/.exec(url.pathname);
      if (req.method === 'POST' && stopMatch) {
        await requestJson(req);
        const run = this.runs.get(decodeURIComponent(stopMatch[1]!));
        if (!run) return json(res, 404, { error: { message: 'not found' } });
        if (!TERMINAL_STATUSES.has(run.status)) {
          for (const timer of run.timers) clearTimeout(timer);
          run.timers.clear();
          this.emit(run, { event: 'run.stopping' });
          const timer = setTimeout(() => {
            run.timers.delete(timer);
            this.emit(run, { event: 'run.cancelled' });
          }, 150);
          run.timers.add(timer);
        }
        return json(res, 202, { accepted: true });
      }

      const statusMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && statusMatch) {
        const run = this.runs.get(decodeURIComponent(statusMatch[1]!));
        if (!run) return json(res, 404, { error: { message: 'not found' } });
        return json(res, 200, {
          object: 'hermes.run', run_id: run.id, status: run.status,
          session_id: run.sessionId, ...(run.status === 'completed' ? { output: run.output } : {}),
        });
      }
      return json(res, 404, { error: { message: 'not found' } });
    } catch {
      return json(res, 500, { error: { message: 'deterministic proof runtime error' } });
    }
  }
}

function collector() {
  const frames: Array<Record<string, unknown>> = [];
  return {
    frames,
    sse: {
      write(data: string) {
        const match = /^data: (.*)\n\n$/.exec(data);
        if (match) frames.push(JSON.parse(match[1]!) as Record<string, unknown>);
      },
    },
  };
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = WAIT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function monotonicUnique(events: Array<{ seq: number }>): boolean {
  return events.every((event, index) => index === 0 || event.seq > events[index - 1]!.seq)
    && new Set(events.map((event) => event.seq)).size === events.length;
}

function proofEnvironment(runtimeUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MERI_COMPLIANCE_BLOCK: 'false',
    MERI_HERMES_RUNTIME_URL: runtimeUrl,
    MERI_HERMES_API_KEY: PROOF_RUNTIME_KEY,
    MERI_HERMES_BROKER_SIGNING_KEY: PROOF_SIGNING_KEY,
    MERI_HERMES_REQUEST_TIMEOUT_MS: '10000',
    MERI_HERMES_RUN_MAX_WALL_MS: '30000',
    MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '1',
    MERI_HERMES_MAX_CONCURRENT_RUNS_TENANT: '4',
    MERI_HERMES_MAX_CONCURRENT_RUNS_GLOBAL: '8',
    MERI_HERMES_TENANT_QUEUE_DEPTH: '4',
    MERI_HERMES_QUEUE_WAIT_MS: '30000',
    MERI_HERMES_QUEUE_POLL_MS: '50',
    MERI_HERMES_WATCH_INTERVAL_MS: '50',
    MERI_HERMES_DB_MAX_CONCURRENCY: '4',
  };
}

function buildAdapter(
  prisma: PrismaService,
  runs: MeriHermesPrismaRunRepository,
  runtimeUrl: string,
): { adapter: MeriHermesRuntimeAdapter; admission: MeriHermesAdmissionControlService } {
  const env = proofEnvironment(runtimeUrl);
  const governor = new MeriHermesDbGovernor();
  governor.env = env;
  const admission = new MeriHermesAdmissionControlService(prisma, governor);
  admission.env = env;
  const budgets = new MeriHermesBudgetService(prisma, governor);
  budgets.env = env;
  const profiles = new MeriHermesProfileLeaseService(prisma, governor);
  profiles.env = env;
  const client = MeriHermesRuntimeClient.withEnv(env);
  const security: MeriHermesSecurityEnvelopePort = {
    securityEnvelope: async () => ({ authorizedClientIds: [], authorizedMailboxConnectionIds: [] }),
  };
  const maintenance = { scheduleAfterTurnMaintenance: () => undefined } as MeriTurnMaintenance;
  const adapter = new MeriHermesRuntimeAdapter(
    prisma,
    new MeriFeatureFlagsService(prisma),
    client,
    runs,
    security,
    maintenance,
  );
  adapter.env = env;
  adapter.governor = governor;
  adapter.budgets = budgets;
  adapter.admission = admission;
  adapter.profiles = profiles;
  return { adapter, admission };
}

async function reconnectInFreshProcess(runId: string, tenantId: string, userId: string, afterSeq: number): Promise<boolean> {
  const script = __filename;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', script, '--reattach', runId, tenantId, userId, String(afterSeq)],
    { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-20_000); });
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4_000); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Fresh-process reconnect timed out'));
    }, WAIT_MS);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code ?? 1); });
  });
  if (exitCode !== 0) throw new Error(`Fresh-process reconnect failed (${exitCode}): ${stderr.slice(-500)}`);
  const marker = stdout.split(/\r?\n/).find((line) => line.startsWith(CHILD_MARKER));
  if (!marker) throw new Error('Fresh-process reconnect returned no evidence marker');
  const evidence = JSON.parse(marker.slice(CHILD_MARKER.length)) as Record<string, unknown>;
  return evidence.runId === runId && evidence.terminal === true && Number(evidence.frames) > 0;
}

async function reattachChild(): Promise<void> {
  assertMeriHermesStagingProofGuards(process.env);
  const [, , runId, tenantId, userId, rawAfterSeq] = process.argv;
  if (!runId || !tenantId || !userId) throw new Error('Missing fresh-process reconnect arguments');
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const runs = new MeriHermesPrismaRunRepository(prisma);
    const run = await runs.requireOwned(runId, tenantId, userId);
    if (!run) throw new Error('Owned run not found for fresh-process reconnect');
    const security: MeriHermesSecurityEnvelopePort = {
      securityEnvelope: async () => ({ authorizedClientIds: [], authorizedMailboxConnectionIds: [] }),
    };
    const maintenance = { scheduleAfterTurnMaintenance: () => undefined } as MeriTurnMaintenance;
    const adapter = new MeriHermesRuntimeAdapter(
      prisma,
      new MeriFeatureFlagsService(prisma),
      new MeriHermesRuntimeClient(),
      runs,
      security,
      maintenance,
    );
    let frames = 0;
    await adapter.attach(run, () => { frames += 1; }, undefined, Number(rawAfterSeq ?? 0));
    const terminal = await runs.requireOwned(runId, tenantId, userId);
    process.stdout.write(`${CHILD_MARKER}${JSON.stringify({ runId, frames, terminal: Boolean(terminal && MERI_HERMES_TERMINAL_STATUSES.has(terminal.status)) })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

async function createConversation(prisma: PrismaService, tenantId: string, userId: string, label: string): Promise<string> {
  const id = randomUUID();
  await prisma.withTenant(tenantId, (tx) => tx.clioConversation.create({
    data: { id, tenantId, userId, title: `Synthetic Phase 1 proof: ${label}` },
  }));
  return id;
}

async function runProof(): Promise<void> {
  assertMeriHermesStagingProofGuards(process.env);
  if (process.env.MERI_HERMES_ENABLED !== 'true') throw new Error('Proof task requires MERI_HERMES_ENABLED=true');
  if (process.env.MERI_HERMES_PILOT_TENANT_IDS !== MERI_HERMES_STAGING_PROOF_TENANT_ID) {
    throw new Error('Proof task pilot allowlist must contain only the exact synthetic tenant');
  }
  const startedAt = new Date().toISOString();
  const prisma = new PrismaService();
  const runtime = new DeterministicProofRuntime();
  let primaryUserId = '';
  let otherUserId = '';
  let syntheticTenantDeleted = false;
  let evidence: Omit<MeriHermesStagingProofEvidence, 'cleanup'> | null = null;
  await prisma.$connect();
  try {
    await prisma.withSystem(async (tx) => {
      const byId = await tx.tenant.findUnique({ where: { id: MERI_HERMES_STAGING_PROOF_TENANT_ID } });
      const bySlug = await tx.tenant.findUnique({ where: { slug: MERI_HERMES_STAGING_PROOF_TENANT_SLUG } });
      if ((byId && byId.slug !== MERI_HERMES_STAGING_PROOF_TENANT_SLUG) ||
          (bySlug && bySlug.id !== MERI_HERMES_STAGING_PROOF_TENANT_ID)) {
        throw new Error('Synthetic proof tenant identity collision; refusing cleanup or execution');
      }
      if (byId) await tx.tenant.delete({ where: { id: MERI_HERMES_STAGING_PROOF_TENANT_ID } });
      primaryUserId = randomUUID();
      otherUserId = randomUUID();
      await tx.user.createMany({ data: [
        { id: primaryUserId, clerkUserId: `proof-${primaryUserId}`, email: `${primaryUserId}@proof.invalid` },
        { id: otherUserId, clerkUserId: `proof-${otherUserId}`, email: `${otherUserId}@proof.invalid` },
      ] });
      await tx.tenant.create({
        data: {
          id: MERI_HERMES_STAGING_PROOF_TENANT_ID,
          slug: MERI_HERMES_STAGING_PROOF_TENANT_SLUG,
          name: 'Synthetic Meri Hermes Phase 1 staging proof',
          status: 'active',
          settings: { clioFeatureFlags: { [MERI_HERMES_RUNTIME_FLAG]: false } },
          memberships: { create: [
            { userId: primaryUserId, role: 'standard_user', status: 'active', joinedAt: new Date() },
            { userId: otherUserId, role: 'standard_user', status: 'active', joinedAt: new Date() },
          ] },
        },
      });
    });

    const flags = new MeriFeatureFlagsService(prisma);
    const wrongTenantGateDenied = !(await flags.isMeriHermesRuntimeEnabled(randomUUID()));
    const tenantFlagOffDenied = !(await flags.isMeriHermesRuntimeEnabled(MERI_HERMES_STAGING_PROOF_TENANT_ID));
    await prisma.withSystem((tx) => tx.tenant.update({
      where: { id: MERI_HERMES_STAGING_PROOF_TENANT_ID },
      data: { settings: { clioFeatureFlags: { [MERI_HERMES_RUNTIME_FLAG]: true } } },
    }));
    flags.invalidate(MERI_HERMES_STAGING_PROOF_TENANT_ID);
    if (!(await flags.isMeriHermesRuntimeEnabled(MERI_HERMES_STAGING_PROOF_TENANT_ID))) {
      throw new Error('Synthetic pilot gate did not open after exact opt-in');
    }

    const runtimeUrl = await runtime.start();
    const runs = new MeriHermesPrismaRunRepository(prisma);
    const { adapter, admission } = buildAdapter(prisma, runs, runtimeUrl);
    const ctx: TenantContext = {
      tenantId: MERI_HERMES_STAGING_PROOF_TENANT_ID,
      tenantSlug: MERI_HERMES_STAGING_PROOF_TENANT_SLUG,
      userId: primaryUserId,
      clerkUserId: `proof-${primaryUserId}`,
      role: 'standard_user',
    };
    const scopeId = privateExecutionScopeId(ctx.tenantId, ctx.userId);

    // Queued disconnect: durable admission survives the browser, then a new OS process replays it.
    const queuedConversation = await createConversation(prisma, ctx.tenantId, ctx.userId, 'queued disconnect');
    const occupying = randomUUID();
    await admission.admit({ runId: occupying, tenantId: ctx.tenantId, scopeId, conversationId: randomUUID() });
    const queuedKey = randomUUID();
    const queuedAbort = new AbortController();
    const queuedCollector = collector();
    const queuedTurn = adapter.streamMessage(
      ctx, queuedConversation, 'PROOF_QUEUED', queuedCollector.sse, queuedAbort.signal,
      'new', [], undefined, undefined, queuedKey,
    );
    const queuedRun = await waitFor('queued durable run', async () => {
      const [candidate] = await runs.listForConversation(ctx.tenantId, ctx.userId, queuedConversation);
      return candidate && (await admission.slotState(candidate.runId))?.state === 'queued' ? candidate : null;
    });
    queuedAbort.abort();
    await waitFor('queued detach persistence', async () => (await runs.get(queuedRun.runId))?.detached ?? false);
    const queuedReconnect = reconnectInFreshProcess(queuedRun.runId, ctx.tenantId, ctx.userId, 0);
    await admission.release(occupying);
    await queuedTurn;
    const queuedFreshProcessReconnect = await queuedReconnect;
    const queuedFinal = await waitFor('queued run terminal', async () => {
      const current = await runs.get(queuedRun.runId);
      return current && MERI_HERMES_TERMINAL_STATUSES.has(current.status) ? current : null;
    });
    const queuedEvents = await runs.eventsAfter(queuedFinal.runId, 0, 'all');
    const terminalRetry = collector();
    await adapter.streamMessage(
      ctx, queuedConversation, 'PROOF_QUEUED', terminalRetry.sse, undefined,
      'new', [], undefined, undefined, queuedKey,
    );
    const queuedRuns = await runs.listForConversation(ctx.tenantId, ctx.userId, queuedConversation);
    const queuedUserMessages = await prisma.withTenant(ctx.tenantId, (tx) => tx.clioMessage.count({
      where: { tenantId: ctx.tenantId, userId: ctx.userId, conversationId: queuedConversation, role: 'user' },
    }));

    // Active disconnect: model generation continues; a new process catches up from a durable cursor.
    const activeConversation = await createConversation(prisma, ctx.tenantId, ctx.userId, 'active disconnect');
    const activeAbort = new AbortController();
    const activeCollector = collector();
    const activeTurn = adapter.streamMessage(
      ctx, activeConversation, 'PROOF_ACTIVE', activeCollector.sse, activeAbort.signal,
      'new', [], undefined, undefined, randomUUID(),
    );
    const activeRun = await waitFor('active output snapshot', async () => {
      const [candidate] = await runs.listForConversation(ctx.tenantId, ctx.userId, activeConversation);
      if (!candidate) return null;
      const current = await runs.get(candidate.runId);
      return current && current.outputSeq > 0 ? current : null;
    });
    activeAbort.abort();
    await activeTurn;
    const activeFreshProcessReconnect = await reconnectInFreshProcess(
      activeRun.runId, ctx.tenantId, ctx.userId, activeRun.outputSeq,
    );
    const activeFinal = await waitFor('active run terminal', async () => {
      const current = await runs.get(activeRun.runId);
      return current && MERI_HERMES_TERMINAL_STATUSES.has(current.status) ? current : null;
    });
    const activeEvents = await runs.eventsAfter(activeFinal.runId, 0, 'all');
    const snapshotTail = await runs.eventsAfter(activeFinal.runId, activeFinal.outputSeq, 'public');
    const outputSnapshotReplay = activeFinal.output.length > 0
      && activeFinal.outputSeq > 0
      && snapshotTail.every((event) => event.seq > activeFinal.outputSeq);

    const crossOwnerDenied = (await runs.requireOwned(activeFinal.runId, ctx.tenantId, otherUserId)) === null;
    const crossTenantDenied = (await runs.requireOwned(activeFinal.runId, randomUUID(), ctx.userId)) === null;

    // Explicit Stop: cancelling reaches a single terminal cancellation, never a later success.
    const stopConversation = await createConversation(prisma, ctx.tenantId, ctx.userId, 'explicit stop');
    const stopCollector = collector();
    const stopTurn = adapter.streamMessage(
      ctx, stopConversation, 'PROOF_STOP', stopCollector.sse, undefined,
      'new', [], undefined, undefined, randomUUID(),
    );
    const runningStop = await waitFor('stop run dispatch', async () => {
      const [candidate] = await runs.listForConversation(ctx.tenantId, ctx.userId, stopConversation);
      if (!candidate) return null;
      const current = await runs.get(candidate.runId);
      return current?.status === 'running' && current.hermesRunId ? current : null;
    });
    await adapter.requestStop(runningStop);
    await stopTurn;
    const stopFinal = await waitFor('stopped run terminal', async () => {
      const current = await runs.get(runningStop.runId);
      return current && MERI_HERMES_TERMINAL_STATUSES.has(current.status) ? current : null;
    });
    const stopEvents = await runs.eventsAfter(stopFinal.runId, 0, 'all');

    evidence = {
      schemaVersion: '1.0.0',
      environment: 'staging',
      tenantId: MERI_HERMES_STAGING_PROOF_TENANT_ID,
      startedAt,
      finishedAt: new Date().toISOString(),
      queued: {
        runId: queuedFinal.runId,
        terminalStatus: queuedFinal.status,
        detached: queuedFinal.detached,
        freshProcessReconnect: queuedFreshProcessReconnect,
        duplicateRetryReattached: queuedRuns.length === 1,
        oneRun: queuedRuns.length === 1,
        oneUserMessage: queuedUserMessages === 1,
        monotonicUniqueEvents: monotonicUnique(queuedEvents),
      },
      active: {
        runId: activeFinal.runId,
        terminalStatus: activeFinal.status,
        detached: activeFinal.detached,
        freshProcessReconnect: activeFreshProcessReconnect,
        outputSnapshotReplay,
        monotonicUniqueEvents: monotonicUnique(activeEvents),
      },
      authorization: { crossOwnerDenied, crossTenantDenied },
      stop: {
        runId: stopFinal.runId,
        terminalStatus: stopFinal.status,
        stopRequested: Boolean(stopFinal.stopRequestedAt),
        noSuccessAfterStop: stopFinal.status === 'cancelled'
          && !stopEvents.some((event) => event.kind === 'run.completed'),
      },
      disabledPath: { wrongTenantGateDenied, tenantFlagOffDenied },
    };
  } finally {
    await runtime.close().catch(() => undefined);
    await prisma.withSystem(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: MERI_HERMES_STAGING_PROOF_TENANT_ID } });
      if (tenant?.slug === MERI_HERMES_STAGING_PROOF_TENANT_SLUG) {
        await tx.tenant.delete({ where: { id: MERI_HERMES_STAGING_PROOF_TENANT_ID } });
      }
      if (primaryUserId || otherUserId) {
        await tx.user.deleteMany({ where: { id: { in: [primaryUserId, otherUserId].filter(Boolean) } } });
      }
      syntheticTenantDeleted = (await tx.tenant.findUnique({
        where: { id: MERI_HERMES_STAGING_PROOF_TENANT_ID },
        select: { id: true },
      })) === null;
    }).catch(() => {
      syntheticTenantDeleted = false;
    });
    await prisma.$disconnect();
  }
  if (!evidence) throw new Error('Continuity proof did not produce evidence');
  const finalEvidence: MeriHermesStagingProofEvidence = {
    ...evidence,
    cleanup: { syntheticTenantDeleted },
  };
  assertMeriHermesStagingProofEvidence(finalEvidence);
  process.stdout.write(`MERI_HERMES_STAGING_PROOF=${JSON.stringify(finalEvidence)}\n`);
}

void (process.argv[2] === '--reattach' ? reattachChild() : runProof()).catch((error) => {
  process.stderr.write(`Meri Hermes staging continuity proof failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
