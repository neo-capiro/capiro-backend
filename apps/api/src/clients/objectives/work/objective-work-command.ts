import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { objectiveConsentPolicyTerms } from '../../../auth/workload-authority/objective-consent-policy.js';

export type WorkAction = 'objective.strategy.draft' | 'objective.plan.prepare';
export type WorkCommand = {
  schemaVersion: 1; requestId: string; command: 'retry' | 'cancel'; workAction: WorkAction;
  expectedObjectiveVersion: number; expectedControlVersion: number;
  expectedCanonicalBindingVersion: number; targetAuthorizationRequestId: string | null;
};
export type WorkRequest = { clientId: string; objectiveId: string; command: WorkCommand };
export type WorkPairRequest = {
  clientId: string; objectiveId: string; strategy: WorkRequest; planner: WorkRequest;
};
/** Two existing action receipts. This is not a separately persisted pair receipt. */
export type WorkPairReceipt = { schemaVersion: 1; strategy: WorkReceipt; planner: WorkReceipt };
export type WorkReadRequest = { clientId: string; objectiveId: string; workAction: WorkAction; requestId?: string };
type Revision = { id: string; version: number };
type ConsentTimes = { id: string; confirmedAt: string; expiresAt: string };
export type WorkReceipt = {
  schemaVersion: 1; receiptId: string; requestId: string; payloadDigest: string;
  clientId: string; objectiveId: string; command: 'retry' | 'cancel'; workAction: WorkAction;
  commandRevision: Revision; sourceRevision: Revision; rootIntentId: string;
  controlVersionBefore: number; controlVersionAfter: number;
  targetAuthorizationRequestId: string | null; authorizationRequestId: string | null;
  consent: ConsentTimes | null; outcome: 'reconsent_recorded' | 'cancellation_recorded' | 'unchanged';
  committedAt: string;
};
export type WorkAuthority = {
  tenantId: string; actorUserId: string; actorMembershipId: string; clerkUserId: string;
  clientId: string; objectiveId: string; objectiveRevisionId: string; objectiveVersion: number;
  objectiveStatus: 'draft' | 'in_review' | 'ready';
};
export type WorkSource = {
  canonicalPlanId: string; canonicalEpoch: number; canonicalStrategyId: string; canonicalProjectId: string;
  canonicalBindingVersion: number; rootIntentId: string; sourceRevisionId: string;
  sourceObjectiveVersion: number; sourceSnapshotHash: string; rootActorUserId: string;
};
export type WorkControl = {
  id: string; version: number; currentConsentId: string | null;
  cancelledAt: string | null; cancelledByUserId: string | null;
};
export type WorkConsent = {
  id: string; controlId: string; source: WorkSource; previousConsentId: string | null;
  actorUserId: string; actorMembershipId: string; policyId: string; policyRevision: number;
  configuredDurationMs: number; effectiveDurationMs: number; stricterExpiresAt: string | null;
  stricterLimitRef: string | null; confirmedAt: string; expiresAt: string;
  commandRequestId: string; commandReceiptId: string; payloadDigest: string;
};
export type WorkState = { source: WorkSource; control: WorkControl | null; consent: WorkConsent | null };
export type StoredWorkReceipt = {
  receipt: WorkReceipt; command: WorkCommand; source: WorkSource; controlId: string;
  actorUserId: string; actorMembershipId: string;
};
/** Authoritative owner facts, never a caller's claimed job state. A null head
 * does not establish not_started. Accounted failure needs the original receipt. */
export type WorkReconciliation = {
  state: 'not_started' | 'accounted' | 'outcome_unconfirmed' | 'unavailable';
  tenantId: string; clientId: string; objectiveId: string; workAction: WorkAction;
  authorizationRequestId: string | null; rootIntentId: string;
  canonicalPlanId: string; canonicalEpoch: number;
  operationId?: string; attemptId?: string; runId?: string; requestFingerprint?: string;
  originalDeadlineAt?: string; terminalReceiptId?: string;
  outcome?: 'failed' | 'cancelled' | 'applied';
};
export type WorkPolicyFacts = {
  configuredDurationMs: number | null; tenantDurationLimitMs: number | null;
  actionDurationLimitMs: number | null; originalTokenExpiresAtMs: number;
  originalDelegationExpiresAtMs: number | null; limitReference: string;
};
export interface WorkTransaction {
  /** A connected effect owner takes its resource/claim gate before Core locks. */
  lockOwner(): Promise<void>;
  currentAuthority(): Promise<WorkAuthority>;
  receipt(authority: WorkAuthority, action: WorkAction, requestId: string): Promise<StoredWorkReceipt | null>;
  /** lockOnly locks existing rows without creating an empty control. */
  state(authority: WorkAuthority, action: WorkAction, createControl: boolean, lockOnly?: boolean): Promise<WorkState>;
  clock(): Promise<string>;
  /** The connected owner must join the exact original immutable operation,
   * attempt, run, fingerprint, deadline and receipt; syntax is not that proof. */
  reconcile(authority: WorkAuthority, action: WorkAction, state: WorkState): Promise<WorkReconciliation>;
  policy(authority: WorkAuthority, action: WorkAction, state: WorkState): Promise<WorkPolicyFacts>;
  insertConsent(authority: WorkAuthority, action: WorkAction, consent: WorkConsent): Promise<void>;
  casControl(authority: WorkAuthority, action: WorkAction, before: WorkControl, after: WorkControl): Promise<boolean>;
  insertReceipt(authority: WorkAuthority, stored: StoredWorkReceipt): Promise<void>;
  newId(): string;
}
export interface WorkOwner {
  transaction<T>(write: boolean, run: (tx: WorkTransaction) => Promise<T>): Promise<T>;
}
export type WorkPairTransaction = { strategy: WorkTransaction; planner: WorkTransaction };
export interface WorkPairOwner {
  /** Both ports must use the same transaction and original native proof. */
  transaction<T>(write: boolean, run: (tx: WorkPairTransaction) => Promise<T>): Promise<T>;
}
export type WorkErrorCode = 'INVALID_REQUEST' | 'NOT_AVAILABLE' | 'OBJECTIVE_VERSION_CONFLICT'
  | 'CONTROL_VERSION_CONFLICT' | 'CANONICAL_VERSION_CONFLICT' | 'REQUEST_ID_CONFLICT'
  | 'OUTCOME_UNCONFIRMED' | 'AUTHORITY_UNAVAILABLE' | 'RECEIPT_UNVERIFIABLE';
export class ObjectiveWorkError extends Error {
  readonly code: WorkErrorCode; readonly requestId: string | null;
  constructor(code: WorkErrorCode, requestId: string | null = null) {
    super(code); this.code = code; this.requestId = requestId;
  }
}
export function workFailure(code: WorkErrorCode, requestId: string | null = null): never {
  throw new ObjectiveWorkError(code, requestId);
}
const INT_MAX = 2147483647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
export function workUuid(value: unknown): string {
  if (typeof value !== 'string' || UUID.exec(value)?.[0] !== value) return workFailure('INVALID_REQUEST');
  return value.toLowerCase();
}
function integer(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > INT_MAX)
    return workFailure('INVALID_REQUEST');
  return value;
}
function closed(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || Array.isArray(value))
    return workFailure('INVALID_REQUEST');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return workFailure('INVALID_REQUEST');
  const own = Reflect.ownKeys(value);
  if (own.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) return workFailure('INVALID_REQUEST');
  const result: Record<string, unknown> = {};
  for (const key of own as string[]) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !('value' in d)) return workFailure('INVALID_REQUEST');
    result[key] = d.value;
  }
  return result;
}
function action(value: unknown): WorkAction {
  if (value !== 'objective.strategy.draft' && value !== 'objective.plan.prepare') return workFailure('INVALID_REQUEST');
  return value;
}
function nullableUuid(value: unknown): string | null { return value === null ? null : workUuid(value); }
function utc(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    return workFailure('INVALID_REQUEST');
  return value;
}
export function parseWorkCommand(client: unknown, objective: unknown, raw: unknown): WorkRequest {
  const v = closed(raw, ['schemaVersion', 'requestId', 'command', 'workAction', 'expectedObjectiveVersion',
    'expectedControlVersion', 'expectedCanonicalBindingVersion', 'targetAuthorizationRequestId']);
  if (v.schemaVersion !== 1 || (v.command !== 'retry' && v.command !== 'cancel')) return workFailure('INVALID_REQUEST');
  return { clientId: workUuid(client), objectiveId: workUuid(objective), command: {
    schemaVersion: 1, requestId: workUuid(v.requestId), command: v.command, workAction: action(v.workAction),
    expectedObjectiveVersion: integer(v.expectedObjectiveVersion), expectedControlVersion: integer(v.expectedControlVersion, 0),
    expectedCanonicalBindingVersion: integer(v.expectedCanonicalBindingVersion),
    targetAuthorizationRequestId: nullableUuid(v.targetAuthorizationRequestId),
  } };
}
export function parseWorkRead(client: unknown, objective: unknown, raw: unknown): WorkReadRequest {
  const v = closed(raw, ['workAction'], ['requestId']);
  return { clientId: workUuid(client), objectiveId: workUuid(objective), workAction: action(v.workAction),
    ...(Object.hasOwn(v, 'requestId') ? { requestId: workUuid(v.requestId) } : {}) };
}
export function parseWorkPairConfirmation(client: unknown, objective: unknown, raw: unknown): WorkPairRequest {
  const v = closed(raw, ['schemaVersion', 'expectedObjectiveVersion', 'expectedCanonicalBindingVersion', 'strategy', 'planner']);
  if (v.schemaVersion !== 1) return workFailure('INVALID_REQUEST');
  const clientId = workUuid(client), objectiveId = workUuid(objective);
  const expectedObjectiveVersion = integer(v.expectedObjectiveVersion);
  const expectedCanonicalBindingVersion = integer(v.expectedCanonicalBindingVersion);
  const command = (value: unknown, workAction: WorkAction) => {
    const c = closed(value, ['requestId', 'expectedControlVersion', 'targetAuthorizationRequestId']);
    return parseWorkCommand(clientId, objectiveId, { schemaVersion: 1, command: 'retry', workAction,
      expectedObjectiveVersion, expectedCanonicalBindingVersion, ...c });
  };
  return { clientId, objectiveId, strategy: command(v.strategy, 'objective.strategy.draft'),
    planner: command(v.planner, 'objective.plan.prepare') };
}
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function workDigest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function checkAuthority(a: WorkAuthority, request: { clientId: string; objectiveId: string }) {
  try {
    for (const id of [a.tenantId, a.actorUserId, a.actorMembershipId, a.objectiveRevisionId]) workUuid(id);
    if (a.clientId !== request.clientId || a.objectiveId !== request.objectiveId ||
        typeof a.clerkUserId !== 'string' || !a.clerkUserId ||
        !['draft', 'in_review', 'ready'].includes(a.objectiveStatus)) throw Error();
    integer(a.objectiveVersion);
  } catch { workFailure('NOT_AVAILABLE'); }
}
function checkSource(s: WorkSource) {
  for (const id of [s.canonicalPlanId, s.canonicalStrategyId, s.canonicalProjectId, s.rootIntentId,
    s.sourceRevisionId, s.rootActorUserId]) workUuid(id);
  integer(s.canonicalBindingVersion); integer(s.sourceObjectiveVersion);
  if (s.canonicalEpoch !== 1 || typeof s.sourceSnapshotHash !== 'string' ||
      HASH.exec(s.sourceSnapshotHash)?.[0] !== s.sourceSnapshotHash) throw Error();
}
function checkState(state: WorkState) {
  checkSource(state.source);
  const c = state.control;
  if (!c) { if (state.consent) throw Error(); return; }
  workUuid(c.id); integer(c.version, 0); nullableUuid(c.currentConsentId);
  if ((c.cancelledAt === null) !== (c.cancelledByUserId === null)) throw Error();
  if (c.cancelledAt !== null) { utc(c.cancelledAt); workUuid(c.cancelledByUserId); }
  if (c.version === 0 && (c.currentConsentId !== null || c.cancelledAt !== null)) throw Error();
  if (c.version > 0 && c.currentConsentId === null && c.cancelledAt === null) throw Error();
  if (c.currentConsentId !== null) {
    if (!state.consent || state.consent.id !== c.currentConsentId || state.consent.controlId !== c.id) throw Error();
    checkSource(state.consent.source); utc(state.consent.confirmedAt); utc(state.consent.expiresAt);
    if (Date.parse(state.consent.expiresAt) <= Date.parse(state.consent.confirmedAt)) throw Error();
  } else if (state.consent) throw Error();
}
function verifiedReceipt(stored: StoredWorkReceipt, a: WorkAuthority, request: WorkReadRequest): WorkReceipt {
  try {
    const r = stored.receipt;
    closed(r, ['schemaVersion', 'receiptId', 'requestId', 'payloadDigest', 'clientId', 'objectiveId', 'command',
      'workAction', 'commandRevision', 'sourceRevision', 'rootIntentId', 'controlVersionBefore', 'controlVersionAfter',
      'targetAuthorizationRequestId', 'authorizationRequestId', 'consent', 'outcome', 'committedAt']);
    const normalized = parseWorkCommand(request.clientId, request.objectiveId, stored.command);
    checkSource(stored.source); workUuid(stored.controlId); workUuid(stored.actorMembershipId);
    workUuid(r.receiptId); utc(r.committedAt);
    for (const revision of [r.commandRevision, r.sourceRevision]) {
      closed(revision, ['id', 'version']); workUuid(revision.id); integer(revision.version);
    }
    nullableUuid(r.targetAuthorizationRequestId); nullableUuid(r.authorizationRequestId);
    const c = normalized.command;
    if (r.schemaVersion !== 1 || canonical(c) !== canonical(stored.command) ||
        r.requestId !== request.requestId || r.requestId !== c.requestId || r.workAction !== request.workAction ||
        r.clientId !== request.clientId || r.objectiveId !== request.objectiveId || r.command !== c.command ||
        stored.actorUserId !== a.actorUserId || r.payloadDigest !== workDigest(normalized) ||
        r.commandRevision.version !== c.expectedObjectiveVersion ||
        stored.source.canonicalBindingVersion !== c.expectedCanonicalBindingVersion ||
        r.sourceRevision.id !== stored.source.sourceRevisionId || r.sourceRevision.version !== stored.source.sourceObjectiveVersion ||
        r.rootIntentId !== stored.source.rootIntentId || r.controlVersionBefore !== c.expectedControlVersion ||
        r.targetAuthorizationRequestId !== c.targetAuthorizationRequestId) throw Error();
    integer(r.controlVersionBefore, 0); integer(r.controlVersionAfter, 0);
    if (c.command === 'retry') {
      if (!r.consent) throw Error();
      closed(r.consent, ['id', 'confirmedAt', 'expiresAt']); workUuid(r.consent.id);
      utc(r.consent.confirmedAt); utc(r.consent.expiresAt);
      if (Date.parse(r.consent.expiresAt) <= Date.parse(r.consent.confirmedAt) ||
          Date.parse(r.committedAt) < Date.parse(r.consent.confirmedAt) ||
          Date.parse(r.committedAt) >= Date.parse(r.consent.expiresAt) ||
          r.authorizationRequestId !== r.consent.id || r.outcome !== 'reconsent_recorded' ||
          r.controlVersionAfter !== r.controlVersionBefore + 1) throw Error();
    } else if (r.consent !== null || r.authorizationRequestId !== r.targetAuthorizationRequestId ||
        !['cancellation_recorded', 'unchanged'].includes(r.outcome) ||
        r.controlVersionAfter !== r.controlVersionBefore + (r.outcome === 'unchanged' ? 0 : 1)) throw Error();
    return r;
  } catch { return workFailure('RECEIPT_UNVERIFIABLE', request.requestId ?? null); }
}
async function recover(tx: WorkTransaction, a: WorkAuthority, request: WorkRequest) {
  const stored = await tx.receipt(a, request.command.workAction, request.command.requestId);
  if (!stored) return null;
  const r = verifiedReceipt(stored, a, { ...request, workAction: request.command.workAction, requestId: request.command.requestId });
  if (r.payloadDigest !== workDigest(request)) workFailure('REQUEST_ID_CONFLICT', request.command.requestId);
  return r;
}
function reconciliationState(e: WorkReconciliation, a: WorkAuthority, action: WorkAction, state: WorkState) {
  if (e.state === 'unavailable') return 'unavailable';
  if (!['not_started', 'accounted', 'outcome_unconfirmed'].includes(e.state) ||
      e.tenantId !== a.tenantId || e.clientId !== a.clientId || e.objectiveId !== a.objectiveId ||
      e.workAction !== action || e.authorizationRequestId !== state.control?.currentConsentId &&
        !(e.authorizationRequestId === null && !state.control?.currentConsentId) ||
      e.rootIntentId !== (state.consent?.source.rootIntentId ?? state.source.rootIntentId) ||
      e.canonicalPlanId !== state.source.canonicalPlanId || e.canonicalEpoch !== state.source.canonicalEpoch)
    return 'outcome_unconfirmed';
  if (e.state === 'accounted') {
    try {
      for (const id of [e.operationId, e.attemptId, e.runId, e.terminalReceiptId]) workUuid(id);
      utc(e.originalDeadlineAt);
      if (typeof e.requestFingerprint !== 'string' || HASH.exec(e.requestFingerprint)?.[0] !== e.requestFingerprint ||
          !['failed', 'cancelled', 'applied'].includes(e.outcome ?? '')) throw Error();
    } catch { return 'outcome_unconfirmed'; }
  }
  return e.state;
}
async function retryPreflight(tx: WorkTransaction, a: WorkAuthority, request: WorkRequest, state: WorkState) {
  const c = request.command, source = state.source;
  if (a.objectiveStatus !== 'ready' || a.objectiveRevisionId !== source.sourceRevisionId ||
      a.objectiveVersion !== source.sourceObjectiveVersion) workFailure('OBJECTIVE_VERSION_CONFLICT', c.requestId);
  const evidence = await tx.reconcile(a, c.workAction, state);
  const outcome = reconciliationState(evidence, a, c.workAction, state);
  if (outcome === 'unavailable') workFailure('AUTHORITY_UNAVAILABLE', c.requestId);
  if (outcome === 'outcome_unconfirmed' || outcome === 'accounted' && evidence.outcome === 'applied')
    workFailure('OUTCOME_UNCONFIRMED', c.requestId);
  const facts = await tx.policy(a, c.workAction, state);
  if (typeof facts.limitReference !== 'string' || !facts.limitReference || facts.limitReference.length > 128 ||
      !Number.isSafeInteger(facts.originalTokenExpiresAtMs)) workFailure('AUTHORITY_UNAVAILABLE', c.requestId);
  return facts;
}
function retryTerms(request: WorkRequest, facts: WorkPolicyFacts, now: string) {
  try {
    return objectiveConsentPolicyTerms({ operation: request.command.workAction, databaseNowMs: Date.parse(now),
      configuredDurationMs: facts.configuredDurationMs, tenantDurationLimitMs: facts.tenantDurationLimitMs,
      actionDurationLimitMs: facts.actionDurationLimitMs, originalTokenExpiresAtMs: facts.originalTokenExpiresAtMs,
      originalDelegationExpiresAtMs: facts.originalDelegationExpiresAtMs, priorOutcomeUnconfirmed: false });
  } catch { return workFailure('AUTHORITY_UNAVAILABLE', request.command.requestId); }
}
function retryConsent(tx: WorkTransaction, a: WorkAuthority, request: WorkRequest, state: WorkState,
  facts: WorkPolicyFacts, now: string, terms: ReturnType<typeof retryTerms>): WorkConsent {
  if (!state.control) return workFailure('AUTHORITY_UNAVAILABLE', request.command.requestId);
  const receiptId = workUuid(tx.newId());
  return { id: workUuid(tx.newId()), controlId: state.control.id, source: state.source,
    previousConsentId: state.control.currentConsentId, actorUserId: a.actorUserId, actorMembershipId: a.actorMembershipId,
    policyId: terms.policyId, policyRevision: terms.policyRevision, configuredDurationMs: terms.configuredDurationMs,
    effectiveDurationMs: terms.effectiveDurationMs, stricterExpiresAt: new Date(terms.expiresAtMs).toISOString(),
    stricterLimitRef: facts.limitReference, confirmedAt: now, expiresAt: new Date(terms.expiresAtMs).toISOString(),
    commandRequestId: request.command.requestId, commandReceiptId: receiptId, payloadDigest: workDigest(request) };
}
export async function executeWorkCommand(request: WorkRequest, owner: WorkOwner): Promise<WorkReceipt> {
  const early = await owner.transaction(false, async tx => {
    const a = await tx.currentAuthority(); checkAuthority(a, request);
    return recover(tx, a, request);
  });
  if (early) return early;
  return owner.transaction(true, async tx => {
    await tx.lockOwner();
    const a = await tx.currentAuthority(); checkAuthority(a, request);
    const replay = await recover(tx, a, request); if (replay) return replay;
    const c = request.command;
    if (a.objectiveVersion !== c.expectedObjectiveVersion || c.command === 'retry' && a.objectiveStatus !== 'ready')
      workFailure('OBJECTIVE_VERSION_CONFLICT', c.requestId);
    const state = await tx.state(a, c.workAction, true);
    const lockedReplay = await recover(tx, a, request); if (lockedReplay) return lockedReplay;
    const { source, control } = state;
    try { checkState(state); } catch { workFailure('AUTHORITY_UNAVAILABLE', c.requestId); }
    if (!control) workFailure('AUTHORITY_UNAVAILABLE', c.requestId);
    if (source.canonicalBindingVersion !== c.expectedCanonicalBindingVersion) workFailure('CANONICAL_VERSION_CONFLICT', c.requestId);
    if (control.version !== c.expectedControlVersion || control.currentConsentId !== c.targetAuthorizationRequestId)
      workFailure('CONTROL_VERSION_CONFLICT', c.requestId);
    let now: string;
    const changed = c.command === 'retry' || control.cancelledAt === null;
    if (changed && control.version === INT_MAX) workFailure('CONTROL_VERSION_CONFLICT', c.requestId);
    const payloadDigest = workDigest(request);
    let receiptId: string;
    let consent: WorkConsent | null = null;
    if (c.command === 'retry') {
      const facts = await retryPreflight(tx, a, request, state);
      // Owner/settings ports may acquire their own already-ordered local locks.
      // Sample the DB clock after those waits, never before them.
      now = utc(await tx.clock());
      consent = retryConsent(tx, a, request, state, facts, now, retryTerms(request, facts, now));
      receiptId = consent.commandReceiptId;
      await tx.insertConsent(a, c.workAction, consent);
    } else { now = utc(await tx.clock()); receiptId = workUuid(tx.newId()); }
    const after: WorkControl = { ...control, version: control.version + (changed ? 1 : 0),
      currentConsentId: consent?.id ?? control.currentConsentId,
      cancelledAt: c.command === 'cancel' ? control.cancelledAt ?? now : null,
      cancelledByUserId: c.command === 'cancel' ? control.cancelledByUserId ?? a.actorUserId : null };
    if (changed && !(await tx.casControl(a, c.workAction, control, after))) workFailure('CONTROL_VERSION_CONFLICT', c.requestId);
    const committedAt = utc(await tx.clock());
    if (consent && Date.parse(consent.expiresAt) <= Date.parse(committedAt)) workFailure('AUTHORITY_UNAVAILABLE', c.requestId);
    const receipt: WorkReceipt = { schemaVersion: 1, receiptId, requestId: c.requestId, payloadDigest,
      clientId: a.clientId, objectiveId: a.objectiveId, command: c.command, workAction: c.workAction,
      commandRevision: { id: a.objectiveRevisionId, version: a.objectiveVersion },
      sourceRevision: { id: source.sourceRevisionId, version: source.sourceObjectiveVersion }, rootIntentId: source.rootIntentId,
      controlVersionBefore: control.version, controlVersionAfter: after.version,
      targetAuthorizationRequestId: c.targetAuthorizationRequestId, authorizationRequestId: after.currentConsentId,
      consent: consent ? { id: consent.id, confirmedAt: consent.confirmedAt, expiresAt: consent.expiresAt } : null,
      outcome: c.command === 'retry' ? 'reconsent_recorded' : changed ? 'cancellation_recorded' : 'unchanged', committedAt };
    await tx.insertReceipt(a, { receipt, command: c, source, controlId: control.id,
      actorUserId: a.actorUserId, actorMembershipId: a.actorMembershipId });
    return receipt;
  });
}
function pairState(a: WorkAuthority, request: WorkRequest, state: WorkState) {
  const c = request.command;
  try { checkState(state); } catch { workFailure('AUTHORITY_UNAVAILABLE', c.requestId); }
  if (a.objectiveVersion !== c.expectedObjectiveVersion || a.objectiveStatus !== 'ready' ||
      a.objectiveRevisionId !== state.source.sourceRevisionId || a.objectiveVersion !== state.source.sourceObjectiveVersion)
    workFailure('OBJECTIVE_VERSION_CONFLICT', c.requestId);
  if (state.source.canonicalBindingVersion !== c.expectedCanonicalBindingVersion)
    workFailure('CANONICAL_VERSION_CONFLICT', c.requestId);
  if ((state.control?.version ?? 0) !== c.expectedControlVersion ||
      (state.control?.currentConsentId ?? null) !== c.targetAuthorizationRequestId || state.control?.version === INT_MAX)
    workFailure('CONTROL_VERSION_CONFLICT', c.requestId);
}
async function recoverPair(tx: WorkPairTransaction, a: WorkAuthority, request: WorkPairRequest): Promise<WorkPairReceipt | null> {
  const strategy = await recover(tx.strategy, a, request.strategy);
  const planner = await recover(tx.planner, a, request.planner);
  // Never create the missing half of a previously recorded request. Two exact
  // receipts are historical action receipts, not proof of a persisted pair.
  if ((strategy === null) !== (planner === null))
    workFailure('OUTCOME_UNCONFIRMED', strategy === null ? request.strategy.command.requestId : request.planner.command.requestId);
  return strategy && planner ? { schemaVersion: 1, strategy, planner } : null;
}
export async function executeWorkPairConfirmation(request: WorkPairRequest, owner: WorkPairOwner): Promise<WorkPairReceipt> {
  const s = request.strategy, p = request.planner;
  if (s.clientId !== request.clientId || p.clientId !== request.clientId || s.objectiveId !== request.objectiveId ||
      p.objectiveId !== request.objectiveId || s.command.command !== 'retry' || p.command.command !== 'retry' ||
      s.command.workAction !== 'objective.strategy.draft' || p.command.workAction !== 'objective.plan.prepare' ||
      s.command.expectedObjectiveVersion !== p.command.expectedObjectiveVersion ||
      s.command.expectedCanonicalBindingVersion !== p.command.expectedCanonicalBindingVersion)
    workFailure('INVALID_REQUEST');
  const early = await owner.transaction(false, async tx => {
    const a = await tx.strategy.currentAuthority(); checkAuthority(a, request);
    return recoverPair(tx, a, request);
  });
  if (early) return early;
  return owner.transaction(true, async tx => {
    // A connected owner must preserve Planner -> job -> Strategy before Core.
    await tx.planner.lockOwner(); await tx.strategy.lockOwner();
    const a = await tx.strategy.currentAuthority(); checkAuthority(a, request);
    const replay = await recoverPair(tx, a, request); if (replay) return replay;
    const plannerState = await tx.planner.state(a, request.planner.command.workAction, false, true);
    const strategyState = await tx.strategy.state(a, request.strategy.command.workAction, false, true);
    const lockedReplay = await recoverPair(tx, a, request); if (lockedReplay) return lockedReplay;
    pairState(a, request.planner, plannerState); pairState(a, request.strategy, strategyState);
    if (canonical(plannerState.source) !== canonical(strategyState.source)) workFailure('AUTHORITY_UNAVAILABLE');
    const plannerFacts = await retryPreflight(tx.planner, a, request.planner, plannerState);
    const strategyFacts = await retryPreflight(tx.strategy, a, request.strategy, strategyState);
    if (plannerFacts.originalTokenExpiresAtMs !== strategyFacts.originalTokenExpiresAtMs) workFailure('AUTHORITY_UNAVAILABLE');
    const now = utc(await tx.strategy.clock());
    // Both actual policies must pass before even an empty control is inserted.
    const plannerTerms = retryTerms(request.planner, plannerFacts, now);
    const strategyTerms = retryTerms(request.strategy, strategyFacts, now);
    const materialize = async (port: WorkTransaction, r: WorkRequest, before: WorkState) => {
      if (before.control) return before;
      const after = await port.state(a, r.command.workAction, true);
      pairState(a, r, after);
      if (!after.control || canonical(after.source) !== canonical(before.source)) workFailure('AUTHORITY_UNAVAILABLE');
      return after;
    };
    const planner = await materialize(tx.planner, request.planner, plannerState);
    const strategy = await materialize(tx.strategy, request.strategy, strategyState);
    const plannerConsent = retryConsent(tx.planner, a, request.planner, planner, plannerFacts, now, plannerTerms);
    const strategyConsent = retryConsent(tx.strategy, a, request.strategy, strategy, strategyFacts, now, strategyTerms);
    if (plannerConsent.id === strategyConsent.id || plannerConsent.controlId === strategyConsent.controlId ||
        new Set([plannerConsent.id, strategyConsent.id, plannerConsent.commandReceiptId, strategyConsent.commandReceiptId]).size !== 4)
      workFailure('AUTHORITY_UNAVAILABLE');
    const save = async (port: WorkTransaction, r: WorkRequest, state: WorkState, consent: WorkConsent) => {
      const before = state.control!;
      await port.insertConsent(a, r.command.workAction, consent);
      const after = { ...before, version: before.version + 1, currentConsentId: consent.id,
        cancelledAt: null, cancelledByUserId: null };
      if (!(await port.casControl(a, r.command.workAction, before, after)))
        workFailure('CONTROL_VERSION_CONFLICT', r.command.requestId);
    };
    await save(tx.planner, request.planner, planner, plannerConsent);
    await save(tx.strategy, request.strategy, strategy, strategyConsent);
    const committedAt = utc(await tx.strategy.clock());
    const receipt = (r: WorkRequest, state: WorkState, consent: WorkConsent): WorkReceipt => ({
      schemaVersion: 1, receiptId: consent.commandReceiptId, requestId: r.command.requestId, payloadDigest: consent.payloadDigest,
      clientId: a.clientId, objectiveId: a.objectiveId, command: 'retry', workAction: r.command.workAction,
      commandRevision: { id: a.objectiveRevisionId, version: a.objectiveVersion },
      sourceRevision: { id: state.source.sourceRevisionId, version: state.source.sourceObjectiveVersion }, rootIntentId: state.source.rootIntentId,
      controlVersionBefore: state.control!.version, controlVersionAfter: state.control!.version + 1,
      targetAuthorizationRequestId: r.command.targetAuthorizationRequestId, authorizationRequestId: consent.id,
      consent: { id: consent.id, confirmedAt: consent.confirmedAt, expiresAt: consent.expiresAt },
      outcome: 'reconsent_recorded', committedAt });
    const result: WorkPairReceipt = { schemaVersion: 1, strategy: receipt(request.strategy, strategy, strategyConsent),
      planner: receipt(request.planner, planner, plannerConsent) };
    const checkExpiry = (clock: string) => {
      if (Date.parse(clock) < Date.parse(now) || [plannerConsent, strategyConsent].some(c => Date.parse(c.expiresAt) <= Date.parse(clock)))
        workFailure('AUTHORITY_UNAVAILABLE');
    };
    checkExpiry(committedAt);
    await tx.planner.insertReceipt(a, { receipt: result.planner, command: request.planner.command, source: planner.source,
      controlId: planner.control!.id, actorUserId: a.actorUserId, actorMembershipId: a.actorMembershipId });
    await tx.strategy.insertReceipt(a, { receipt: result.strategy, command: request.strategy.command, source: strategy.source,
      controlId: strategy.control!.id, actorUserId: a.actorUserId, actorMembershipId: a.actorMembershipId });
    checkExpiry(utc(await tx.strategy.clock()));
    return result;
  });
}
export async function readWorkGeneration(request: WorkReadRequest, owner: WorkOwner) {
  return owner.transaction(false, async tx => {
    const a = await tx.currentAuthority(); checkAuthority(a, request);
    let receipt: WorkReceipt | null = null;
    if (request.requestId) {
      const stored = await tx.receipt(a, request.workAction, request.requestId);
      if (!stored) workFailure('NOT_AVAILABLE', request.requestId);
      receipt = verifiedReceipt(stored, a, request);
    }
    const state = await tx.state(a, request.workAction, false);
    try { checkState(state); } catch { workFailure('AUTHORITY_UNAVAILABLE', request.requestId ?? null); }
    const observedAt = utc(await tx.clock());
    const evidence = await tx.reconcile(a, request.workAction, state);
    const reconciled = reconciliationState(evidence, a, request.workAction, state);
    return { schemaVersion: 1 as const, clientId: a.clientId,
      objective: { id: a.objectiveId, revision: { id: a.objectiveRevisionId, version: a.objectiveVersion }, status: a.objectiveStatus },
      workAction: request.workAction,
      control: { version: state.control?.version ?? 0, currentAuthorizationRequestId: state.control?.currentConsentId ?? null,
        cancelledAt: state.control?.cancelledAt ?? null },
      consent: state.consent ? { id: state.consent.id, confirmedAt: state.consent.confirmedAt,
        expiresAt: state.consent.expiresAt, expired: Date.parse(state.consent.expiresAt) <= Date.parse(observedAt) } : null,
      reconciliation: reconciled === 'unavailable' ? 'outcome_unconfirmed' : reconciled,
      commandReceipt: receipt, observedAt };
  });
}
