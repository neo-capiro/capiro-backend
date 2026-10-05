// ---------------------------------------------------------------------------
// This proxy is the FIRST routing decision for every full-chat turn
// (POST /api/clio/conversations/:id/stream). MeriV3 is the only chat runtime
// (program plan 2026-10-05, §2.2 and §4.1):
//
//  * `meriv3.shouldHandle(ctx)` is MeriFeatureFlagsService.isMeriV3ChatEnabled:
//    two keys, both default on — env MERIV3_ENABLED (global kill switch) and the
//    tenant's clioFeatureFlags['meriv3.fullChat'] (tenant off switch). There is
//    no slug allow-list.
//  * When the gate declines, the turn is REFUSED: an `error` frame with code
//    `meri_unavailable`, a persisted assistant row with servedBy 'unavailable',
//    and a `meri_unavailable` warning log (CloudWatch metric filter + alarm).
//    It never falls back to the MeriV2 proxy or the legacy in-process loop; those
//    paths are deleted in Stage 1 §4.3.
//  * The gate is checked BEFORE the governed Context Plane turn is prepared, so
//    a refusal makes no model, retrieval or tool call.
//  * The gate is bearer- and impersonation-blind: it reads only ctx.tenantId
//    (the middleware-swapped ctx on impersonated turns).
//
// The Phase-19 adapter installers below (installRawPhase19Adapters /
// installV3Phase19Adapters) patch private seams of both services at construction
// time; the raw-service adapters are removed with the V1 deletion (§4.3).
// ---------------------------------------------------------------------------
import type { TenantContext } from '@capiro/shared';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { MeriService } from './meri.service.js';
import {
  currentMeriGovernedRuntime,
  MeriContextPlaneRuntimeService,
} from './meri-context-plane-runtime.js';
import { MeriV3ProxyService } from './meriv3-proxy.service.js';
import { MeriV3VisualAnalysisService } from './meri-v3-visual-analysis.service.js';
import { withMeriTurnProgress } from './meri-turn-progress.js';

export const RAW_MERI_SERVICE = Symbol('RAW_MERI_SERVICE');
const PHASE19_PATCHED = Symbol('phase19-governed-context-patched');

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
 * Route the full-chat stream through MeriV3, or refuse it as "Meri is
 * unavailable" when the two-key gate is closed. Phase 19 wraps the V3 turn in
 * one server-derived Context Plane turn before the model can run.
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
            signal?.throwIfAborted();
            // Decide before the governed turn is prepared: a closed gate is a
            // refusal with no model, retrieval or tool call, never a fallback.
            if (!(await meriv3.shouldHandle(ctx))) {
              signal?.throwIfAborted();
              return meriv3.streamUnavailable(...forwarded);
            }
            return governedRuntime.runChatTurn(
              ctx,
              { conversationId, body, mode, signal },
              async () => {
                signal?.throwIfAborted();
                return meriv3.streamMessage(...forwarded);
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
    { coverage?: { phase?: unknown; toolReads?: unknown } } | null | undefined;
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
