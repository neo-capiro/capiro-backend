import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type {
  MeriServerReadonlyCapturePolicy,
  MeriControlledReadAttempt,
} from '@capiro/meriv2-core';
import { currentServerReadonlyCapturePolicy } from '../request/trusted-current-turn-scope.js';

const invocations = new AsyncLocalStorage<{
  policy: MeriServerReadonlyCapturePolicy;
  callId: string;
}>();
const observations = new WeakMap<MeriServerReadonlyCapturePolicy, MeriControlledReadAttempt[]>();
const enabled = (p: MeriServerReadonlyCapturePolicy | null): p is MeriServerReadonlyCapturePolicy =>
  !!p && ['20', '72'].includes(p.caseId ?? '');
/** Caller-owned actual function-call ID is set at the existing invocation owner. */
export async function withControlledReadInvocation<T>(
  callId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const policy = currentServerReadonlyCapturePolicy();
  if (!enabled(policy)) return fn();
  if (!callId?.trim()) throw new Error('Controlled read invocation identity missing.');
  return invocations.run({ policy, callId }, fn);
}
/** Runs at the actual HTTP response boundary BEFORE logical-error classification
 * throws. It stores only scoped source identity, hashes and actual transport facts.
 */
export function observeControlledReadHttpResponse(
  tool: string,
  httpStatus: number,
  payload: unknown,
): void {
  const invocation = invocations.getStore();
  const policy = currentServerReadonlyCapturePolicy();
  if (!enabled(policy)) return;
  const value =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, any>)
      : null;
  const owner = value?.controlledRead;
  if (
    !invocation ||
    invocation.policy !== policy ||
    !owner ||
    owner.owner !== 'meri_controlled_read_v1' ||
    [
      'caseId',
      'captureRunId',
      'requestId',
      'traceId',
      'turnId',
      'tenantId',
      'actorUserId',
      'clientId',
      'conversationId',
      'physicalMapSha256',
    ].some((key) => owner[key] !== (policy as unknown as Record<string, unknown>)[key]) ||
    !/^[a-f0-9]{64}$/.test(owner.currentVerifySha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(owner.contentSha256 ?? '') ||
    !/^[a-f0-9-]{36}$/.test(owner.sourceId ?? '') ||
    owner.sourceVersion !== 'v1' ||
    httpStatus !== 200
  )
    throw new Error('Controlled read transport provenance mismatch.');
  const current = observations.get(policy) ?? [];
  if (current.some((row) => row.callId === invocation.callId))
    throw new Error('Controlled read duplicate HTTP attempt.');
  const logicalError = typeof value?.error === 'string' ? value.error : null;
  if (logicalError !== null && (policy.caseId !== '72' || logicalError !== 'document unavailable'))
    throw new Error('Controlled read unexpected logical error.');
  if (
    owner.sourceTenantId !== policy.tenantId ||
    owner.sourceClientId !== (policy.caseId === '20' ? null : policy.clientId)
  )
    throw new Error('Controlled read source scope mismatch.');
  let passageSha256: string | null = null;
  if (policy.caseId === '20') {
    const rows = value?.records;
    if (
      !Array.isArray(rows) ||
      rows.length !== 1 ||
      rows[0]?.id !== owner.sourceId ||
      typeof rows[0].text !== 'string' ||
      !rows[0].text
    )
      throw new Error('Controlled read passage missing.');
    passageSha256 = createHash('sha256').update(rows[0].text, 'utf8').digest('hex');
    if (passageSha256 !== owner.contentSha256)
      throw new Error('Controlled read passage hash mismatch.');
  }
  current.push({
    callId: invocation.callId,
    tool,
    httpStatus,
    logicalError,
    caseId: policy.caseId!,
    captureRunId: policy.captureRunId!,
    requestId: policy.requestId,
    traceId: policy.traceId,
    turnId: policy.turnId!,
    sourceId: owner.sourceId,
    logicalSourceId: owner.logicalSourceId,
    sourceVersion: owner.sourceVersion,
    currentVerifySha256: owner.currentVerifySha256,
    contentSha256: owner.contentSha256,
    sourceTenantId: owner.sourceTenantId,
    sourceClientId: owner.sourceClientId,
    fullRead: policy.caseId === '20',
    passageSha256,
    responseSha256: createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'),
  });
  observations.set(policy, current);
}
export function readControlledReadHttpObservations(): MeriControlledReadAttempt[] | undefined {
  const policy = currentServerReadonlyCapturePolicy();
  return enabled(policy) ? structuredClone(observations.get(policy) ?? []) : undefined;
}
