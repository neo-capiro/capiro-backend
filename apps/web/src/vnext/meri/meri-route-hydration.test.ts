import { describe, expect, test } from 'vitest';
import {
  mayApplyApprovalResult,
  mayApplyRecordFreeCreation,
  mayDispatchPendingRecordFreeSend,
  mayCommitRouteHydration,
  shouldDiscardStagedAttachmentsForScopeChange,
  maySend,
  ownsFirstSend,
  ownsScopeIntent,
  type FirstSendToken,
  type ScopePersistStatus,
} from '../../components/chat/meri-route-guards.js';

describe('Meri route commit guards', () => {
  test('rejects a late prior-thread hydration after the user navigates again', () => {
    const oldRequest = { sequence: 2, threadId: 'thread-b' };
    expect(mayCommitRouteHydration(oldRequest, 3, 'thread-c')).toBe(false);
  });

  test('accepts a hydration only for the current route sequence and thread', () => {
    const currentRequest = { sequence: 3, threadId: 'thread-c' };
    expect(mayCommitRouteHydration(currentRequest, 3, 'thread-c')).toBe(true);
  });

  test('allows the current root route to commit its newly resolved newest thread', () => {
    const rootRequest = { sequence: 3, threadId: 'thread-c' };
    expect(mayCommitRouteHydration(rootRequest, 3, null)).toBe(true);
  });

  test('rejects an approval result after its conversation is no longer active', () => {
    expect(mayApplyApprovalResult('thread-a', 'thread-b', 5, 5)).toBe(false);
    expect(mayApplyApprovalResult('thread-a', null, 5, 5)).toBe(false);
  });

  test('rejects an approval result after a route transition even if a session id is reused', () => {
    expect(mayApplyApprovalResult('thread-a', 'thread-a', 5, 6)).toBe(false);
  });

  test('accepts an approval result only for its initiating session and epoch', () => {
    expect(mayApplyApprovalResult('thread-a', 'thread-a', 5, 5)).toBe(true);
  });

  test('requires staged attachments to be dropped when client scope changes', () => {
    expect(shouldDiscardStagedAttachmentsForScopeChange('client-a', 'client-b', 1)).toBe(true);
    expect(shouldDiscardStagedAttachmentsForScopeChange('client-a', 'client-a', 1)).toBe(false);
    expect(shouldDiscardStagedAttachmentsForScopeChange('client-a', 'client-b', 0)).toBe(false);
  });

  test('rejects a record-free creation that completes after navigation away', () => {
    expect(mayApplyRecordFreeCreation(4, 5, '/meri/t/thread-b')).toBe(false);
    expect(mayApplyRecordFreeCreation(4, 4, '/meri/t/thread-b')).toBe(false);
    expect(mayApplyRecordFreeCreation(4, 4, '/meri/new')).toBe(true);
  });

  test('does not dispatch an old deferred first-send against a different selected thread', () => {
    expect(mayDispatchPendingRecordFreeSend(4, 5, 'created-a', 'thread-b')).toBe(false);
    expect(mayDispatchPendingRecordFreeSend(4, 4, 'created-a', 'thread-b')).toBe(false);
    expect(mayDispatchPendingRecordFreeSend(4, 4, 'created-a', 'created-a')).toBe(true);
  });

  test('maySend blocks during scope persistence saving and error', () => {
    expect(maySend(false, 'idle')).toBe(true);
    expect(maySend(false, 'saving')).toBe(false);
    expect(maySend(false, 'error')).toBe(false);
    expect(maySend(true, 'idle')).toBe(false);
  });

  test('ownsFirstSend distinguishes A stale from C active', () => {
    const tokenA: FirstSendToken = { id: 'a', routeEpoch: 1 };
    const tokenC: FirstSendToken = { id: 'c', routeEpoch: 2 };
    expect(ownsFirstSend(tokenA, tokenA)).toBe(true);
    expect(ownsFirstSend(tokenA, tokenC)).toBe(false);
    expect(ownsFirstSend(tokenC, tokenC)).toBe(true);
    expect(ownsFirstSend(tokenA, null)).toBe(false);
  });

  test('ownsScopeIntent rejects out-of-order scope resolution', () => {
    expect(ownsScopeIntent(1, 1)).toBe(true);
    expect(ownsScopeIntent(1, 2)).toBe(false);
    expect(ownsScopeIntent(2, 2)).toBe(true);
  });
});
