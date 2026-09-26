// ---------------------------------------------------------------------------
// LIVE RUNTIME STATE — verified 2026-09-18, read-only (aws ecs describe-services
// + describe-task-definition on cluster capiro-dev). Routing matrix and the
// legacy-retirement scoping live in docs/meri/legacy-stream-retirement-scope.md.
//
// This proxy is the FIRST routing decision for every full-chat turn
// (POST /api/clio/conversations/:id/stream). `meriv3.shouldHandle(ctx)` is
// MeriFeatureFlagsService.isMeriV3ChatEnabled(tenantId, tenantSlug): three keys,
// all default-closed — env MERIV3_ENABLED === 'true', slug in
// MERIV3_CANARY_TENANT_SLUGS, tenant clioFeatureFlags['meriv3.fullChat'] === true.
// Only when it declines does the raw MeriService decide MeriV2-orchestrator vs
// legacy in-process (shouldRouteMeriV2FullChat, meriv2-routing.helpers.ts).
//
//  * MERIV3_ENABLED=true on the live api task definition (capiro-dev-api:384;
//    present since at least :382) and on capiro-dev-meriv2-orchestrator:65.
//    The V3 canary is LIVE. The earlier Part-3 plan note "V3 dark in prod" was
//    wrong and is superseded by this block.
//  * MERIV3_CANARY_TENANT_SLUGS = all 9 tenants (c2-strategies, capiro-internal,
//    dualsight, maven, prospering-solutions, revere, victory-six-advisors,
//    rubin-turnbull, abramoff — abramoff appended 2026-09-18 on api:383/orch:65),
//    and clioFeatureFlags['meriv3.fullChat']=true on all 9 (flag parity applied
//    2026-09-18). Net effect: every turn on each of the 9 live tenants takes the
//    `meriv3.streamMessage` branch below. The `target.streamMessage` branch
//    (MeriV2 proxy / legacy V1) is reached only for a tenant outside the cohort
//    or after one of the three keys is closed — it is the ROLLBACK path, not
//    dead code.
//  * This gate is bearer- and impersonation-blind: shouldHandle reads only
//    ctx.tenantId / ctx.tenantSlug (the middleware-swapped ctx on impersonated
//    turns), never the Authorization header or x-capiro-impersonate-tenant, so an
//    impersonated turn on a cohort tenant also rides V3. The MeriV2 gate
//    downstream DOES require a bearer and DOES exclude impersonation (264b351af
//    containment) — a deliberate asymmetry, pinned by meriv2-routing.matrix.spec.ts
//    and meri-feature-flags.matrix.spec.ts.
//  * CDK DRIFT WARNING: MERIV3_ENABLED is ABSENT from infra/cdk/lib/compute-stack.ts
//    (so is MERIV3_CANARY_TENANT_SLUGS); both were applied OUT-OF-BAND on the task
//    definitions. The live TD env is the source of truth; a `cdk deploy` would
//    silently DROP MERIV3_ENABLED and move every tenant from V3 to the MeriV2 proxy
//    in one roll. The Capiro-dev-Compute stack has been wedged since 2026-05-27 —
//    described as UPDATE_ROLLBACK_FAILED in compute-stack.ts and
//    infra/cdk/DRIFT-FINDINGS.md; CloudFormation reported UPDATE_ROLLBACK_COMPLETE
//    (last updated 2026-07-25) when re-read on 2026-09-18. Either way: do not
//    `cdk deploy` this stack until these keys are codified there.
//
// The Phase-19 adapter installers below (installRawPhase19Adapters /
// installV3Phase19Adapters) patch private seams of BOTH runtimes at construction
// time and are intentionally left untouched; simplifying them is out of scope
// until the runtime matrix proves the patched internals are exercised identically.
// ---------------------------------------------------------------------------
import type { TenantContext } from '@capiro/shared';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { MeriService } from './meri.service.js';
import {
  currentMeriGovernedRuntime,
  MeriContextPlaneRuntimeService,
} from './meri-context-plane-runtime.js';
import { MeriV3ProxyService } from './meriv3-proxy.service.js';
import { MeriV3VisualAnalysisService } from './meri-v3-visual-analysis.service.js';
import { withMeriTurnProgress } from './meri-turn-progress.js';
import type { MeriHermesRuntimeAdapter } from '../hermes/meri-hermes-runtime.adapter.js';


export const RAW_MERI_SERVICE = Symbol('RAW_MERI_SERVICE');
const PHASE19_PATCHED = Symbol('phase19-governed-context-patched');
const routeTelemetryLogger = new Logger('MeriRouteTelemetry');
const MAX_OBSERVED_SSE_EVENT_CHARS = 64 * 1024;

interface StreamClient {
  streamChat(args: {
    input: Record<string, unknown>;
    onEvent: (event: Record<string, unknown>) => void;
    [key: string]: unknown;
  }): Promise<void>;
  [key: string]: unknown;
}

interface ClientKbLike {
  buildSnapshot(...args: unknown[]): Promise<string | null | undefined>;
  [key: string]: unknown;
}

/** Structural views intentionally exclude the class types themselves. Intersecting
 * these shapes with Nest classes that declare the same members `private` reduces
 * to `never` in TypeScript. The factory owns both concrete instances, so this is
 * a narrow construction-time adapter, not a public cast contract. */
type RawMeriInternals = {
  [PHASE19_PATCHED]?: boolean;
  orchestrateContext: (...args: unknown[]) => Promise<Record<string, unknown>>;
  loadRelevantMemories: (...args: unknown[]) => Promise<Array<{ key: string; value: string }>>;
  policyForIntent: (intent: string, query: string) => Record<string, unknown>;
  templateForIntent: (intent: string) => Record<string, unknown> | null;
  meriV2Chat: StreamClient;
  clientKb: ClientKbLike;
};

type V3Internals = {
  [PHASE19_PATCHED]?: boolean;
  client: StreamClient;
  clientKb: ClientKbLike;
};

/**
 * Route only the full-chat stream through MeriV3 when the authenticated tenant
 * passes the server-side canary gate. Phase 19 wraps BOTH runtime choices in one
 * server-derived Context Plane turn before either model can run.
 *
 * The existing services are intentionally not rewritten: their mature action,
 * attachment, history, compliance, and persistence code stays intact. Instead,
 * their former prewarm seams are adapted at construction time:
 *  - legacy `orchestrateContext` consumes the governed prompt/coverage,
 *  - V2/V3 clients receive the same governed bundle over their existing JSON body,
 *  - legacy clio_memory + client-KB prewarms are suppressed only while a governed
 *    turn is active,
 *  - done frames retain the API-side packet and the orchestrator's reconciliation
 *    of later reads, so saved coverage matches the evidence used for the turn.
 */
export function createMeriRuntimeService(
  raw: MeriService,
  meriv3: MeriV3ProxyService,
  visualAnalysis: MeriV3VisualAnalysisService,
  governedRuntime: MeriContextPlaneRuntimeService,
  hermes?: Pick<MeriHermesRuntimeAdapter, 'shouldHandle' | 'streamMessage'>,
): MeriService {
  installRawPhase19Adapters(raw);
  installV3Phase19Adapters(meriv3);

  return new Proxy(raw, {
    get(target, property, receiver) {
      if (property === 'streamMessage') {
        return async (...args: Parameters<MeriService['streamMessage']>) => {
          const ctx = args[0] as TenantContext;
          const conversationId = args[1] as string;
          const body = args[2] as string;
          const mode = (args[5] ?? 'new') as 'new' | 'regenerate' | 'resend';
          const signal = args[4];
          return withMeriTurnProgress(args[3], signal, async (writer) => {
            const forwarded = [...args] as Parameters<MeriService['streamMessage']>;
            forwarded[3] = writer;
            return governedRuntime.runChatTurn(
              ctx,
              { conversationId, body, mode, signal },
              async () => {
                signal?.throwIfAborted();
                // Phase 0 Hermes pilot: a peer route with the strictest gate,
                // checked first. When it is selected, its failures surface as
                // its own error frames — never a silent fallback to V3/legacy.
                if (hermes && (await hermes.shouldHandle(ctx))) {
                  signal?.throwIfAborted();
                  return withSelectedRouteTelemetry(
                    'hermes',
                    'hermes_gate_accepted',
                    forwarded.slice(0, 9),
                    signal,
                    (selectedArgs) => hermes.streamMessage(
                      ...(selectedArgs as Parameters<MeriHermesRuntimeAdapter['streamMessage']>),
                    ),
                  );
                }
                signal?.throwIfAborted();
                const useV3 = await meriv3.shouldHandle(ctx);
                signal?.throwIfAborted();
                if (useV3) {
                  return withSelectedRouteTelemetry(
                    'meriv3',
                    'v3_gate_accepted',
                    forwarded.slice(0, 9),
                    signal,
                    (selectedArgs) => meriv3.streamMessage(
                      ...(selectedArgs as Parameters<MeriV3ProxyService['streamMessage']>),
                    ),
                  );
                }

                let legacyV1Selected = false;
                const observeErrorFrame = createSseErrorFrameObserver();
                const originalWriter = forwarded[3];
                const routeAttemptId = randomUUID();
                const emitRouteTelemetry = (record: Record<string, unknown>) => {
                  try {
                    routeTelemetryLogger.log(JSON.stringify(record));
                  } catch {
                    // Telemetry must never change runtime selection or stream behavior.
                  }
                };
                forwarded[3] = {
                  write(data: string) {
                    try {
                      observeErrorFrame(data);
                    } catch {
                      // Observation is best-effort and must never affect the stream.
                    }
                    originalWriter.write(data);
                  },
                };
                const rawForwarded = [...forwarded] as unknown[];
                rawForwarded[9] = () => {
                  legacyV1Selected = true;
                  emitRouteTelemetry({
                    event: 'meri_route_selection', phase: 'selected', runtime: 'legacy-v1',
                    dispatch: 'v3_raw_v2_declined', impersonated: Boolean(args[8]), routeAttemptId,
                  });
                };
                let outcome = 'completed';
                try {
                  const rawStreamMessage = target.streamMessage as (...values: unknown[]) => Promise<unknown>;
                  await rawStreamMessage(...rawForwarded);
                  if (signal?.aborted) {
                    const reason = signal.reason;
                    outcome = reason instanceof DOMException && reason.name === 'AbortError' && reason.message === 'Client disconnected'
                      ? 'client_disconnected'
                      : 'aborted';
                  } else if (observeErrorFrame.hasError()) {
                    outcome = 'error';
                  }
                } catch (error) {
                  const reason = signal?.reason;
                  outcome = signal?.aborted
                    ? (reason instanceof DOMException && reason.name === 'AbortError' && reason.message === 'Client disconnected'
                      ? 'client_disconnected'
                      : 'aborted')
                    : 'error';
                  throw error;
                } finally {
                  if (legacyV1Selected) {
                    emitRouteTelemetry({
                      event: 'meri_route_selection', phase: 'outcome', runtime: 'legacy-v1',
                      dispatch: 'v3_raw_v2_declined', impersonated: Boolean(args[8]), outcome, routeAttemptId,
                    });
                  }
                }
              },
            );
          });
        };
      }
      if (property === 'getArtifactImage') {
        return (...args: Parameters<MeriService['getArtifactImage']>) =>
          visualAnalysis.getArtifactImage(...args);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Observe only a route that has already passed its server-side gate. The SSE
 * writer remains the same writer, and telemetry failures are deliberately
 * swallowed so they cannot affect dispatch, frame delivery, or stream errors. */
async function withSelectedRouteTelemetry(
  runtime: 'hermes' | 'meriv3',
  dispatch: 'hermes_gate_accepted' | 'v3_gate_accepted',
  args: unknown[],
  signal: AbortSignal | undefined,
  invoke: (args: unknown[]) => Promise<unknown>,
): Promise<unknown> {
  const routeAttemptId = randomUUID();
  const impersonated = Boolean(args[8]);
  const emit = (phase: 'selected' | 'outcome', outcome?: string) => {
    try {
      routeTelemetryLogger.log(JSON.stringify({
        event: 'meri_route_selection',
        phase,
        runtime,
        dispatch,
        impersonated,
        routeAttemptId,
        ...(outcome ? { outcome } : {}),
      }));
    } catch {
      // Telemetry must never alter runtime selection or stream behavior.
    }
  };

  const originalWriter = args[3] as { write(data: string): void };
  const observeErrorFrame = createSseErrorFrameObserver();
  const observedArgs = [...args];
  observedArgs[3] = {
    write(data: string) {
      try {
        observeErrorFrame(data);
      } catch {
        // Observation is best-effort and must never affect the stream.
      }
      originalWriter.write(data);
    },
  };

  emit('selected');
  let outcome = 'completed';
  try {
    const result = await invoke(observedArgs);
    if (signal?.aborted) outcome = abortOutcome(signal);
    else if (observeErrorFrame.hasError()) outcome = 'error';
    return result;
  } catch (error) {
    outcome = signal?.aborted ? abortOutcome(signal) : 'error';
    throw error;
  } finally {
    emit('outcome', outcome);
  }
}

/**
 * Observe SSE error events across arbitrary writer chunk boundaries. This is
 * synchronous and bounded: an unterminated or oversized event is discarded
 * from observation after the cap, while every original chunk is still passed
 * through unchanged by the caller. Only complete SSE events are classified.
 */
type SseErrorFrameObserver = ((chunk: string) => void) & { hasError(): boolean };

function createSseErrorFrameObserver(): SseErrorFrameObserver {
  const eventLines: string[] = [];
  let line = '';
  let eventChars = 0;
  let oversized = false;
  let previousWasCarriageReturn = false;
  let emittedError = false;

  const finishEvent = () => {
    if (!oversized) {
      try {
        const data = [...eventLines, line]
          .flatMap((line) => {
            if (line.startsWith(':')) return [];
            const colon = line.indexOf(':');
            const field = colon < 0 ? line : line.slice(0, colon);
            if (field !== 'data') return [];
            let value = colon < 0 ? '' : line.slice(colon + 1);
            if (value.startsWith(' ')) value = value.slice(1);
            return [value];
          })
          .join('\n');
        if (data && (JSON.parse(data) as { type?: unknown })?.type === 'error') {
          emittedError = true;
        }
      } catch {
        // Malformed or non-JSON events are irrelevant to error classification.
      }
    }
    eventLines.length = 0;
    line = '';
    eventChars = 0;
    oversized = false;
  };

  const observe = ((chunk: string) => {
    for (const char of chunk) {
      if (char === '\n' && previousWasCarriageReturn) {
        previousWasCarriageReturn = false;
        continue;
      }
      if (char === '\r' || char === '\n') {
        previousWasCarriageReturn = char === '\r';
        if (line.length === 0) {
          finishEvent();
        } else {
          if (!oversized) eventLines.push(line);
          line = '';
        }
        continue;
      }
      previousWasCarriageReturn = false;
      eventChars += 1;
      if (eventChars <= MAX_OBSERVED_SSE_EVENT_CHARS) line += char;
      else {
        oversized = true;
        line = '';
        eventLines.length = 0;
      }
    }
  }) as ((chunk: string) => void) & { hasError(): boolean };
  observe.hasError = () => emittedError;
  return observe;
}

function abortOutcome(signal: AbortSignal): 'aborted' | 'client_disconnected' {
  const reason = signal.reason;
  return reason instanceof DOMException && reason.name === 'AbortError' &&
    reason.message === 'Client disconnected'
    ? 'client_disconnected'
    : 'aborted';
}

function installRawPhase19Adapters(rawService: MeriService): void {
  const raw = rawService as unknown as RawMeriInternals;
  if (raw[PHASE19_PATCHED]) return;
  raw[PHASE19_PATCHED] = true;

  const originalOrchestrate = raw.orchestrateContext.bind(raw);
  raw.orchestrateContext = async (...args: unknown[]) => {
    const governed = currentMeriGovernedRuntime();
    if (!governed) return originalOrchestrate(...args);
    const intent = String(args[2] ?? 'general_question');
    const query = String(args[3] ?? '');
    const sourceHealth = governed.context.retrieval.coverage.sourceHealth;
    const sources = sourceHealth.map((source) => ({
      tool: `context_plane:${source.source}`,
      count: undefined,
      summary: source.detail ?? `Context Plane checked ${source.source}`,
      confidence:
        source.status === 'complete' ? 'high' : source.status === 'partial' ? 'medium' : 'low',
    }));
    const trace = sourceHealth.length
      ? sourceHealth.map((source) => ({
          tool: `context_plane:${source.source}`,
          action:
            source.status === 'complete' || source.status === 'partial' ? 'selected' : 'skipped',
          reason: source.detail ?? `Context Plane source status: ${source.status}`,
        }))
      : [
          {
            tool: 'context_plane',
            action: 'selected',
            reason: 'Governed ContextPacket compiled; retrieval was not required for this turn.',
          },
        ];
    return {
      context: governed.context.prompt,
      sources,
      trace,
      conflict: null,
      policy: raw.policyForIntent(intent, query),
      template: raw.templateForIntent(intent),
      activeClient: governed.activeClient,
    };
  };

  const originalRecall = raw.loadRelevantMemories.bind(raw);
  raw.loadRelevantMemories = async (...args: unknown[]) =>
    currentMeriGovernedRuntime() ? [] : originalRecall(...args);

  raw.clientKb = governedClientKbProxy(raw.clientKb);
  raw.meriV2Chat = governedStreamClientProxy(raw.meriV2Chat);
}

function installV3Phase19Adapters(v3Service: MeriV3ProxyService): void {
  const v3 = v3Service as unknown as V3Internals;
  if (v3[PHASE19_PATCHED]) return;
  v3[PHASE19_PATCHED] = true;
  v3.clientKb = governedClientKbProxy(v3.clientKb);
  v3.client = governedStreamClientProxy(v3.client);
}

function governedClientKbProxy(clientKb: ClientKbLike): ClientKbLike {
  return new Proxy(clientKb, {
    get(target, property, receiver) {
      if (property === 'buildSnapshot') {
        return async (...args: unknown[]) =>
          currentMeriGovernedRuntime() ? undefined : target.buildSnapshot(...args);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function governedStreamClientProxy(client: StreamClient): StreamClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'streamChat') {
        return async (args: Parameters<StreamClient['streamChat']>[0]) => {
          const governed = currentMeriGovernedRuntime();
          if (!governed) return target.streamChat(args);
          const onEvent = args.onEvent;
          return target.streamChat({
            ...args,
            input: {
              ...args.input,
              governedContext: governed.context,
            },
            onEvent: (event: Record<string, unknown>) =>
              onEvent(normalizeDoneFrame(event, governed.context)),
          });
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as StreamClient;
}

function normalizeDoneFrame(
  event: Record<string, unknown>,
  governed: MeriGovernedTurnContext,
): Record<string, unknown> {
  if (event.type !== 'done') return event;
  const retrieval = event.retrieval as
    | { coverage?: { phase?: unknown; toolReads?: unknown } }
    | null
    | undefined;
  // The authenticated orchestrator reconciles the signed initial packet with
  // later tool receipts. Retain that turn result: replacing it with the initial
  // packet loses successful reads and reintroduces already-restored failures in
  // both the saved message and its SSE completion. Older runtimes without turn
  // receipts still use the API's governed coverage, never a legacy planner.
  const turnCoverage =
    retrieval?.coverage?.phase === 'turn' && Array.isArray(retrieval.coverage.toolReads)
      ? retrieval.coverage
      : null;
  return {
    ...event,
    contextPacket: governed.contextPacket,
    contextPacketId: governed.contextPacket.packetId ?? undefined,
    retrieval: turnCoverage
      ? {
          ...governed.retrieval,
          coverage: { ...turnCoverage, initialContext: governed.retrieval.coverage },
        }
      : governed.retrieval,
  };
}
