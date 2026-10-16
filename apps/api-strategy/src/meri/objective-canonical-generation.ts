import { types as nodeTypes } from 'node:util';
import { applicationHash, applicationJson, CanonicalApplicationError,
  type CanonicalToken } from '../planner/objective-canonical-application.js';

export const GENERATION_ADMISSION = 'objective_canonical_generation_admission';
export const GENERATION_ACCEPTANCE = 'objective_canonical_generation_acceptance';
export const GENERATION_PRODUCER = 'objective_canonical_generation_producer';
export const GENERATION_NORMALIZATION = 'objective_canonical_generation_normalization';
export type GenerationLedgerKind = typeof GENERATION_ADMISSION | typeof GENERATION_ACCEPTANCE |
  typeof GENERATION_PRODUCER | typeof GENERATION_NORMALIZATION;
export const GENERATION_ADMISSION_NAMESPACE = 'capiro.objective-strategy.admission:v1';
export interface CanonicalGenerationAdmission {
  schemaVersion: 1; namespace: typeof GENERATION_ADMISSION_NAMESPACE; canonical: CanonicalToken;
  actorUserId: string; clerkUserId: string; consentId: string; controlVersion: number;
  generationJobId: string; generationRequestId: string; admittedAtMs: number; effectExpiresAtMs: number;
  expectedStrategyVersionId: string | null;
}
export interface AcceptedRunBinding {
  readonly tenantId: string; readonly actorId: string; readonly conversationId: string;
  readonly runId: string; readonly attemptId: string; readonly workerId: string; readonly writerFence: number;
}
export interface SanitizedGenerationIssuance {
  issuanceKey: string; binding: AcceptedRunBinding; requestSha256: string; expiresAtMs: number;
  grantId: string; capabilitySha256: string; factsSha256: string;
}
export interface CanonicalGenerationAcceptance {
  schemaVersion: 1; sourceAdmissionSha256: string; sourceBinding: AcceptedRunBinding;
  sourceRequestSha256: string; issuance: SanitizedGenerationIssuance; acceptedAtMs: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const TIME_MAX = 8_640_000_000_000_000;
const TOKEN_KEYS = ['canonicalPlanId', 'tenantId', 'clientId', 'objectiveId', 'canonicalStrategyId',
  'canonicalProjectId', 'bindingVersion', 'epoch', 'requestedIntentId',
  'requestedObjectiveRevisionId', 'requestedObjectiveVersion', 'snapshotHash'];
const invalid = (): never => { throw new CanonicalApplicationError('INPUT_INVALID'); };
function closed(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return invalid();
  const own = Reflect.ownKeys(raw);
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) return invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !d.enumerable || !('value' in d)) return invalid();
    result[key] = d.value;
  }
  return result;
}
function exact(pattern: RegExp, value: unknown): value is string {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}
export function generationUuid(value: unknown): string { return exact(UUID, value) ? value : invalid(); }
export function generationSha256(value: unknown): string { return exact(SHA, value) ? value : invalid(); }
function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}
function actor(value: unknown): string {
  // Meri RunBinding.actorId is opaque 1..128, not a UUID nor an invented
  // Clerk-ID regex. The authoritative native user join establishes lineage.
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 ? value : invalid();
}
export function parseGenerationCanonicalToken(raw: unknown): CanonicalToken {
  const c = closed(raw, TOKEN_KEYS);
  for (const key of TOKEN_KEYS) {
    if (['bindingVersion', 'requestedObjectiveVersion', 'epoch'].includes(key)) integer(c[key], 1, 2147483647);
    else if (key === 'snapshotHash') generationSha256(c[key]);
    else generationUuid(c[key]);
  }
  if (c.epoch !== 1) return invalid();
  return Object.freeze(c) as unknown as CanonicalToken;
}
export function parseCanonicalGenerationAdmission(raw: unknown): CanonicalGenerationAdmission {
  const r = closed(raw, ['schemaVersion', 'namespace', 'canonical', 'actorUserId', 'clerkUserId', 'consentId',
    'controlVersion', 'generationJobId', 'generationRequestId', 'admittedAtMs', 'effectExpiresAtMs', 'expectedStrategyVersionId']);
  if (r.schemaVersion !== 1 || r.namespace !== GENERATION_ADMISSION_NAMESPACE) return invalid();
  const c = parseGenerationCanonicalToken(r.canonical);
  for (const key of ['actorUserId', 'consentId', 'generationJobId', 'generationRequestId']) generationUuid(r[key]);
  actor(r.clerkUserId); integer(r.controlVersion, 1, 2147483647);
  integer(r.admittedAtMs, 0, TIME_MAX); integer(r.effectExpiresAtMs, 0, TIME_MAX);
  if ((r.effectExpiresAtMs as number) <= (r.admittedAtMs as number)) return invalid();
  if (r.expectedStrategyVersionId !== null) generationUuid(r.expectedStrategyVersionId);
  return Object.freeze({ ...r, canonical: c }) as unknown as CanonicalGenerationAdmission;
}
export function parseAcceptedRunBinding(raw: unknown): AcceptedRunBinding {
  const r = closed(raw, ['tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'workerId', 'writerFence']);
  for (const key of ['tenantId', 'conversationId', 'runId', 'attemptId', 'workerId']) generationUuid(r[key]);
  actor(r.actorId); integer(r.writerFence);
  return Object.freeze(r) as unknown as AcceptedRunBinding;
}
/** This equality is only the actual finite RunBinding string/integer domain.
 * It does not rename Core's JSON digest convention as a generic JCS hash. */
export function generationBindingKey(raw: unknown): string { return applicationHash(parseAcceptedRunBinding(raw)); }
export function parseCanonicalGenerationAcceptance(raw: unknown): CanonicalGenerationAcceptance {
  const r = closed(raw, ['schemaVersion', 'sourceAdmissionSha256', 'sourceBinding',
    'sourceRequestSha256', 'issuance', 'acceptedAtMs']);
  if (r.schemaVersion !== 1) return invalid();
  generationSha256(r.sourceAdmissionSha256); generationSha256(r.sourceRequestSha256);
  const binding = parseAcceptedRunBinding(r.sourceBinding);
  const i = closed(r.issuance, ['issuanceKey', 'binding', 'requestSha256', 'expiresAtMs',
    'grantId', 'capabilitySha256', 'factsSha256']);
  const issuedBinding = parseAcceptedRunBinding(i.binding);
  for (const key of ['issuanceKey', 'requestSha256', 'capabilitySha256', 'factsSha256']) generationSha256(i[key]);
  generationUuid(i.grantId); integer(i.expiresAtMs, 0, TIME_MAX); integer(r.acceptedAtMs, 0, TIME_MAX);
  if (applicationJson(binding) !== applicationJson(issuedBinding) || r.sourceRequestSha256 !== i.requestSha256 ||
      i.issuanceKey !== generationBindingKey(binding) || (i.expiresAtMs as number) <= (r.acceptedAtMs as number)) return invalid();
  return Object.freeze({ ...r, sourceBinding: binding,
    issuance: Object.freeze({ ...i, binding: issuedBinding }) }) as unknown as CanonicalGenerationAcceptance;
}
export function canonicalGenerationAdmissionSha256(raw: unknown): string {
  return applicationHash(parseCanonicalGenerationAdmission(raw));
}
/** Metadata coherence only. The real issuer reader must independently verify
 * protected facts.objectiveGeneration.sourceAdmission + its SHA against this
 * Core admission. Neither this parser nor a matching digest establishes that. */
export function requireGenerationAcceptanceForAdmission(raw: unknown, source: unknown): CanonicalGenerationAcceptance {
  const a = parseCanonicalGenerationAdmission(source), accepted = parseCanonicalGenerationAcceptance(raw);
  if (accepted.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(a) ||
      accepted.sourceBinding.tenantId !== a.canonical.tenantId || accepted.sourceBinding.actorId !== a.clerkUserId ||
      accepted.acceptedAtMs < a.admittedAtMs || accepted.acceptedAtMs >= a.effectExpiresAtMs ||
      accepted.issuance.expiresAtMs > a.effectExpiresAtMs)
    throw new CanonicalApplicationError('REQUEST_CONFLICT');
  return accepted;
}
export function generationLedgerId(kind: GenerationLedgerKind,
  tenantId: string, clerkUserId: string, jobId: string): string {
  if (![GENERATION_ADMISSION, GENERATION_ACCEPTANCE, GENERATION_PRODUCER, GENERATION_NORMALIZATION].includes(kind)) return invalid();
  generationUuid(tenantId); actor(clerkUserId); generationUuid(jobId);
  const h = applicationHash([kind, tenantId, clerkUserId, jobId]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
