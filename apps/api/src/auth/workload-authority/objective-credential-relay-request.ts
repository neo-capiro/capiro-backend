import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { OBJECTIVE_WORKLOAD_CREDENTIAL_PATH } from './objective-workload-proof.js';

/** Meri's seven readCredential calls use one fixed target per phase. This
 * parser authenticates request *shape* and target identity only. Its source is
 * an untrusted comparator; a native owner must independently reload job,
 * actor, delegation, consent and phase-specific current authority before an
 * issuer or release path can use it. */
export const OBJECTIVE_CREDENTIAL_RELAY_PATH = OBJECTIVE_WORKLOAD_CREDENTIAL_PATH;
export const OBJECTIVE_CREDENTIAL_RELAY_MAX_BYTES = 4096;
export type ObjectiveMeriCredentialPhase = 'admit' | 'admission-read' | 'publish' | 'request-read' |
  'accept' | 'complete' | 'completion-read';

const BASE = '/strategy-api/internal/objective-canonical';
const ROUTES: Readonly<Record<ObjectiveMeriCredentialPhase, Readonly<{ method: 'GET' | 'POST'; path: string }>>> =
  Object.freeze({
    admit: { method: 'POST', path: `${BASE}/generation-admissions` },
    'admission-read': { method: 'GET', path: `${BASE}/generation-admissions` },
    publish: { method: 'POST', path: `${BASE}/generation-requests` },
    'request-read': { method: 'GET', path: `${BASE}/generation-requests` },
    accept: { method: 'POST', path: `${BASE}/generation-acceptances` },
    complete: { method: 'POST', path: `${BASE}/generation-completions` },
    'completion-read': { method: 'GET', path: `${BASE}/generation-completions` },
  });
const PHASES = Object.keys(ROUTES) as ObjectiveMeriCredentialPhase[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const BODY_KEYS = ['schemaVersion', 'operationId', 'generationJobId', 'phase', 'method', 'route',
  'source', 'sourceSha256', 'requestSha256', 'bodySha256'] as const;

export class ObjectiveCredentialRelayRequestRefused extends Error {
  constructor() { super('OBJECTIVE_CREDENTIAL_RELAY_REQUEST_REFUSED'); }
}
const refuse = (): never => { throw new ObjectiveCredentialRelayRequestRefused(); };
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const canonicalSha = (value: unknown) => sha(canonicalizeCoreRetainedJson(value));

/** One immutable effect claim per job/phase across process restarts. GET reads
 * have their own per-dispatch UUIDv4 instead. This is an identifier, never an
 * authority check or permission to reissue after an expired effect claim. */
export function objectiveEffectOperationId(generationJobId: string,
  phase: 'admit' | 'publish' | 'accept' | 'complete'): string {
  if (!UUID.test(generationJobId) || !['admit', 'publish', 'accept', 'complete'].includes(phase)) return refuse();
  const digest = createHash('sha256').update(canonicalizeCoreRetainedJson([
    'capiro.objective.workload.operation.v1', generationJobId, phase,
  ])).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function closed(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || nodeTypes.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return refuse();
  const names = Reflect.ownKeys(raw);
  if (names.length !== keys.length || names.some(name => typeof name !== 'string' || !keys.includes(name))) return refuse();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return refuse();
    result[key] = descriptor.value;
  }
  return result;
}

export interface ObjectiveCredentialRelayRequest {
  readonly operationId: string;
  readonly generationJobId: string;
  readonly phase: ObjectiveMeriCredentialPhase;
  readonly method: 'GET' | 'POST';
  readonly route: string;
  readonly source: { readonly generationJobId: string; readonly binding: Readonly<Record<string, unknown>> };
  readonly sourceSha256: string;
  readonly requestSha256: string;
  readonly bodySha256: string;
  /** Exact signed Core HTTP entity, copied before any async authority lookup. */
  readonly rawBody: Buffer;
  /** Exact Meri target entity (empty for reads), derived from the fixed route. */
  readonly targetBody: Buffer;
}

/** The proposed Core relay envelope is canonical JSON in the declared outer
 * order. Byte comparison rejects duplicate keys, alternate spellings,
 * whitespace and number aliases before a caller proof is checked. A fresh
 * proof JTI may accompany a recheck, but its operationId and these raw bytes
 * must stay identical. Effect release has a separate post-effect authority
 * decision; parsing never authorizes it. */
export function parseObjectiveCredentialRelayRequest(raw: Uint8Array): ObjectiveCredentialRelayRequest {
  try {
    if (!(raw instanceof Uint8Array) || nodeTypes.isProxy(raw) ||
        ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(raw)) ||
        raw.byteLength < 1 || raw.byteLength > OBJECTIVE_CREDENTIAL_RELAY_MAX_BYTES) return refuse();
    const body = Buffer.from(raw);
    const parsed = closed(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)), BODY_KEYS);
    if (parsed.schemaVersion !== 1 || typeof parsed.operationId !== 'string' || !UUID.test(parsed.operationId) ||
        typeof parsed.generationJobId !== 'string' || !UUID.test(parsed.generationJobId) ||
        typeof parsed.phase !== 'string' || !PHASES.includes(parsed.phase as ObjectiveMeriCredentialPhase)) return refuse();
    const phase = parsed.phase as ObjectiveMeriCredentialPhase;
    const source = closed(parsed.source, ['generationJobId', 'binding']);
    const binding = closed(source.binding, ['tenantId', 'actorId', 'conversationId', 'runId',
      'attemptId', 'workerId', 'writerFence']);
    if (source.generationJobId !== parsed.generationJobId || typeof binding.tenantId !== 'string' ||
        !UUID.test(binding.tenantId) || typeof binding.actorId !== 'string' ||
        !binding.actorId.length || binding.actorId.length > 128 ||
        ['conversationId', 'runId', 'attemptId', 'workerId']
          .some(key => typeof binding[key] !== 'string' || !UUID.test(binding[key] as string)) ||
        !Number.isSafeInteger(binding.writerFence) || (binding.writerFence as number) < 1) return refuse();
    const target = ROUTES[phase];
    if (target.method === 'POST' ? parsed.operationId !== objectiveEffectOperationId(
      parsed.generationJobId, phase as 'admit' | 'publish' | 'accept' | 'complete') :
      !UUID_V4.test(parsed.operationId)) return refuse();
    const route = target.method === 'GET' ? `${target.path}/${parsed.generationJobId}` : target.path;
    const targetBody = Buffer.from(target.method === 'GET' ? '' : JSON.stringify({ schemaVersion: 1,
      generationJobId: parsed.generationJobId }), 'utf8');
    if (parsed.method !== target.method || parsed.route !== route ||
        typeof parsed.sourceSha256 !== 'string' || !SHA.test(parsed.sourceSha256) ||
        typeof parsed.requestSha256 !== 'string' || !SHA.test(parsed.requestSha256) ||
        typeof parsed.bodySha256 !== 'string' || !SHA.test(parsed.bodySha256) ||
        parsed.sourceSha256 !== canonicalSha(parsed.source) ||
        parsed.requestSha256 !== canonicalSha({ schemaVersion: 1, generationJobId: parsed.generationJobId }) ||
        parsed.bodySha256 !== sha(targetBody)) return refuse();
    const canonical = JSON.stringify(Object.fromEntries(BODY_KEYS.map(key => [key, parsed[key]])));
    if (!body.equals(Buffer.from(canonical, 'utf8'))) return refuse();
    return Object.freeze({ operationId: parsed.operationId, generationJobId: parsed.generationJobId,
      phase, method: target.method, route, source: Object.freeze({ generationJobId: source.generationJobId as string,
        binding: Object.freeze(binding) }), sourceSha256: parsed.sourceSha256,
      requestSha256: parsed.requestSha256, bodySha256: parsed.bodySha256, rawBody: body, targetBody });
  } catch { return refuse(); }
}
