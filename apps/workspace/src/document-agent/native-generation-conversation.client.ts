import { Logger } from '@nestjs/common';
import { nativeGenerationSourceWire } from './native-generation-source.js';
import type {
  NativeGenerationResult,
  NativeGenerationTurnOutcome,
  NativeGenerationTurnPort,
  NativeGenerationTurnRequest,
  NativeGenerationTurnSubject,
} from './native-generation.bridge.js';

/**
 * The HTTP adapter from the Workspace document-agent to the approved greenfield
 * Meri native conversation owner.
 *
 * It is the ONLY production caller of a supported generated phase: the private
 * route it reaches is served by `apps/control/conversations/workspace-generation`
 * on the Meri control's protected listener, which issues one canonical
 * conversation turn on the existing conversation owner. This class is a thin
 * transport adapter — it holds no queue, no journal and no model, and it never
 * falls back to the retired `WorkspaceReasoningGateway` / `GenerationService`
 * owners.
 *
 * Authority: the CURRENT authenticated session credential travels in the
 * `authorization` header of every call and the native owner verifies it itself.
 * This adapter never derives tenant, actor or client authority from a body, and
 * the client scope it sends is the draft's canonical binding, which the owner
 * checks against the credential's own current context.
 *
 * Transport trust is the existing Core service secret, the same private-call
 * convention the API's approval-metadata verifier already uses.
 */
export type NativeGenerationOwnerErrorCode =
  | 'unavailable'
  | 'refused'
  | 'authority'
  | 'conflict'
  | 'output';

/** A refusal or transport failure reported by the native conversation owner. */
export class NativeGenerationOwnerError extends Error {
  constructor(readonly code: NativeGenerationOwnerErrorCode, readonly status: number, message: string) {
    super(message);
    this.name = 'NativeGenerationOwnerError';
  }
}

export type NativeGenerationConversationClientOptions = {
  /** The private control origin, e.g. https://control.internal.example. */
  origin: string;
  /** The existing Core service secret presented on the private listener. */
  serviceSecret: string;
  /** Whole-call bound. One turn is one bounded observation window. */
  timeoutMs?: number;
  /** Test seam: the fetch implementation. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

const WORKSPACE_GENERATION_PATHS = {
  turn: '/v1/internal/workspace-generation/turn',
  read: '/v1/internal/workspace-generation/read',
  cancel: '/v1/internal/workspace-generation/cancel',
} as const;
const SCHEMA_VERSION = 1;
const STATUS_BY_CODE: Record<string, NativeGenerationOwnerErrorCode> = {
  WORKSPACE_GENERATION_UNAVAILABLE: 'unavailable',
  WORKSPACE_GENERATION_REFUSED: 'refused',
  WORKSPACE_GENERATION_AUTHORITY_REFUSED: 'authority',
  WORKSPACE_GENERATION_SCOPE_REFUSED: 'authority',
  WORKSPACE_GENERATION_REQUEST_REFUSED: 'conflict',
  WORKSPACE_GENERATION_OUTPUT_REFUSED: 'output',
  WORKSPACE_GENERATION_UNKNOWN: 'unavailable',
  WORKSPACE_GENERATION_DEADLINE: 'unavailable',
};

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';

/** The origin must be https; plain http is accepted only for loopback hosts. */
export function nativeGenerationOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
    throw new Error('NATIVE_GENERATION_ORIGIN must be https (http is accepted for loopback only).');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('NATIVE_GENERATION_ORIGIN must be a bare origin.');
  return url;
}

type WireOutcome =
  | { status: 'complete'; runId: string; result: NativeGenerationResult }
  | { status: 'approval_required'; runId: string; proposalId: string }
  | { status: 'failed'; runId: string; state: string }
  | { status: 'unknown'; requestId: string };

/**
 * Validate a wire outcome at the runtime boundary. A response body is
 * unvalidated wire input: an unknown status, a missing id or a field of the
 * wrong type is malformed (null) rather than a value that gets cast into a typed
 * outcome. `result` is validated structurally here and narrowed per phase by the
 * bridge, which owns the closed per-phase result shapes.
 */
function parseWireOutcome(value: unknown): WireOutcome | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const outcome = value as Record<string, unknown>;
  const status = outcome.status;
  const identified = (candidate: unknown): candidate is string => typeof candidate === 'string' && candidate.length > 0;
  if (status === 'unknown') {
    const requestId = outcome.requestId;
    return identified(requestId) ? { status: 'unknown', requestId } : null;
  }
  const runId = outcome.runId;
  if (!identified(runId)) return null;
  if (status === 'complete') {
    const result = outcome.result;
    return result !== null && typeof result === 'object' && !Array.isArray(result)
      ? { status: 'complete', runId, result: result as NativeGenerationResult }
      : null;
  }
  if (status === 'approval_required') {
    const proposalId = outcome.proposalId;
    return identified(proposalId) ? { status: 'approval_required', runId, proposalId } : null;
  }
  if (status === 'failed') {
    const state = outcome.state;
    return identified(state) ? { status: 'failed', runId, state } : null;
  }
  return null;
}

export class NativeGenerationConversationClient implements NativeGenerationTurnPort {
  private readonly log = new Logger(NativeGenerationConversationClient.name);
  private readonly origin: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: NativeGenerationConversationClientOptions) {
    this.origin = nativeGenerationOrigin(options.origin);
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.serviceSecret = options.serviceSecret;
    if (this.serviceSecret.length < 16) throw new Error('The native generation service secret is missing or too short.');
  }

  private readonly serviceSecret: string;

  async turn(
    request: NativeGenerationTurnRequest,
    options: { credential: string; signal?: AbortSignal },
  ): Promise<NativeGenerationTurnOutcome> {
    const body = await this.post(WORKSPACE_GENERATION_PATHS.turn, wireTurn(request), options.credential, options.signal);
    const outcome = parseWireOutcome(body?.outcome);
    if (outcome === null) throw this.malformed('turn');
    return toTurnOutcome(outcome, request.requestId);
  }

  async readTurn(request: NativeGenerationTurnRequest, credential: string): Promise<NativeGenerationTurnOutcome | null> {
    const body = await this.post(WORKSPACE_GENERATION_PATHS.read, wireTurn(request), credential);
    // `outcome: null` is the owner's own explicit answer that the retained
    // request is not the one it holds; anything else is wire input and is
    // validated before it becomes a typed outcome.
    if (body.outcome === null) return null;
    const outcome = parseWireOutcome(body.outcome);
    if (outcome === null) throw this.malformed('read');
    return toTurnOutcome(outcome, request.requestId);
  }

  async cancel(subject: NativeGenerationTurnSubject, credential: string): Promise<void> {
    const body = await this.post(WORKSPACE_GENERATION_PATHS.cancel, wireSubject(subject), credential);
    if (typeof body.state !== 'string') throw this.malformed('cancel');
  }

  private async post(
    path: string,
    request: Record<string, unknown>,
    credential: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!credential) throw new NativeGenerationOwnerError('refused', 400, 'The current authenticated session credential is required.');
    const aborter = new AbortController();
    const timer = setTimeout(() => aborter.abort(), this.timeoutMs);
    const onAbort = () => aborter.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.origin), {
        method: 'POST',
        redirect: 'error',
        signal: aborter.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credential}`,
          'x-internal-service-secret': this.serviceSecret,
        },
        body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, request }),
      });
    } catch (error) {
      this.log.warn(`native generation ${path} transport failure: ${(error as Error).message}`);
      throw new NativeGenerationOwnerError('unavailable', 503, 'The native conversation owner is unreachable.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    const text = await response.text();
    if (text.length > 1_048_576) throw this.malformed(path);
    let body: Record<string, unknown> = {};
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw this.malformed(path);
      }
    }
    if (!response.ok) {
      const code = (body.error as { code?: string } | undefined)?.code;
      throw new NativeGenerationOwnerError(
        STATUS_BY_CODE[code ?? ''] ?? 'unavailable',
        response.status,
        `The native conversation owner refused the ${path} call (${code ?? response.status}).`,
      );
    }
    if (body.schemaVersion !== SCHEMA_VERSION) throw this.malformed(path);
    return body;
  }

  private malformed(path: string): NativeGenerationOwnerError {
    this.log.warn(`native generation ${path} returned a malformed response`);
    return new NativeGenerationOwnerError('unavailable', 502, 'The native conversation owner returned a malformed response.');
  }
}

/** Build the adapter from the deployment's environment, or null when unconfigured. */
export function nativeGenerationClientFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): NativeGenerationConversationClient | null {
  const origin = env.NATIVE_GENERATION_ORIGIN ?? env.MERI_CONTROL_ORIGIN;
  const serviceSecret = env.INTERNAL_SERVICE_SECRET ?? env.MERI_CONTROL_SERVICE_SECRET;
  if (origin === undefined || origin === '' || serviceSecret === undefined || serviceSecret === '') return null;
  return new NativeGenerationConversationClient({ origin, serviceSecret, ...(fetchImpl === undefined ? {} : { fetchImpl }) });
}

/** Exact selected sources are evidence; current credentials still own authority. */
function wireTurn(request: NativeGenerationTurnRequest): Record<string, unknown> {
  return {
    ...wireSubject(request),
    phase: request.phase,
    expectedRevision: request.expectedRevision,
    paidGeneration: true,
    sources: request.sources.map(nativeGenerationSourceWire),
    ...(request.writingBrief === undefined ? {} : { writingBrief: request.writingBrief }),
  };
}

/** The exact retained request identity a read or cancel addresses. */
function wireSubject(subject: NativeGenerationTurnSubject): Record<string, unknown> {
  return {
    requestId: subject.requestId,
    tenantId: subject.tenantId,
    actorId: subject.actorId,
    draftId: subject.draftId,
    clientId: subject.clientId,
    ...(subject.runId === undefined ? {} : { runId: subject.runId }),
  };
}

function toTurnOutcome(outcome: WireOutcome, requestId: string): NativeGenerationTurnOutcome {
  switch (outcome.status) {
    case 'complete':
      return { status: 'complete', runId: outcome.runId, result: outcome.result };
    case 'approval_required':
      return { status: 'approval_required', runId: outcome.runId, proposalId: outcome.proposalId };
    case 'failed':
      return { status: 'failed', runId: outcome.runId, state: outcome.state };
    case 'unknown':
      return { status: 'unknown', requestId: outcome.requestId ?? requestId };
    default:
      throw new NativeGenerationOwnerError('unavailable', 502, 'The native conversation owner returned an unknown outcome.');
  }
}
