import { createHash, randomBytes, randomUUID } from 'node:crypto';

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|sha256:[0-9a-f]{64})$/i;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,79}$/;
const MAX_TOOLS = 64;
const MAX_REFS = 32;
const MAX_EVENT_BYTES = 16_384;

export interface MeriTelemetryContext {
  readonly version: 1;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly requestId: string;
  readonly browserRequestId: string | null;
  readonly callerTraceId: string | null;
  readonly tenantId: string;
  readonly actorId: string;
  readonly conversationId: string | null;
  readonly serverTurnId: string;
  readonly runId: string;
  readonly release: string | null;
}

export interface MeriTelemetryUsage {
  readonly status: 'known' | 'partial' | 'unknown';
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  /** Known subtotal. Null when no provider reported usage. */
  readonly knownEstimatedCostUsd: number | null;
  /** Attempts whose provider usage/cost could not be observed. */
  readonly unknownAttempts: number;
  readonly owner: 'AiUsageEvent';
}

export interface MeriTelemetrySourceRef {
  readonly sourceId: string;
  readonly version?: string | null;
  readonly hash?: string | null;
  readonly tool?: string | null;
}

export interface MeriTelemetryEventInput {
  readonly name: string;
  readonly boundary:
    | 'browser_api'
    | 'api_orchestrator'
    | 'orchestrator_provider'
    | 'orchestrator_tool'
    | 'api_tool'
    | 'api_proposal'
    | 'turn';
  readonly spanId?: string;
  readonly parentSpanId?: string | null;
  readonly stepId?: string | null;
  readonly childRunId?: string | null;
  readonly goalRevision?: string | number | null;
  readonly clientId?: string | null;
  readonly runtime?: string | null;
  readonly provider?: string | null;
  readonly configIdentity?: string | null;
  readonly requestedModel?: string | null;
  readonly effectiveModel?: string | null;
  readonly selectedTools?: readonly string[];
  readonly exposedTools?: readonly string[];
  readonly invokedTools?: readonly string[];
  readonly sourceRefs?: readonly MeriTelemetrySourceRef[];
  readonly proposalId?: string | null;
  readonly operationId?: string | null;
  readonly artifactIds?: readonly string[];
  readonly attempt?: number;
  readonly retry?: boolean;
  readonly outcome?: string;
  readonly durationMs?: number;
  readonly usage?: MeriTelemetryUsage;
  readonly integrationDependencies?: readonly string[];
  readonly at?: string;
}

export interface MeriTelemetryEvent {
  readonly event: 'meri.telemetry';
  readonly schemaVersion: 1;
  readonly name: string;
  readonly boundary: MeriTelemetryEventInput['boundary'];
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly requestId: string;
  readonly browserRequestId: string | null;
  readonly callerTraceId: string | null;
  readonly tenantId: string;
  readonly actorId: string;
  readonly conversationId: string | null;
  readonly serverTurnId: string;
  readonly runId: string;
  readonly release: string | null;
  readonly at: string;
  readonly [key: string]: unknown;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** Retain canonical IDs; hash other explicit identifiers to avoid logging labels. */
export function meriTelemetryIdentifier(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return null;
  if (UUID.test(value) || DIGEST.test(value)) return value.toLowerCase();
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

const opaque = meriTelemetryIdentifier;

function enumValue(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const bounded = value.trim().slice(0, max);
  return /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(bounded) ? bounded : null;
}

export function meriCallerTraceId(traceparent: unknown): string | null {
  if (typeof traceparent !== 'string') return null;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(0[01])$/i.exec(traceparent.trim());
  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return null;
  return match[1]!.toLowerCase();
}

/**
 * Browser ids and traceparent are linkage only. Server trace/run/turn identities
 * are always fresh and actor/tenant authority always comes from authenticated context.
 */
export function createMeriTelemetryContext(input: {
  tenantId: string;
  actorId: string;
  conversationId?: string | null;
  browserRequestId?: unknown;
  callerTraceparent?: unknown;
  release?: string | null;
}): MeriTelemetryContext {
  return {
    version: 1,
    traceId: hex(16),
    spanId: hex(8),
    parentSpanId: null,
    requestId: randomUUID(),
    browserRequestId: opaque(input.browserRequestId),
    callerTraceId: meriCallerTraceId(input.callerTraceparent),
    tenantId: opaque(input.tenantId) ?? 'invalid-tenant',
    actorId: opaque(input.actorId) ?? 'invalid-actor',
    conversationId: opaque(input.conversationId) ?? null,
    serverTurnId: randomUUID(),
    runId: randomUUID(),
    release: opaque(input.release) ?? null,
  };
}

/** Accept only API-authored metadata that agrees with the authenticated identity. */
export function admitMeriTelemetryContext(
  value: unknown,
  identity: { tenantId: string; actorId: string; conversationId?: string | null },
): MeriTelemetryContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Partial<MeriTelemetryContext>;
  if (
    item.version !== 1 ||
    !opaque(identity.tenantId) ||
    !opaque(identity.actorId) ||
    !TRACE_ID.test(String(item.traceId ?? '')) ||
    !SPAN_ID.test(String(item.spanId ?? '')) ||
    opaque(item.tenantId) !== opaque(identity.tenantId) ||
    opaque(item.actorId) !== opaque(identity.actorId) ||
    opaque(item.conversationId) !== opaque(identity.conversationId)
  )
    return null;
  const required = [item.requestId, item.serverTurnId, item.runId].map(opaque);
  if (required.some((part) => part === null)) return null;
  return {
    version: 1,
    traceId: String(item.traceId),
    spanId: String(item.spanId),
    parentSpanId: SPAN_ID.test(String(item.parentSpanId ?? '')) ? String(item.parentSpanId) : null,
    requestId: required[0]!,
    browserRequestId: opaque(item.browserRequestId),
    callerTraceId: TRACE_ID.test(String(item.callerTraceId ?? ''))
      ? String(item.callerTraceId)
      : null,
    tenantId: opaque(identity.tenantId)!,
    actorId: opaque(identity.actorId)!,
    conversationId: opaque(identity.conversationId),
    serverTurnId: required[1]!,
    runId: required[2]!,
    release: opaque(item.release),
  };
}

export function meriTelemetryChildSpanId(): string {
  return hex(8);
}

export function meriTelemetryTraceparent(
  context: MeriTelemetryContext,
  spanId = context.spanId,
): string {
  return `00-${context.traceId}-${SPAN_ID.test(spanId) ? spanId : context.spanId}-01`;
}

export function meriTelemetryConfigIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Read explicit operation identities only; never infer them from generic result IDs. */
export function meriTelemetryOperationId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['operationId', 'operationKey']) {
    const candidate = opaque(record[key]);
    if (candidate) return candidate;
  }
  for (const key of ['operation', 'executionResult', 'result']) {
    const nested = record[key];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
    const nestedRecord = nested as Record<string, unknown>;
    const fields =
      key === 'operation' ? ['operationId', 'operationKey', 'id'] : ['operationId', 'operationKey'];
    for (const field of fields) {
      const candidate = opaque(nestedRecord[field]);
      if (candidate) return candidate;
    }
  }
  return null;
}

export function meriTelemetryUsage(input?: {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  knownEstimatedCostUsd?: number | null;
  unknownAttempts?: number;
}): MeriTelemetryUsage {
  const finite = (value: number | null | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const unknownAttempts = Math.floor(finite(input?.unknownAttempts) ?? 0);
  const tokens = (value: number | null | undefined): number | null =>
    Number.isSafeInteger(value) ? finite(value) : null;
  const inputTokens = tokens(input?.inputTokens);
  const outputTokens = tokens(input?.outputTokens);
  const hasKnown = inputTokens !== null || outputTokens !== null;
  const knownEstimatedCostUsd = finite(input?.knownEstimatedCostUsd);
  return {
    status: hasKnown
      ? unknownAttempts ||
        inputTokens === null ||
        outputTokens === null ||
        knownEstimatedCostUsd === null
        ? 'partial'
        : 'known'
      : 'unknown',
    inputTokens,
    outputTokens,
    cacheReadTokens: tokens(input?.cacheReadTokens),
    cacheCreationTokens: tokens(input?.cacheCreationTokens),
    knownEstimatedCostUsd,
    unknownAttempts,
    owner: 'AiUsageEvent',
  };
}

function tools(values: readonly string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return [
    ...new Set(values.map((value) => (TOOL_NAME.test(value) ? value : 'unknown_tool'))),
  ].slice(0, MAX_TOOLS);
}

/** Only project identifiers and metadata; never serialize source content. */
function sourceRefs(
  values: readonly MeriTelemetrySourceRef[] | undefined,
): MeriTelemetrySourceRef[] | undefined {
  if (!Array.isArray(values)) return undefined;
  return values.slice(0, MAX_REFS).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const sourceId = opaque(value.sourceId);
    if (!sourceId) return [];
    return [
      {
        sourceId,
        version: opaque(value.version),
        hash:
          typeof value.hash === 'string' && /^[0-9a-f]{64}$/i.test(value.hash)
            ? value.hash.toLowerCase()
            : null,
        tool:
          value.tool && TOOL_NAME.test(value.tool)
            ? value.tool
            : value.tool
              ? 'unknown_tool'
              : null,
      },
    ];
  });
}

function goalRevision(value: unknown): number | null {
  const candidate = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0
    ? candidate
    : null;
}

export function buildMeriTelemetryEvent(
  context: MeriTelemetryContext,
  input: MeriTelemetryEventInput,
): MeriTelemetryEvent {
  const event: MeriTelemetryEvent = {
    event: 'meri.telemetry',
    schemaVersion: 1,
    name: enumValue(input.name) ?? 'invalid_event',
    boundary: input.boundary,
    traceId: context.traceId,
    spanId: SPAN_ID.test(input.spanId ?? '') ? input.spanId! : context.spanId,
    parentSpanId: SPAN_ID.test(input.parentSpanId ?? '')
      ? input.parentSpanId!
      : context.parentSpanId,
    requestId: context.requestId,
    browserRequestId: context.browserRequestId,
    callerTraceId: context.callerTraceId,
    tenantId: context.tenantId,
    actorId: context.actorId,
    conversationId: context.conversationId,
    serverTurnId: context.serverTurnId,
    runId: context.runId,
    release: context.release,
    at: input.at ?? new Date().toISOString(),
    ...(opaque(input.stepId) ? { stepId: opaque(input.stepId) } : {}),
    ...(opaque(input.childRunId) ? { childRunId: opaque(input.childRunId) } : {}),
    ...(goalRevision(input.goalRevision) !== null
      ? { goalRevision: goalRevision(input.goalRevision) }
      : {}),
    ...(opaque(input.clientId) ? { clientId: opaque(input.clientId) } : {}),
    ...(enumValue(input.runtime) ? { runtime: enumValue(input.runtime) } : {}),
    ...(enumValue(input.provider) ? { provider: enumValue(input.provider) } : {}),
    ...(opaque(input.configIdentity) ? { configIdentity: opaque(input.configIdentity) } : {}),
    ...(enumValue(input.requestedModel) ? { requestedModel: enumValue(input.requestedModel) } : {}),
    ...(enumValue(input.effectiveModel) ? { effectiveModel: enumValue(input.effectiveModel) } : {}),
    ...(tools(input.selectedTools) ? { selectedTools: tools(input.selectedTools) } : {}),
    ...(tools(input.exposedTools) ? { exposedTools: tools(input.exposedTools) } : {}),
    ...(tools(input.invokedTools) ? { invokedTools: tools(input.invokedTools) } : {}),
    ...(sourceRefs(input.sourceRefs) ? { sourceRefs: sourceRefs(input.sourceRefs) } : {}),
    ...(opaque(input.proposalId) ? { proposalId: opaque(input.proposalId) } : {}),
    ...(opaque(input.operationId) ? { operationId: opaque(input.operationId) } : {}),
    ...(input.artifactIds
      ? { artifactIds: input.artifactIds.map(opaque).filter(Boolean).slice(0, MAX_REFS) }
      : {}),
    ...(Number.isInteger(input.attempt) && input.attempt! >= 0 ? { attempt: input.attempt } : {}),
    ...(input.retry !== undefined ? { retry: input.retry } : {}),
    ...(enumValue(input.outcome) ? { outcome: enumValue(input.outcome) } : {}),
    ...(typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
      ? { durationMs: Math.max(0, Math.round(input.durationMs)) }
      : {}),
    ...(input.usage ? { usage: meriTelemetryUsage(input.usage) } : {}),
    ...(input.integrationDependencies
      ? {
          integrationDependencies: input.integrationDependencies
            .map((value) => enumValue(value))
            .filter(Boolean)
            .slice(0, 16),
        }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_EVENT_BYTES) {
    return {
      ...event,
      selectedTools: undefined,
      exposedTools: undefined,
      sourceRefs: undefined,
      recordTruncated: true,
    };
  }
  return event;
}

export function meriTelemetryLogLine(
  context: MeriTelemetryContext,
  input: MeriTelemetryEventInput,
): string {
  return JSON.stringify(buildMeriTelemetryEvent(context, input));
}
