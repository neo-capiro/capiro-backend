export interface RouteHydrationToken {
  readonly sequence: number;
  readonly threadId: string;
}

/**
 * A hydration result may commit only if it still belongs to the latest route
 * bootstrap and the URL still names that same durable thread.
 */
export function mayCommitRouteHydration(
  token: RouteHydrationToken,
  currentSequence: number,
  currentThreadId: string | null,
): boolean {
  // `/meri` resolves its target only after the server history list returns, so
  // it has no durable thread id in the URL while its own bootstrap is current.
  // A later explicit `/meri/t/:id` route still rejects the old root hydration
  // through both the new sequence and its non-null route thread id.
  return (
    token.sequence === currentSequence &&
    (currentThreadId === null || token.threadId === currentThreadId)
  );
}

/** A pending approval completion belongs only to its original session and route epoch. */
export function mayApplyApprovalResult(
  approvalSessionId: string,
  currentSessionId: string | null,
  approvalRouteEpoch: number,
  currentRouteEpoch: number,
): boolean {
  return (
    approvalSessionId === currentSessionId && approvalRouteEpoch === currentRouteEpoch
  );
}

/**
 * Attachments are staged for exactly one pending turn under one client scope.
 * Changing scope before Send must drop them rather than letting a file selected
 * under the old client reach the new one.
 */
export function shouldDiscardStagedAttachmentsForScopeChange(
  currentClientId: string | null,
  nextClientId: string | null,
  stagedAttachmentCount: number,
): boolean {
  return currentClientId !== nextClientId && stagedAttachmentCount > 0;
}

/**
 * A record-free first-send creation may only select its resulting session while
 * its originating `/meri/new` route remains the active route epoch.
 */
export function mayApplyRecordFreeCreation(
  creationEpoch: number,
  currentEpoch: number,
  currentPathname: string,
): boolean {
  return creationEpoch === currentEpoch && currentPathname === '/meri/new';
}

/**
 * The pending first-turn payload is owned by the record-free creation epoch and
 * its created session. It must never hitchhike on a later hydrated session.
 */
export function mayDispatchPendingRecordFreeSend(
  pendingEpoch: number,
  currentEpoch: number,
  createdSessionId: string,
  activeSessionId: string | null,
): boolean {
  return pendingEpoch === currentEpoch && createdSessionId === activeSessionId;
}

// ── First-send ownership token ──────────────────────────────────────────
// A unique immutable token per first-send intent. Multiple async continuations
// from different /meri/new flows can still reference shared mutable refs
// (pendingSendRef, isCreatingThread, etc.). A numeric route epoch alone cannot
// distinguish A's stale continuation from C's active one when both captured the
// same epoch value at different times. The token id makes ownership unambiguous.

export interface FirstSendToken {
  readonly id: string;
  readonly routeEpoch: number;
}

/**
 * Returns true only if the captured token is still the active first-send
 * owner. A stale operation (A) must be a complete no-op once C owns the shared
 * first-send state.
 */
export function ownsFirstSend(
  token: FirstSendToken,
  activeToken: FirstSendToken | null,
): boolean {
  return activeToken !== null && token.id === activeToken.id;
}

// ── Client scope persistence ────────────────────────────────────────────
// The backend derives a turn's scope from the persisted conversation/client
// relation. An optimistic local selector update is NOT authorization to send.
// The send path must use only the server-confirmed (persisted) client scope.

export type ScopePersistStatus = 'idle' | 'saving' | 'error';

/**
 * A monotonically increasing scope intent sequence. Each scope-change request
 * captures the current value; on resolution it must still match the latest
 * intent. This prevents an out-of-order A→B→C resolution from overwriting C's
 * state with B's result.
 */
export function ownsScopeIntent(
  capturedIntent: number,
  currentIntent: number,
): boolean {
  return capturedIntent === currentIntent;
}

/**
 * One authoritative predicate for whether a send may dispatch.
 *
 * A send must not dispatch while:
 * - the controller is streaming/creating
 * - client scope persistence is pending ('saving')
 * - client scope persistence failed ('error')
 *
 * Route/session ownership and first-send ownership are enforced inside the
 * send path itself (epoch + token checks). This predicate covers the remaining
 * durable-transition gate so the composer button, keyboard path, and
 * programmatic first-send handoff all share identical semantics.
 */
export function maySend(
  isStreaming: boolean,
  scopePersistStatus: ScopePersistStatus,
): boolean {
  return !isStreaming && scopePersistStatus === 'idle';
}
