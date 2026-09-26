/**
 * HTTP client for the pinned Hermes Agent API server (gateway platform
 * `api_server`, build v2026.9.14 / 0.21.3). Uses only documented, verified
 * surfaces: /v1/capabilities, /v1/toolsets, /v1/skills, /v1/runs (+events,
 * stop, approval, steer), /api/sessions. It deliberately does NOT use
 * /v1/chat/completions: Hermes owns its own agent loop and must not be driven
 * as an ordinary model provider.
 *
 * Environment (names only): MERI_HERMES_RUNTIME_URL, MERI_HERMES_API_KEY,
 * MERI_HERMES_TOOL_VIEW_SIGNING_KEY, MERI_HERMES_REQUEST_TIMEOUT_MS.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { meriHermesRuntimeConfig } from '../../common/meri-hermes-flags.js';
import {
  hermesWireCapabilitiesSchema,
  hermesWireEventSchema,
  hermesWireRunAcceptedSchema,
  hermesWireRunStatusSchema,
  type HermesWireEvent,
  type HermesWireRunStatus,
} from './hermes-runtime.contracts.js';
import {
  MERI_HERMES_WORKER_RESOLVER,
  type MeriHermesWorkerResolverPort,
  type MeriHermesWorkerScopeRef,
} from './meri-hermes-worker-resolver.port.js';
import {
  computeMeriHermesObservedToolDigestsV1,
  isCompiledMeriHermesToolViewV1,
  MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1,
  MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1,
  type MeriHermesToolViewV1,
  type MeriHermesToolSchemaV1,
} from './meri-hermes-tool-view.js';
import { meriDispatchCanonicalJsonSnapshot } from './meri-hermes-dispatch-intent.contract.js';

export interface HermesCreateRunInput {
  input: string;
  /** Continue an existing Hermes session (conversation binding). */
  sessionId?: string | null;
  /** Long-term memory scope key (`X-Hermes-Session-Key`). */
  sessionKey?: string | null;
  idempotencyKey?: string | null;
  /** Ephemeral system-prompt instructions for this turn (governed context). */
  instructions?: string | null;
  model?: string | null;
  provider?: string | null;
  modelOptions?: Record<string, unknown> | null;
}

export interface HermesCreateRunResult {
  runId: string;
  status: string;
  sessionId: string | null;
  replayed: boolean;
}

export class HermesRuntimeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

type ErrorBody = { error?: { message?: string; code?: string } } | null;

@Injectable()
export class MeriHermesRuntimeClient {
  private readonly logger = new Logger(MeriHermesRuntimeClient.name);
  // Not constructor parameters: Nest would try to inject them by type.
  private env: NodeJS.ProcessEnv = process.env;
  private fetchImpl: typeof fetch = fetch;

  /**
   * Optional: the Phase 1 worker lifecycle service (injected by token, not by
   * concrete class — see meri-hermes-worker-resolver.port.ts's doc for why
   * this avoids a circular class dependency). `@Optional()` because a client
   * built via `withEnv()` (every test double, and the resolved-runtime client
   * `forScope()` itself returns) has no resolver and does not need one.
   */
  constructor(
    @Optional()
    @Inject(MERI_HERMES_WORKER_RESOLVER)
    private readonly resolver?: MeriHermesWorkerResolverPort,
  ) {}

  /** Test seam: a client bound to a specific environment and fetch implementation. */
  static withEnv(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): MeriHermesRuntimeClient {
    const client = new MeriHermesRuntimeClient();
    client.env = env;
    client.fetchImpl = fetchImpl;
    return client;
  }

  /**
   * One worker per execution scope.
   *
   * Local/harness override (unchanged from Phase 0, explicit opt-in): if
   * `MERI_HERMES_SCOPE_RUNTIMES` (JSON `{ "<executionScopeId>": {"url","apiKey"} }`)
   * is set, resolve from that static map instead of provisioning anything —
   * this keeps `scripts/meri-hermes/phase0-harness.mjs` working unmodified
   * against a single locally-run worker container with no AWS/Prisma
   * dependency. The env var itself IS the explicit flag: nobody sets it by
   * accident, and production task definitions never set it.
   *
   * Otherwise (Phase 1): ask the injected `MeriHermesWorkerResolverPort` (the
   * worker lifecycle service in production) to find-or-provision the scope's
   * worker on demand. If no resolver is wired at all (e.g. a bare
   * `new MeriHermesRuntimeClient()` in a unit test), fall back to the single
   * default runtime configured by `MERI_HERMES_RUNTIME_URL` — the same
   * behaviour Phase 0 had for a scope with no map entry.
   */
  async forScope(scope: MeriHermesWorkerScopeRef): Promise<MeriHermesRuntimeClient> {
    const raw = this.env.MERI_HERMES_SCOPE_RUNTIMES?.trim();
    if (raw) {
      let map: Record<string, { url?: string; apiKey?: string }> = {};
      try {
        map = JSON.parse(raw) as Record<string, { url?: string; apiKey?: string }>;
      } catch {
        this.logger.warn('MERI_HERMES_SCOPE_RUNTIMES is not valid JSON; using the default runtime');
        return this;
      }
      const entry = map[scope.executionScopeId] ?? map[scope.executionScopeId.toLowerCase()];
      if (!entry?.url) return this;
      return MeriHermesRuntimeClient.withEnv(
        {
          ...this.env,
          MERI_HERMES_RUNTIME_URL: entry.url,
          ...(entry.apiKey ? { MERI_HERMES_API_KEY: entry.apiKey } : {}),
        },
        this.fetchImpl,
      );
    }
    if (!this.resolver) return this;
    const resolved = await this.resolver.resolveWorker(scope);
    return MeriHermesRuntimeClient.withEnv(
      { ...this.env, MERI_HERMES_RUNTIME_URL: resolved.url },
      this.fetchImpl,
    );
  }

  get configured(): boolean {
    const cfg = meriHermesRuntimeConfig(this.env);
    return Boolean(cfg.runtimeUrl && cfg.apiKeyConfigured);
  }

  private get baseUrl(): string {
    const url = meriHermesRuntimeConfig(this.env).runtimeUrl;
    if (!url) throw new Error('MERI_HERMES_RUNTIME_URL is not configured');
    return url;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const key = this.env.MERI_HERMES_API_KEY?.trim();
    if (!key) throw new Error('MERI_HERMES_API_KEY is not configured');
    return { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extra };
  }

  private timeoutSignal(): AbortSignal {
    return AbortSignal.timeout(meriHermesRuntimeConfig(this.env).requestTimeoutMs);
  }

  private async json<T>(
    path: string,
    init: RequestInit & { parse?: (v: unknown) => T } = {},
  ): Promise<T> {
    const { parse, ...rest } = init;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...rest,
      headers: this.headers((rest.headers as Record<string, string> | undefined) ?? {}),
      signal: rest.signal ?? this.timeoutSignal(),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    if (!response.ok) {
      const err = (body as ErrorBody)?.error;
      throw new HermesRuntimeHttpError(
        response.status,
        err?.code ?? null,
        err?.message ?? `Hermes ${path} failed: ${response.status}`,
      );
    }
    return parse ? parse(body) : (body as T);
  }

  async health(): Promise<{ ok: boolean; status: number; body: unknown }> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        signal: this.timeoutSignal(),
      });
      const body = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      return { ok: false, status: 0, body: { error: String(error) } };
    }
  }

  async capabilities(): Promise<ReturnType<typeof hermesWireCapabilitiesSchema.parse>> {
    return this.json('/v1/capabilities', { parse: (v) => hermesWireCapabilitiesSchema.parse(v) });
  }

  async toolsets(): Promise<unknown> {
    return this.json('/v1/toolsets');
  }

  async skills(): Promise<unknown> {
    return this.json('/v1/skills');
  }

  async createRun(input: HermesCreateRunInput): Promise<HermesCreateRunResult> {
    return this.createRunBody(input);
  }

  private async createRunBody(
    input: HermesCreateRunInput,
    extra: Record<string, unknown> = {},
  ): Promise<HermesCreateRunResult> {
    const headers: Record<string, string> = {};
    if (input.sessionKey) headers['X-Hermes-Session-Key'] = input.sessionKey;
    if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
    const body: Record<string, unknown> = { input: input.input, ...extra };
    if (input.sessionId) body.session_id = input.sessionId;
    if (input.instructions) body.instructions = input.instructions;
    if (input.model) body.model = input.model;
    if (input.provider) body.provider = input.provider;
    if (input.modelOptions) body.model_options = input.modelOptions;
    const response = await this.fetchImpl(`${this.baseUrl}/v1/runs`, {
      method: 'POST',
      headers: this.headers(headers),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const err = (parsed as ErrorBody)?.error;
      throw new HermesRuntimeHttpError(
        response.status,
        err?.code ?? null,
        err?.message ?? `Hermes /v1/runs failed: ${response.status}`,
      );
    }
    const accepted = hermesWireRunAcceptedSchema.parse(parsed);
    return {
      runId: accepted.run_id,
      status: accepted.status ?? 'started',
      sessionId: accepted.session_id ?? response.headers.get('x-hermes-session-id') ?? null,
      replayed: response.headers.get('idempotency-replayed') === 'true',
    };
  }

  /** Opt-in prototype transport; an unextended worker never receives a view. */
  async createRunWithToolView(
    input: HermesCreateRunInput,
    view: MeriHermesToolViewV1,
  ): Promise<HermesCreateRunResult> {
    const unsupported = () => new HermesRuntimeHttpError(
      501, 'request_local_tool_view_unsupported',
      'Hermes request-local tool-view v1 is not enabled and advertised',
    );
    if (this.env.MERI_HERMES_TOOL_VIEW_V1_CLIENT_ENABLED !== '1') throw unsupported();
    let inputSnapshot: HermesCreateRunInput;
    try {
      inputSnapshot = Object.freeze({
        input: input.input,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        idempotencyKey: input.idempotencyKey,
        instructions: input.instructions,
        model: input.model,
        provider: input.provider,
        modelOptions: input.modelOptions == null
          ? input.modelOptions
          : meriDispatchCanonicalJsonSnapshot(input.modelOptions),
      });
    } catch {
      throw new HermesRuntimeHttpError(
        400, 'invalid_tool_view_run_input', 'Invalid request-local tool-view run input',
      );
    }
    // A narrowed run must have a stable replay identity. This is not the
    // durable dispatch snapshot needed for lost-response retries, but it
    // prevents this opt-in method from launching without an idempotency key.
    if (typeof inputSnapshot.input !== 'string' ||
        typeof inputSnapshot.idempotencyKey !== 'string' ||
        !inputSnapshot.idempotencyKey.trim()) {
      throw new HermesRuntimeHttpError(400, 'tool_view_idempotency_required',
        'A request-local tool view requires an idempotency key');
    }
    const capabilities = await this.capabilities();
    const idempotency = capabilities.features?.runs_idempotency;
    if (!idempotency || typeof idempotency !== 'object') throw unsupported();
    const replayContract = idempotency as {
      supported?: unknown; durable?: unknown; retention_seconds?: unknown;
    };
    if (replayContract.supported !== true || replayContract.durable !== true ||
        typeof replayContract.retention_seconds !== 'number' ||
        !Number.isSafeInteger(replayContract.retention_seconds) ||
        replayContract.retention_seconds < 86_400) {
      throw unsupported();
    }
    const feature = capabilities.features?.meri_request_local_tool_view_v1;
    if (!feature || typeof feature !== 'object' || (feature as { supported?: unknown }).supported !== true) {
      throw unsupported();
    }
    const advertised = feature as {
      worker_catalog_sha256?: unknown;
      worker_catalog_schemas?: unknown;
      worker_catalog_digest_algorithm?: unknown;
      applied_tool_view_digest_algorithm?: unknown;
    };
    const workerCatalog = advertised.worker_catalog_sha256;
    if (typeof workerCatalog !== 'string' || !/^[0-9a-f]{64}$/.test(workerCatalog) ||
        advertised.worker_catalog_digest_algorithm !==
          MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1 ||
        advertised.applied_tool_view_digest_algorithm !==
          MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1) {
      throw unsupported();
    }
    const key = this.env.MERI_HERMES_TOOL_VIEW_SIGNING_KEY?.trim();
    if (!key || key.length < 32) throw unsupported();
    if (!isCompiledMeriHermesToolViewV1(view) || view.version !== 1 || !view.catalogVersion ||
        !view.requiredToolNames.every((name) => view.toolNames.includes(name))) {
      throw new HermesRuntimeHttpError(400, 'invalid_tool_view', 'Invalid request-local tool view');
    }
    if (!Array.isArray(advertised.worker_catalog_schemas)) throw unsupported();
    const selected = new Set(view.toolNames);
    const applied = advertised.worker_catalog_schemas.filter((schema) => {
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
      const fn = (schema as { function?: unknown }).function;
      if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return false;
      const name = (fn as { name?: unknown }).name;
      return typeof name === 'string' && selected.has(name);
    });
    let observed: Readonly<{ catalogDigest: string; toolViewDigest: string }>;
    try {
      observed = computeMeriHermesObservedToolDigestsV1(
        advertised.worker_catalog_schemas as MeriHermesToolSchemaV1[],
        applied as MeriHermesToolSchemaV1[],
      );
    } catch {
      throw unsupported();
    }
    if (workerCatalog !== view.catalogDigest || observed.catalogDigest !== workerCatalog ||
        observed.toolViewDigest !== view.toolViewDigest) throw unsupported();
    const payload = {
      version: 1,
      catalog_version: view.catalogVersion,
      worker_catalog_sha256: view.catalogDigest,
      worker_catalog_digest_algorithm: MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1,
      applied_tool_view_sha256: view.toolViewDigest,
      applied_tool_view_digest_algorithm: MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1,
      tool_names: view.toolNames,
      required_tool_names: view.requiredToolNames,
      expires_at: Math.floor(Date.now() / 1000) + 60,
      input_sha256: createHash('sha256').update(inputSnapshot.input).digest('hex'),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = {
      payload: encoded,
      signature: createHmac('sha256', key).update(encoded).digest('hex'),
    };
    return this.createRunBody(inputSnapshot, { meri_tool_view_v1: token });
  }

  async getRun(runId: string): Promise<HermesWireRunStatus> {
    return this.json(`/v1/runs/${encodeURIComponent(runId)}`, {
      parse: (v) => hermesWireRunStatusSchema.parse(v),
    });
  }

  async stopRun(runId: string): Promise<unknown> {
    return this.json(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST', body: '{}' });
  }

  async resolveApproval(
    runId: string,
    choice: 'once' | 'deny',
    requestId: string | null,
  ): Promise<unknown> {
    return this.json(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: 'POST',
      body: JSON.stringify(requestId ? { choice, request_id: requestId } : { choice }),
    });
  }

  async steerRun(runId: string, text: string): Promise<boolean> {
    const result = await this.json<{ accepted?: boolean }>(
      `/v1/runs/${encodeURIComponent(runId)}/steer`,
      { method: 'POST', body: JSON.stringify({ input: text }) },
    );
    return result?.accepted === true;
  }

  async sessionMessages(sessionId: string): Promise<unknown> {
    return this.json(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
  }

  async forkSession(sessionId: string): Promise<unknown> {
    return this.json(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {
      method: 'POST',
      body: '{}',
    });
  }

  /**
   * Stream `/v1/runs/{id}/events`. Resolves when Hermes closes the stream (a
   * terminal event followed by `: stream closed`) or the signal aborts. The
   * caller owns the signal; passing a signal NOT tied to the browser connection
   * is how Meri keeps consuming after a browser detach.
   */
  async streamRunEvents(
    runId: string,
    // May return a Promise: the adapter's translated-event handling now goes
    // through the (Prisma-backed, Phase 1) async MeriHermesRunRepository, and
    // it is awaited below so DB writes for successive wire events stay
    // strictly ordered (e.g. the atomic seq allocation in append()) instead
    // of racing across concurrent, un-awaited callback invocations.
    onEvent: (event: HermesWireEvent) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`,
      { headers: this.headers({ accept: 'text/event-stream' }), signal },
    );
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => response.statusText);
      throw new HermesRuntimeHttpError(
        response.status,
        null,
        `Hermes run event stream failed: ${response.status} ${detail.slice(0, 240)}`,
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue; // keepalive comments start with ':'
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const parsed = hermesWireEventSchema.parse(JSON.parse(payload));
          await onEvent(parsed as HermesWireEvent);
        } catch (error) {
          this.logger.debug(
            `Hermes event stream: skipped unparseable frame (${String(error).slice(0, 120)})`,
          );
        }
      }
    }
  }
}
