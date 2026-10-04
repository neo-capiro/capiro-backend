import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { memoryCaptureSourcePolicyEnabled, verifyMeriMemoryCaptureSources, type MeriMemoryCaptureSource } from '@capiro/meriv2-core';
import {
  classifyApiToolReadOutcome,
  type MeriPendingMemoryProposalRead,
} from '@capiro/shared/meri-read-outcome';
import type {
  MeriServerReadonlyCapturePolicy,
  MeriControlledReadAttempt,
  MeriCaptureClockInvocation,
} from '@capiro/meriv2-core';
import { currentServerReadonlyCapturePolicy } from '../request/trusted-current-turn-scope.js';

const invocations = new AsyncLocalStorage<{
  policy: MeriServerReadonlyCapturePolicy;
  callId: string;
  clock?: MeriCaptureClockInvocation;
}>();
const observations = new WeakMap<MeriServerReadonlyCapturePolicy, MeriControlledReadAttempt[]>();
const memoryObservations = new WeakMap<MeriServerReadonlyCapturePolicy, Array<MeriMemoryCaptureSource & { callId: string; responseSha256: string }>>();
const clockInvocations = new WeakMap<
  MeriServerReadonlyCapturePolicy,
  MeriCaptureClockInvocation[]
>();
const clockEnabled = (
  p: MeriServerReadonlyCapturePolicy | null,
): p is MeriServerReadonlyCapturePolicy =>
  !!p?.semanticClock &&
  !p.syntheticReadBudget &&
  p.fixtureVersion === 'meri-live-v1-2026-09-26.1' &&
  ['01', '14', '20', '72'].includes(p.caseId ?? '');
const enabled = (p: MeriServerReadonlyCapturePolicy | null): p is MeriServerReadonlyCapturePolicy =>
  !!p && ['20', '21', '22', '23', '24', '26', '27', '72'].includes(p.caseId ?? '');

/** A refused boundary is not a provider call or HTTP dispatch. Retain the
 * missing identity so catching the error cannot turn an incomplete census into N/A. */
function retainClockRefusal(policy: MeriServerReadonlyCapturePolicy, tool: string): void {
  const rows = clockInvocations.get(policy) ?? [];
  rows.push({
    callId: '',
    tool,
    outcome: 'threw',
    httpAttempts: 0,
    httpStatus: null,
    responseSha256: null,
    packets: [],
  });
  clockInvocations.set(policy, rows);
}
/** Caller-owned actual function-call ID is set at the existing invocation owner. */
export async function withControlledReadInvocation<T>(
  callId: string | undefined,
  fn: () => Promise<T>,
  tool?: string,
): Promise<T> {
  const policy = currentServerReadonlyCapturePolicy();
  if (!enabled(policy) && !clockEnabled(policy)) return fn();
  if (!callId?.trim()) {
    if (clockEnabled(policy)) retainClockRefusal(policy, tool ?? '');
    throw new Error('Controlled read invocation identity missing.');
  }
  const clock: MeriCaptureClockInvocation | undefined = clockEnabled(policy)
    ? {
        callId,
        tool: tool ?? '',
        outcome: 'pending',
        httpAttempts: 0,
        httpStatus: null,
        responseSha256: null,
        packets: [],
      }
    : undefined;
  if (clock) {
    const rows = clockInvocations.get(policy) ?? [];
    rows.push(clock);
    clockInvocations.set(policy, rows);
  }
  return invocations.run({ policy, callId, clock }, async () => {
    try {
      const result = await fn();
      if (clock) clock.outcome = 'returned';
      return result;
    } catch (error) {
      if (clock) clock.outcome = 'threw';
      throw error;
    }
  });
}

/** Called immediately before each real fetch, including failed attempts. */
export function observeCaptureClockHttpAttempt(tool: string): void {
  const policy = currentServerReadonlyCapturePolicy();
  if (!clockEnabled(policy)) return;
  const invocation = invocations.getStore();
  if (invocation?.policy !== policy || !invocation.clock || invocation.clock.tool !== tool) {
    retainClockRefusal(policy, tool);
    throw new Error('Capture clock invocation missing.');
  }
  invocation.clock.httpAttempts++;
}

/** Raw API response metadata is retained independently of model projection. */
export function observeCaptureClockHttpResponse(
  tool: string,
  status: number,
  payload: unknown,
): void {
  const policy = currentServerReadonlyCapturePolicy();
  if (!clockEnabled(policy)) return;
  const row = invocations.getStore()?.clock;
  if (!row || row.tool !== tool || row.httpAttempts !== 1 || row.httpStatus !== null)
    throw new Error('Capture clock HTTP observation mismatch.');
  row.httpStatus = status;
  row.responseSha256 = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  if (tool === 'search_memory') {
    const value = payload as Record<string, unknown> | null;
    if (
      !Array.isArray(value?.contextPackets) ||
      !value.contextPackets.length ||
      value.contextPackets.length > 2 ||
      JSON.stringify(value.contextPacket) !== JSON.stringify(value.contextPackets.at(-1))
    )
      throw new Error('Capture clock compiler packets missing.');
    row.packets = structuredClone(value.contextPackets);
    if (memoryCaptureSourcePolicyEnabled(policy) && value.memoryCaptureSources !== undefined) {
      const outcome = classifyApiToolReadOutcome(tool, payload);
      if (status !== 200 || !outcome || !['complete', 'empty', 'partial'].includes(outcome.kind) ||
        value.tool !== 'search_memory' || value.error || value.blocked ||
        invocations.getStore()?.policy !== policy)
        throw new Error('Memory capture source HTTP outcome unproved.');
      const sources = verifyMeriMemoryCaptureSources(policy, value.records, value.memoryCaptureSources, process.env.INTERNAL_SERVICE_SECRET);
      const prior = memoryObservations.get(policy) ?? [];
      if (prior.some(s => s.callId === row.callId)) throw new Error('Memory capture source duplicate response.');
      memoryObservations.set(policy, [...prior, ...sources.map(s => ({ ...s, callId: row.callId, responseSha256: row.responseSha256! }))]);
    }
  } else if (tool === 'list_memory_proposals') {
    const value = payload as MeriPendingMemoryProposalRead | null;
    const outcome = classifyApiToolReadOutcome(tool, payload);
    if (
      !['01', '14'].includes(policy.caseId ?? '') ||
      status !== 200 ||
      !value ||
      typeof value !== 'object' ||
      value.scope?.tenantId !== policy.tenantId ||
      value.scope?.userId !== policy.actorUserId ||
      typeof policy.clientId !== 'string' ||
      !policy.clientId.trim() ||
      value.scope?.clientId !== policy.clientId ||
      !outcome ||
      !['complete', 'empty', 'partial'].includes(outcome.kind) ||
      ['contextPacket', 'contextPackets', 'records', 'sources', 'citations'].some(
        (key) => key in value,
      )
    )
      throw new Error('Capture clock proposal read unproved.');
    // This fixed owner reads the proposer queue without a compiler or relative
    // event-time window. Retain actual raw HTTP coverage, including partials;
    // the final join must still reject an incomplete proposal read.
    row.proposalRead = {
      authority: 'own_pending_proposals',
      tenantId: value.scope.tenantId,
      actorUserId: value.scope.userId,
      clientId: policy.clientId,
      semanticTime: 'not_used',
      compiler: 'not_run',
      claimsAreApprovedFacts: false,
      coverage: outcome.kind as 'complete' | 'empty' | 'partial',
    };
  }
}

/** Only read at completed native-turn assembly, after all invocation owners settle. */
export function readCaptureClockInvocations(): MeriCaptureClockInvocation[] | undefined {
  const policy = currentServerReadonlyCapturePolicy();
  return clockEnabled(policy) ? structuredClone(clockInvocations.get(policy) ?? []) : undefined;
}
/** Only verified actual API responses in this completed turn's policy scope. */
export function readMemoryCaptureHttpObservations() {
  const policy = currentServerReadonlyCapturePolicy();
  if (!memoryCaptureSourcePolicyEnabled(policy)) return [];
  const completed = new Set((clockInvocations.get(policy) ?? []).filter(row =>
    row.tool === 'search_memory' && row.outcome === 'returned' && row.httpAttempts === 1 && row.httpStatus === 200).map(row => row.callId));
  return structuredClone((memoryObservations.get(policy) ?? []).filter(row => completed.has(row.callId)));
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
    owner.sourceClientId !== (policy.caseId === '72' ? policy.clientId : null)
  )
    throw new Error('Controlled read source scope mismatch.');
  let passageSha256: string | null = null;
  let sourceReads: MeriControlledReadAttempt['sourceReads'];
  let coverage: Record<string, unknown> | null | undefined;
  if (policy.caseId !== '20' && policy.caseId !== '72') {
    const sources = owner.sourceReads;
    const rows = value?.records;
    if (
      !Array.isArray(sources) ||
      sources.length < 1 ||
      sources.length > 3 ||
      !Array.isArray(rows) ||
      rows.length !== sources.length ||
      new Set(sources.map((s: any) => s?.sourceId)).size !== sources.length ||
      new Set(rows.map((r: any) => r?.id)).size !== rows.length ||
      [
        'sourceId',
        'logicalSourceId',
        'sourceVersion',
        'contentSha256',
        'sourceTenantId',
        'sourceClientId',
      ].some((key) => sources[0]?.[key] !== owner[key])
    )
      throw new Error('Controlled read source set mismatch.');
    sourceReads = sources.map((source: any) => {
      const row = rows.find((r: any) => r?.id === source.sourceId);
      if (
        !/^[a-f0-9-]{36}$/.test(source.sourceId ?? '') ||
        typeof source.logicalSourceId !== 'string' ||
        !source.logicalSourceId ||
        source.sourceVersion !== 'v1' ||
        source.sourceTenantId !== policy.tenantId ||
        source.sourceClientId !== null ||
        !row ||
        row.sourceId !== source.sourceId ||
        row.sourceVersion !== source.sourceVersion ||
        typeof row.text !== 'string' ||
        !row.text
      )
        throw new Error('Controlled read source set scope mismatch.');
      const actualHash = createHash('sha256').update(row.text, 'utf8').digest('hex');
      if (actualHash !== source.contentSha256 || row.contentSha256 !== actualHash)
        throw new Error('Controlled read source set passage hash mismatch.');
      return {
        sourceId: source.sourceId,
        logicalSourceId: source.logicalSourceId,
        sourceVersion: source.sourceVersion,
        contentSha256: actualHash,
        sourceTenantId: source.sourceTenantId,
        sourceClientId: null,
        fullRead: true as const,
        passageSha256: actualHash,
      };
    });
    coverage = owner.coverage;
    if (
      coverage !== null &&
      (!coverage ||
        typeof coverage !== 'object' ||
        Array.isArray(coverage) ||
        coverage.complete !== true ||
        !Array.isArray(coverage.sourceIds) ||
        coverage.sourceIds.length !== sources.length ||
        coverage.sourceIds.some((id: unknown, i: number) => id !== sources[i].sourceId) ||
        JSON.stringify(value?.coverage) !== JSON.stringify(coverage))
    )
      throw new Error('Controlled read coverage provenance mismatch.');
    if (['23', '27'].includes(policy.caseId!) !== (coverage !== null))
      throw new Error('Controlled read coverage missing or unexpected.');
    passageSha256 = sourceReads[0]!.passageSha256;
  }
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
    fullRead: policy.caseId !== '72',
    passageSha256,
    ...(sourceReads ? { sourceReads, coverage: structuredClone(coverage) } : {}),
    responseSha256: createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'),
  });
  observations.set(policy, current);
}
export function readControlledReadHttpObservations(): MeriControlledReadAttempt[] | undefined {
  const policy = currentServerReadonlyCapturePolicy();
  return enabled(policy) ? structuredClone(observations.get(policy) ?? []) : undefined;
}
