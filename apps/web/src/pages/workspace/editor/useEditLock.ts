/**
 * Concurrent-edit lock lifecycle hook (Phase 6b, Q-ED-2). DB + polling — no
 * websockets.
 *
 * On mount it tries to acquire the lock (free / inactive → I hold it; actively
 * held → I become a view-only viewer). While I hold the lock it heartbeats every
 * HEARTBEAT_MS so other viewers can tell I'm active; status itself polls every
 * POLL_MS (the query's refetchInterval). On unmount it releases (the release
 * endpoint transfers to a pending requester or frees the lock).
 *
 * Returns the current lock status, a `canEdit` flag, the request-pending local
 * state, and the action callbacks the LockBanner + EditorPage drive.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useAcquireLock,
  useHeartbeatLock,
  useLockStatus,
  useReleaseLock,
  useRequestLock,
  useTakeOverLock,
} from '../api.js';
import type { WsLockStatus } from '../types.js';

const POLL_MS = 15_000;
const HEARTBEAT_MS = 30_000;

const FREE: WsLockStatus = {
  held: false,
  heldByMe: false,
  holderId: null,
  holderName: null,
  acquiredAt: null,
  lastHeartbeatAt: null,
  holderInactive: false,
  requestedById: null,
  requestedByName: null,
  requestedAt: null,
  hasIncomingRequest: false,
};

export interface EditLockController {
  lock: WsLockStatus;
  /** I hold the active lock (may edit). */
  canEdit: boolean;
  /** I sent a request to edit (local optimistic). */
  requestPending: boolean;
  requestBusy: boolean;
  takeOverBusy: boolean;
  releasing: boolean;
  request: () => void;
  takeOver: () => void;
  /** Flush + release + transfer (the "Save & release" flow). */
  saveAndRelease: (flush: () => void) => void;
  /** Dismiss an incoming request locally (the holder "Keep editing"). */
  keepEditing: () => void;
}

export function useEditLock(draftId: string | null, selfName: string): EditLockController {
  const { data } = useLockStatus(draftId, POLL_MS);
  const acquire = useAcquireLock(draftId ?? '');
  const heartbeat = useHeartbeatLock(draftId ?? '');
  const release = useReleaseLock(draftId ?? '');
  const requestEdit = useRequestLock(draftId ?? '');
  const takeOverMut = useTakeOverLock(draftId ?? '');

  const [requestPending, setRequestPending] = useState(false);
  // Locally dismissed incoming-request ids so "Keep editing" hides the banner
  // until a NEW request arrives.
  const [dismissedRequest, setDismissedRequest] = useState<string | null>(null);

  const lockRaw = data ?? FREE;
  // Apply the local "Keep editing" dismissal to the surfaced incoming request.
  const lock: WsLockStatus =
    lockRaw.hasIncomingRequest && lockRaw.requestedById === dismissedRequest
      ? { ...lockRaw, hasIncomingRequest: false }
      : lockRaw;

  const canEdit = lock.heldByMe && lock.held;

  // Auto-acquire once per draft on mount.
  const acquiredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!draftId) return;
    if (acquiredFor.current === draftId) return;
    acquiredFor.current = draftId;
    acquire.mutate({ name: selfName });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  // Heartbeat while I hold the lock.
  useEffect(() => {
    if (!draftId || !canEdit) return;
    const id = setInterval(() => heartbeat.mutate(undefined), HEARTBEAT_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, canEdit]);

  // Release on unmount (best-effort; the lock also self-expires after inactivity).
  const releaseRef = useRef(release);
  releaseRef.current = release;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  useEffect(() => {
    return () => {
      if (canEditRef.current) releaseRef.current.mutate(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  // Clear my pending-request flag once I become the holder (request granted).
  useEffect(() => {
    if (canEdit && requestPending) setRequestPending(false);
  }, [canEdit, requestPending]);

  const request = useCallback(() => {
    setRequestPending(true);
    requestEdit.mutate({ name: selfName }, { onError: () => setRequestPending(false) });
  }, [requestEdit, selfName]);

  const takeOver = useCallback(() => {
    takeOverMut.mutate({ name: selfName });
  }, [takeOverMut, selfName]);

  const saveAndRelease = useCallback(
    (flush: () => void) => {
      flush();
      // Release transfers the lock to the pending requester server-side.
      release.mutate(undefined);
    },
    [release],
  );

  const keepEditing = useCallback(() => {
    if (lock.requestedById) setDismissedRequest(lock.requestedById);
  }, [lock.requestedById]);

  return {
    lock,
    canEdit,
    requestPending,
    requestBusy: requestEdit.isPending,
    takeOverBusy: takeOverMut.isPending,
    releasing: release.isPending,
    request,
    takeOver,
    saveAndRelease,
    keepEditing,
  };
}
