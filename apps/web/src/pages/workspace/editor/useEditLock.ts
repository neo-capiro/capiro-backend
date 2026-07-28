/**
 * Concurrent-edit lock lifecycle hook (Phase 6b, Q-ED-2). DB + polling — no
 * websockets.
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
  canEdit: boolean;
  requestPending: boolean;
  requestBusy: boolean;
  takeOverBusy: boolean;
  releasing: boolean;
  request: () => void;
  takeOver: () => void;
  /** Flush durably, then release. A failed save never transfers the lock. */
  saveAndRelease: (flush: () => Promise<{ ok: boolean }>) => Promise<boolean>;
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
  const [dismissedRequest, setDismissedRequest] = useState<string | null>(null);

  const lockRaw = data ?? FREE;
  const lock: WsLockStatus =
    lockRaw.hasIncomingRequest && lockRaw.requestedById === dismissedRequest
      ? { ...lockRaw, hasIncomingRequest: false }
      : lockRaw;
  const canEdit = lock.heldByMe && lock.held;

  const acquiredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!draftId || acquiredFor.current === draftId) return;
    acquiredFor.current = draftId;
    acquire.mutate({ name: selfName });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  useEffect(() => {
    if (!draftId || !canEdit) return;
    const id = setInterval(() => heartbeat.mutate(undefined), HEARTBEAT_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, canEdit]);

  // Best-effort lock cleanup only. Document durability is handled explicitly by
  // saveAndRelease/navigation guards; unmount must never claim a save happened.
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
    async (flush: () => Promise<{ ok: boolean }>): Promise<boolean> => {
      const outcome = await flush();
      if (!outcome.ok) return false;
      await release.mutateAsync(undefined);
      return true;
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
