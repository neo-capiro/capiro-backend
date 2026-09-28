import { useCallback, useEffect, useRef, useState } from 'react';
import { config } from '../../env.js';
import {
  fetchMeriDurableResearchSnapshot,
  isMeriDurableTerminal,
  mergeMeriDurableResearchSnapshot,
  MeriDurableResearchHttpError,
  newMeriDurableRequestId,
  steerMeriDurableResearch,
  type MeriDurableResearchSnapshot,
  type MeriDurableSteeringReceipt,
} from '../../components/chat/meri-durable-research.js';

interface PendingSteering {
  researchId: string;
  requestId: string;
  expectedGoalRevision: number;
  message: string;
}

export interface MeriDurableResearchObserver {
  snapshot: MeriDurableResearchSnapshot | null;
  error: string | null;
  steeringSending: boolean;
  steeringTransportUncertain: boolean;
  steeringConflictRevision: number | null;
  acceptedDirection: MeriDurableSteeringReceipt | null;
  refresh: () => Promise<MeriDurableResearchSnapshot | null>;
  sendSteering: (message: string) => Promise<boolean>;
}

/**
 * Authenticated observer for one durable research identity. It only reads the
 * coordinator and sends explicit steering; mounting never starts research.
 * Tokens stay in request headers returned by the existing auth callback and
 * are never persisted in browser storage.
 */
export function useMeriDurableResearch(
  researchId: string | null,
  authHeaders: () => Promise<Record<string, string>>,
  pollMs = 3_000,
): MeriDurableResearchObserver {
  const [snapshot, setSnapshot] = useState<MeriDurableResearchSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [steeringSending, setSteeringSending] = useState(false);
  const [steeringTransportUncertain, setSteeringTransportUncertain] = useState(false);
  const [steeringConflictRevision, setSteeringConflictRevision] = useState<number | null>(null);
  const [acceptedDirection, setAcceptedDirection] = useState<MeriDurableSteeringReceipt | null>(
    null,
  );
  const snapshotRef = useRef<MeriDurableResearchSnapshot | null>(null);
  const cursorRef = useRef(0);
  const identityRef = useRef(researchId);
  const pendingSteeringRef = useRef<PendingSteering | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const scopeDeniedRef = useRef(false);
  const mountedRef = useRef(true);
  const scopeRef = useRef({ researchId, authHeaders });
  const snapshotScopeRef = useRef<typeof scopeRef.current | null>(null);
  if (scopeRef.current.researchId !== researchId || scopeRef.current.authHeaders !== authHeaders) {
    scopeRef.current = { researchId, authHeaders };
  }

  identityRef.current = researchId;
  snapshotRef.current = snapshot;

  const clearPrivateState = useCallback(() => {
    snapshotRef.current = null;
    snapshotScopeRef.current = null;
    cursorRef.current = 0;
    pendingSteeringRef.current = null;
    setSnapshot(null);
    setAcceptedDirection(null);
    setSteeringConflictRevision(null);
    setSteeringTransportUncertain(false);
    setSteeringSending(false);
  }, []);

  const readSnapshot = useCallback(
    async (signal?: AbortSignal): Promise<MeriDurableResearchSnapshot | null> => {
      const target = identityRef.current;
      const scope = scopeRef.current;
      if (!target || scopeDeniedRef.current) return null;
      try {
        const headers = await authHeaders();
        if (scopeRef.current !== scope || identityRef.current !== target || signal?.aborted)
          return null;
        const incoming = await fetchMeriDurableResearchSnapshot({
          apiBaseUrl: config.apiBaseUrl,
          researchId: target,
          afterSequence: cursorRef.current,
          headers,
          signal,
        });
        if (scopeRef.current !== scope || identityRef.current !== target || signal?.aborted)
          return null;
        const merged = mergeMeriDurableResearchSnapshot(snapshotRef.current, incoming);
        snapshotRef.current = merged;
        snapshotScopeRef.current = scope;
        cursorRef.current = merged.nextSequence;
        setSnapshot(merged);
        setError(null);
        return merged;
      } catch (caught) {
        if (scopeRef.current !== scope || signal?.aborted || identityRef.current !== target)
          return null;
        if (
          caught instanceof MeriDurableResearchHttpError &&
          (caught.status === 401 || caught.status === 403 || caught.status === 404)
        ) {
          scopeDeniedRef.current = true;
          clearPrivateState();
          pollAbortRef.current?.abort();
          setError('This durable task is no longer available in your current account scope.');
          return null;
        }
        // Planning may briefly precede durable coordinator admission. This is a
        // retryable observation gap, not evidence that the run failed.
        if (caught instanceof MeriDurableResearchHttpError && caught.status === 409) {
          setError(null);
          return null;
        }
        setError('The durable task connection was interrupted. Reconnecting…');
        return null;
      }
    },
    [authHeaders, clearPrivateState],
  );

  useEffect(() => {
    mountedRef.current = true;
    pollAbortRef.current?.abort();
    clearPrivateState();
    scopeDeniedRef.current = false;
    setError(null);
    if (!researchId) return;

    const controller = new AbortController();
    pollAbortRef.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const next = await readSnapshot(controller.signal);
      if (controller.signal.aborted || identityRef.current !== researchId) return;
      if (!next || (next.run && !isMeriDurableTerminal(next.run.status))) {
        timer = setTimeout(() => void poll(), pollMs);
      }
    };
    void poll();
    return () => {
      mountedRef.current = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [clearPrivateState, pollMs, readSnapshot, researchId]);

  const refresh = useCallback(async () => {
    const controller = new AbortController();
    return readSnapshot(controller.signal);
  }, [readSnapshot]);

  const sendSteering = useCallback(
    async (rawMessage: string): Promise<boolean> => {
      const message = rawMessage.trim();
      const current = snapshotRef.current;
      const target = identityRef.current;
      const scope = scopeRef.current;
      if (
        !message ||
        !current?.run ||
        snapshotScopeRef.current !== scope ||
        !target ||
        steeringSending ||
        isMeriDurableTerminal(current.run.status)
      )
        return false;

      let pending = pendingSteeringRef.current;
      if (
        !pending ||
        pending.researchId !== target ||
        pending.message !== message ||
        pending.expectedGoalRevision !== current.coordinator.goalRevision
      ) {
        pending = {
          researchId: target,
          requestId: newMeriDurableRequestId(),
          expectedGoalRevision: current.coordinator.goalRevision,
          message,
        };
        pendingSteeringRef.current = pending;
      }

      setSteeringSending(true);
      setSteeringConflictRevision(null);
      setSteeringTransportUncertain(false);
      try {
        const headers = await authHeaders();
        if (scopeRef.current !== scope || identityRef.current !== target) return false;
        const response = await steerMeriDurableResearch({
          apiBaseUrl: config.apiBaseUrl,
          headers,
          researchId: pending.researchId,
          requestId: pending.requestId,
          expectedGoalRevision: pending.expectedGoalRevision,
          message: pending.message,
        });
        if (scopeRef.current !== scope || identityRef.current !== target) return false;
        pendingSteeringRef.current = null;
        setAcceptedDirection(response.receipt);
        setSteeringConflictRevision(null);
        await readSnapshot();
        return true;
      } catch (caught) {
        if (scopeRef.current !== scope || identityRef.current !== target) return false;
        if (caught instanceof MeriDurableResearchHttpError) {
          // Any HTTP status is a received response, so a subsequent explicit Send
          // is a new intent. A 409 refreshes authority and never auto-resubmits.
          pendingSteeringRef.current = null;
          if (caught.status === 409) {
            const refreshed = await readSnapshot();
            if (scopeRef.current !== scope || identityRef.current !== target) return false;
            setSteeringConflictRevision(
              refreshed?.coordinator.goalRevision ??
                snapshotRef.current?.coordinator.goalRevision ??
                0,
            );
            setError(null);
            return false;
          }
          if (caught.status === 401 || caught.status === 403 || caught.status === 404) {
            scopeDeniedRef.current = true;
            clearPrivateState();
            pollAbortRef.current?.abort();
            setError('This durable task is no longer available in your current account scope.');
            return false;
          }
          setError('The direction was not accepted. Review it and send again.');
          return false;
        }
        // No response: retain the exact request identity/body so the user's next
        // explicit retry is an idempotent replay, never a duplicate direction.
        setSteeringTransportUncertain(true);
        setError('The direction response was lost. Send again to retry the same request safely.');
        return false;
      } finally {
        if (mountedRef.current && scopeRef.current === scope && identityRef.current === target)
          setSteeringSending(false);
      }
    },
    [authHeaders, clearPrivateState, readSnapshot, steeringSending],
  );

  return {
    snapshot: snapshotScopeRef.current === scopeRef.current ? snapshot : null,
    error,
    steeringSending,
    steeringTransportUncertain,
    steeringConflictRevision,
    acceptedDirection,
    refresh,
    sendSteering,
  };
}
