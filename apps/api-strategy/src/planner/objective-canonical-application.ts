import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { CanonicalMaterializationBinding, MaterializationResult, StoredCanonicalMaterialization } from './strategy-materialization.js';

/** Private server contract. A reservation, digest or posted actor is never a credential. */
export type CanonicalToken = CanonicalMaterializationBinding['canonical'];
export interface CanonicalApplicationRequest {
  schemaVersion: 1;
  canonical: CanonicalToken;
  applicationRequestId: string;
  generationJobId: string;
  generationRequestId: string;
  strategyId: string;
  strategyVersionId: string;
  objectiveReceiptSha256: string;
  snapshotDigest: string;
}
export interface CanonicalApplicationGrant {
  tenantId: string;
  actorUserId: string;
  clerkUserId: string;
  consentId: string;
  controlVersion: number;
  tokenExpiresAtMs: number;
  delegationExpiresAtMs: number;
  claimExpiresAtMs: number;
  requestSha256: string;
  canonicalSha256: string;
}
export const CANONICAL_APPLICATION_RECEIPT = 'objective_canonical_application_receipt';
export const CANONICAL_APPLICATION_HEAD = 'objective_canonical_application_head';
export const CANONICAL_APPLICATION_OPERATION = 'objective.plan.prepare';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const TOKEN_KEYS = ['canonicalPlanId', 'tenantId', 'clientId', 'objectiveId', 'canonicalStrategyId',
  'canonicalProjectId', 'bindingVersion', 'epoch', 'requestedIntentId',
  'requestedObjectiveRevisionId', 'requestedObjectiveVersion', 'snapshotHash'];
const INTEGERS = ['bindingVersion', 'epoch', 'requestedObjectiveVersion'];
export class CanonicalApplicationError extends Error {
  readonly code: 'INPUT_INVALID' | 'NOT_AVAILABLE' | 'REQUEST_CONFLICT' |
    'SOURCE_STALE' | 'AUTHORITY_UNAVAILABLE' | 'OUTCOME_UNCONFIRMED';
  constructor(code: CanonicalApplicationError['code']) { super(code); this.code = code; }
}
function invalid(): never { throw new CanonicalApplicationError('INPUT_INVALID'); }
function closed(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || Array.isArray(raw)) return invalid();
  if (![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).length !== keys.length || keys.some(k => !Object.hasOwn(descriptors, k) ||
    !descriptors[k]!.enumerable || !Object.hasOwn(descriptors[k]!, 'value'))) return invalid();
  return Object.fromEntries(keys.map(k => [k, descriptors[k]!.value]));
}
function integer(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw <= 2147483647;
}
const matches = (pattern: RegExp, value: unknown): value is string =>
  typeof value === 'string' && pattern.exec(value)?.[0] === value;
export function applicationUuid(raw: unknown): string {
  if (!matches(UUID, raw)) return invalid();
  return raw;
}
export function parseCanonicalApplication(raw: unknown): CanonicalApplicationRequest {
  const r = closed(raw, ['schemaVersion', 'canonical', 'applicationRequestId', 'generationJobId',
    'generationRequestId', 'strategyId', 'strategyVersionId', 'objectiveReceiptSha256', 'snapshotDigest']);
  const c = closed(r.canonical, TOKEN_KEYS);
  for (const key of TOKEN_KEYS) {
    if (INTEGERS.includes(key)) { if (!integer(c[key])) return invalid(); }
    else if (!matches(key === 'snapshotHash' ? SHA : UUID, c[key])) return invalid();
  }
  if (r.schemaVersion !== 1 || c.epoch !== 1 || r.strategyId !== c.canonicalStrategyId) return invalid();
  for (const key of ['applicationRequestId', 'generationJobId', 'generationRequestId', 'strategyId', 'strategyVersionId'])
    applicationUuid(r[key]);
  for (const key of ['objectiveReceiptSha256', 'snapshotDigest'])
    if (!matches(SHA, r[key])) return invalid();
  return { ...r, canonical: c } as unknown as CanonicalApplicationRequest;
}

/** RFC8259 finite JSON; sorted object keys, original array order, no whitespace.
 * This is the existing Objective digest convention, not RFC8785/JCS. */
export function applicationJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) return invalid();
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== value.length + 1 ||
        Array.from({ length: value.length }, (_, i) => descriptors[String(i)])
          .some(d => !d || !d.enumerable || !Object.hasOwn(d, 'value'))) return invalid();
    return '[' + Array.from({ length: value.length }, (_, i) => applicationJson(descriptors[String(i)]!.value)).join(',') + ']';
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some(k => typeof k !== 'string' || !descriptors[k]!.enumerable || !Object.hasOwn(descriptors[k]!, 'value'))) return invalid();
  return '{' + (keys as string[]).sort().map(k => JSON.stringify(k) + ':' + applicationJson(descriptors[k]!.value)).join(',') + '}';
}
export const applicationHash = (value: unknown) => createHash('sha256').update(applicationJson(value), 'utf8').digest('hex');
function privateUuid(value: unknown): string {
  const h = applicationHash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Same original full reservation + original native actor => same effect identity.
 * Changed job/version/result under this identity conflicts by request SHA. */
export function canonicalApplicationRequestId(canonical: CanonicalToken, actorUserId: string) {
  applicationUuid(actorUserId);
  return privateUuid({ namespace: 'capiro.objective-plan.application:v1', canonical, actorUserId });
}
export const applicationReceiptId = (tenant: string, actor: string, request: string) =>
  privateUuid([CANONICAL_APPLICATION_RECEIPT, tenant, actor, request]);
export const applicationHeadId = (canonical: CanonicalToken) =>
  privateUuid([CANONICAL_APPLICATION_HEAD, canonical.tenantId, canonical.canonicalPlanId]);

export interface CanonicalCreationAck {
  schemaVersion: 1;
  operation: 'objective.plan.prepare';
  applicationRequestId: string;
  requestSha256: string;
  canonical: CanonicalToken;
  actorUserId: string;
  consentId: string;
  controlVersion: number;
  source: MaterializationResult['source'];
  objectiveReceiptSha256: string;
  ownerReceiptId: string;
  ownerReceiptSha256: string;
  recordedAt: string;
  outcome: 'applied' | 'applied_with_issues';
  projects: Array<{ groupKey: string; projectId: string; createdVersion: number; originalNodeIds: string[] }>;
  tasks: Array<{ sourceNodeId: string; taskId: string; createdVersion: number; originalGroupKeys: string[] }>;
}
export interface StoredCanonicalApplication {
  receiptVersion: 1;
  request: CanonicalApplicationRequest;
  ack: CanonicalCreationAck;
  ackSha256: string;
}
export interface CanonicalApplicationObservation {
  schemaVersion: 1;
  applicationRequestId: string;
  creation: { availability: 'available'; ack: CanonicalCreationAck; sha256: string } |
    { availability: 'unavailable'; ack: null; sha256: null };
  current: MaterializationResult;
}
/** The real receiving service supplies these ports from ONE already-open
 * Prisma transaction. No network, model work, retries or new tx may occur here. */
export interface CanonicalApplicationTransaction {
  lockPlanner(): Promise<void>;
  previous(): Promise<unknown | null>;
  read(previous: unknown): Promise<CanonicalApplicationObservation>;
  assertEffect(): Promise<void>;
  prepare(beforeWrite: () => Promise<void>): Promise<{ stored: StoredCanonicalMaterialization; replayed: boolean }>;
  fence(): Promise<void>;
  clock(): Promise<string>;
  ownerReceiptId: string;
  insert(stored: StoredCanonicalApplication): Promise<void>;
  advanceHead(stored: StoredCanonicalApplication): Promise<void>;
}
export async function executeCanonicalApplicationTransaction(request: CanonicalApplicationRequest,
  grant: CanonicalApplicationGrant, ports: CanonicalApplicationTransaction): Promise<CanonicalApplicationObservation> {
  await ports.lockPlanner();
  const previous = await ports.previous();
  // Retained receipt reads deliberately precede the new-effect/current-source
  // fence. The read port supplies its independent current read authority.
  if (previous) return ports.read(previous);
  await ports.assertEffect();
  const prepared = await ports.prepare(async () => { await ports.assertEffect(); await ports.fence(); });
  if (prepared.replayed) throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
  await ports.assertEffect(); await ports.fence();
  const ack = creationAck(request, grant, prepared.stored, ports.ownerReceiptId, await ports.clock());
  const stored: StoredCanonicalApplication = { receiptVersion: 1, request, ack, ackSha256: applicationHash(ack) };
  await ports.insert(stored);
  await ports.advanceHead(stored);
  // Actual release gate after all writes. A throw must escape the owner tx so
  // outputs, owner receipt, application receipt and head all roll back.
  await ports.assertEffect(); await ports.fence();
  return applicationObservation(stored, prepared.stored.result);
}
export function creationAck(request: CanonicalApplicationRequest, grant: CanonicalApplicationGrant,
  owner: StoredCanonicalMaterialization, ownerReceiptId: string, recordedAt: string): CanonicalCreationAck {
  const r = owner.result;
  if (grant.tenantId !== request.canonical.tenantId || grant.requestSha256 !== applicationHash(request) ||
      grant.canonicalSha256 !== applicationHash(request.canonical) ||
      canonicalApplicationRequestId(request.canonical, grant.actorUserId) !== request.applicationRequestId ||
      r.requestId !== request.applicationRequestId || r.source.generationJobId !== request.generationJobId ||
      r.source.generationRequestId !== request.generationRequestId || r.source.strategyId !== request.strategyId ||
      r.source.strategyVersionId !== request.strategyVersionId || r.source.snapshotDigest !== request.snapshotDigest ||
      r.source.clientId !== request.canonical.clientId || r.source.objectiveId !== request.canonical.objectiveId ||
      r.source.objectiveVersion !== request.canonical.requestedObjectiveVersion ||
      r.source.objectiveRevisionId !== request.canonical.requestedObjectiveRevisionId ||
      owner.binding.objectiveReceiptSha256 !== request.objectiveReceiptSha256 ||
      applicationHash(owner.binding.canonical) !== applicationHash(request.canonical) ||
      r.status === 'partial' || r.replayed || !Number.isFinite(Date.parse(recordedAt)) ||
      r.projects.length !== 1 || r.projects[0]!.groupKey !== 'default' ||
      r.projects[0]!.output.id !== request.canonical.canonicalProjectId ||
      [...r.projects, ...r.tasks].some(p => p.output.availability !== 'available' || p.output.id === null ||
        p.output.createdVersion !== 1 || p.output.currentVersion !== 1))
    throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
  return { schemaVersion: 1, operation: CANONICAL_APPLICATION_OPERATION,
    applicationRequestId: request.applicationRequestId, requestSha256: applicationHash(request),
    canonical: request.canonical, actorUserId: grant.actorUserId, consentId: grant.consentId,
    controlVersion: grant.controlVersion, source: r.source, objectiveReceiptSha256: request.objectiveReceiptSha256,
    ownerReceiptId: applicationUuid(ownerReceiptId), ownerReceiptSha256: applicationHash(owner), recordedAt,
    outcome: r.issues.length ? 'applied_with_issues' : 'applied',
    projects: r.projects.map(p => ({ groupKey: p.groupKey, projectId: p.output.id!,
      createdVersion: p.output.createdVersion, originalNodeIds: p.originalNodeIds })),
    tasks: r.tasks.map(t => ({ sourceNodeId: t.sourceNodeId, taskId: t.output.id!,
      createdVersion: t.output.createdVersion, originalGroupKeys: t.originalGroupKeys })) };
}
export function checkStoredApplication(raw: unknown, owner: StoredCanonicalMaterialization,
  ownerReceiptId: string): StoredCanonicalApplication {
  try {
    const s = closed(raw, ['receiptVersion', 'request', 'ack', 'ackSha256']);
    if (s.receiptVersion !== 1) return invalid();
    const request = parseCanonicalApplication(s.request);
    const a = s.ack as CanonicalCreationAck;
    closed(a, ['schemaVersion', 'operation', 'applicationRequestId', 'requestSha256', 'canonical',
      'actorUserId', 'consentId', 'controlVersion', 'source', 'objectiveReceiptSha256', 'ownerReceiptId',
      'ownerReceiptSha256', 'recordedAt', 'outcome', 'projects', 'tasks']);
    applicationUuid(a.actorUserId); applicationUuid(a.consentId);
    if (!integer(a.controlVersion)) return invalid();
    const rebuilt = creationAck(request, { tenantId: request.canonical.tenantId, actorUserId: a.actorUserId,
      clerkUserId: '', consentId: a.consentId, controlVersion: a.controlVersion, tokenExpiresAtMs: 0,
      delegationExpiresAtMs: 0, claimExpiresAtMs: 0, requestSha256: applicationHash(request),
      canonicalSha256: applicationHash(request.canonical) }, owner, ownerReceiptId, a.recordedAt);
    if (applicationHash(rebuilt) !== applicationHash(a) || s.ackSha256 !== applicationHash(a)) return invalid();
    return { receiptVersion: 1, request, ack: rebuilt, ackSha256: applicationHash(rebuilt) };
  } catch { throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED'); }
}
export function applicationObservation(stored: StoredCanonicalApplication, current: MaterializationResult): CanonicalApplicationObservation {
  if (applicationHash(current.source) !== applicationHash(stored.ack.source) ||
      current.requestId !== stored.request.applicationRequestId ||
      current.projects.length !== stored.ack.projects.length || current.tasks.length !== stored.ack.tasks.length ||
      current.projects.some((p, i) => p.groupKey !== stored.ack.projects[i]!.groupKey ||
        p.output.createdVersion !== stored.ack.projects[i]!.createdVersion ||
        p.output.id !== null && p.output.id !== stored.ack.projects[i]!.projectId) ||
      current.tasks.some((t, i) => t.sourceNodeId !== stored.ack.tasks[i]!.sourceNodeId ||
        t.output.createdVersion !== stored.ack.tasks[i]!.createdVersion ||
        t.output.id !== null && t.output.id !== stored.ack.tasks[i]!.taskId))
    throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED');
  const readable = [...current.projects, ...current.tasks].every(p => p.output.id !== null);
  return { schemaVersion: 1, applicationRequestId: stored.request.applicationRequestId,
    creation: readable ? { availability: 'available', ack: stored.ack, sha256: stored.ackSha256 } :
      { availability: 'unavailable', ack: null, sha256: null }, current };
}
