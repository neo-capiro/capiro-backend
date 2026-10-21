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
//    The retired MeriV2 proxy and legacy in-process loop provide no fallback.
//  * The gate is checked BEFORE the governed Context Plane turn is prepared, so
//    a refusal makes no model, retrieval or tool call.
//  * The gate is bearer- and impersonation-blind: it reads only ctx.tenantId
//    (the middleware-swapped ctx on impersonated turns).
//
// The Phase-19 V3 adapters below patch its client and client-KB seams once at
// construction. The raw service supplies retained non-stream operations only.
// ---------------------------------------------------------------------------
import type { TenantContext } from '@capiro/shared';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import type { MeriService } from './meri.service.js';
import {
  currentMeriGovernedRuntime,
  type MeriContextPlaneRuntimeService,
} from './meri-context-plane-runtime.js';
import type { MeriV3ProxyService } from './meriv3-proxy.service.js';
import type { MeriV3VisualAnalysisService } from './meri-v3-visual-analysis.service.js';
import type { MeriRuntimeService, MeriStreamArgs } from './meri-runtime.contract.js';
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
 * to `never` in TypeScript. The factory owns the concrete instance, so this is
 * a narrow construction-time adapter, not a public cast contract. */
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
 * The raw service retains its action, attachment, history, compliance, and
 * persistence operations. V3's prewarm seams are adapted at construction time:
 *  - its client receives the governed bundle over the existing JSON body,
 *  - its client-KB prewarm is suppressed only while a governed turn is active,
 *  - done frames retain the API-side packet and the orchestrator's reconciliation
 *    of later reads, so saved coverage matches the evidence used for the turn.
 */
export function createMeriRuntimeService(
  raw: MeriService,
  meriv3: MeriV3ProxyService,
  visualAnalysis: MeriV3VisualAnalysisService,
  governedRuntime: MeriContextPlaneRuntimeService,
): MeriRuntimeService {
  installV3Phase19Adapters(meriv3);

  return new Proxy(raw, {
    get(target, property, receiver) {
      if (property === 'streamMessage') {
        return async (...args: MeriStreamArgs) => {
          const ctx = args[0] as TenantContext;
          const conversationId = args[1] as string;
          const body = args[2] as string;
          const mode = (args[5] ?? 'new') as 'new' | 'regenerate' | 'resend';
          const signal = args[4];
          return withMeriTurnProgress(args[3], signal, async (writer) => {
            const forwarded = [...args] as MeriStreamArgs;
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
        return (...args: Parameters<MeriRuntimeService['getArtifactImage']>) =>
          visualAnalysis.getArtifactImage(...args);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as MeriRuntimeService;
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
