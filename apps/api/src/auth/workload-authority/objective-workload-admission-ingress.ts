import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { createObjectiveWorkloadIssuanceAdapter, ObjectiveWorkloadIssuanceError,
  type ObjectiveIssuanceSignerPins, type ObjectiveIssuanceTransactionPort,
  type ObjectiveIssuanceSelector } from './objective-workload-issuance.js';
import { verifyObjectiveWorkloadCallerProof, OBJECTIVE_WORKLOAD_PROOF_PATH,
  type ObjectiveWorkloadCallerKeyPin } from './objective-workload-proof.js';
import { OBJECTIVE_GENERATION_WORKER_SUBJECT, OBJECTIVE_STRATEGY_AUDIENCE,
  type ObjectiveWorkloadRequestBinding } from './objective-workload-jwt.js';
import { OBJECTIVE_ADMISSION_TARGET_PATH, type ObjectiveAdmissionSourceResolver } from './objective-workload-admission-source.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const MAX_BYTES = 4096;
const unavailable = (): never => { throw new ObjectiveWorkloadIssuanceError('UNAVAILABLE'); };
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.exec(value)?.[0] === value;
export interface ObjectiveAdmissionHttpRequest {
  readonly method: string;
  /** The transport's actual original URL, including any query component. */
  readonly originalUrl: string;
  /** Exactly one extracted Authorization value; duplicate header arrays deny. */
  readonly authorization: string | readonly string[] | undefined;
  readonly rawBody: Uint8Array;
}
export interface ObjectiveAdmissionIngressOptions {
  enabled?: boolean;
  /** Server-owned, environment-qualified caller pins, never request input. */
  callerKeys?: Readonly<Record<string, ObjectiveWorkloadCallerKeyPin>>;
  /** Trusted verification clock; native issuer independently rechecks DB time. */
  nowSeconds?: () => number;
}
function closed(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || nodeTypes.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Reflect.ownKeys(raw).length !== keys.length)
    return unavailable();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !d.enumerable || !('value' in d)) return unavailable();
    copy[key] = d.value;
  }
  if (Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !keys.includes(key))) return unavailable();
  return copy;
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
function bytes(raw: unknown): Buffer {
  if (!(raw instanceof Uint8Array) || nodeTypes.isProxy(raw) ||
      ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(raw)))
    return unavailable();
  // Use native getters on the real view, not potentially shadowed properties
  // or caller iterators. Reject every extra own key before copying any bytes.
  const length = typedArrayLength.call(raw) as number, keys = Reflect.ownKeys(raw);
  if (length < 1 || length > MAX_BYTES || keys.length !== length ||
      keys.some((key, i) => key !== String(i))) return unavailable();
  return Buffer.from(new Uint8Array(typedArrayBuffer.call(raw), typedArrayOffset.call(raw), length));
}
function source(raw: unknown, jobId: string) {
  const observed = closed(raw, ['selector', 'binding']);
  const s = closed(observed.selector, ['tenantId', 'delegationRef', 'consentId', 'generationJobId', 'phase']);
  if (![s.tenantId, s.delegationRef, s.consentId, s.generationJobId].every(uuid) ||
      s.generationJobId !== jobId || s.phase !== 'admit') return unavailable();
  const selector = s as unknown as ObjectiveIssuanceSelector;
  const b = closed(observed.binding, ['subject', 'audience', 'method', 'path', 'query', 'body', 'operation', 'phase',
    'tenantId', 'generationJobId', 'delegationRef', 'consentId', 'attemptId', 'runId', 'acceptedBindingSha256', 'sourceSha256']);
  const body = bytes(b.body), expectedBody = Buffer.from(JSON.stringify({ schemaVersion: 1, generationJobId: jobId }), 'utf8');
  if (!body.equals(expectedBody) || b.subject !== OBJECTIVE_GENERATION_WORKER_SUBJECT || b.audience !== OBJECTIVE_STRATEGY_AUDIENCE ||
      b.method !== 'POST' || b.path !== OBJECTIVE_ADMISSION_TARGET_PATH || b.query !== '' ||
      b.operation !== 'objective.strategy.draft' || b.phase !== 'admit' || b.tenantId !== selector.tenantId ||
      b.generationJobId !== selector.generationJobId || b.delegationRef !== selector.delegationRef || b.consentId !== selector.consentId ||
      [b.attemptId, b.runId, b.acceptedBindingSha256, b.sourceSha256].some(value => value !== null)) return unavailable();
  return { selector, binding: { ...b, body } as unknown as ObjectiveWorkloadRequestBinding };
}

/** Concrete admit-only issuer ingress factory; no route/provider is mounted.
 * Wire body (UTF-8, exact key order, no whitespace/duplicates/aliases):
 * {"schemaVersion":1,"operationId":"UUID","generationJobId":"UUID","phase":"admit"}
 * Named caller proof authenticates THESE raw bytes. The target body hash is
 * separate and derives only from the independently resolved native job.
 * Source resolution is not authority: the actual durable issuer rechecks the
 * native source before claim and delivery. Existing DB disabled fences remain.
 */
export function createObjectiveAdmissionIngress(resolve: ObjectiveAdmissionSourceResolver,
  port: ObjectiveIssuanceTransactionPort, pins: ObjectiveIssuanceSignerPins,
  options: ObjectiveAdmissionIngressOptions = {}) {
  const enabled = options.enabled === true, keys = options.callerKeys ?? {},
    now = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const issue = createObjectiveWorkloadIssuanceAdapter(port, pins);
  return async (raw: ObjectiveAdmissionHttpRequest) => {
    if (!enabled) return unavailable();
    try {
      const request = closed(raw, ['method', 'originalUrl', 'authorization', 'rawBody']);
      if (request.method !== 'POST' || request.originalUrl !== OBJECTIVE_WORKLOAD_PROOF_PATH ||
          typeof request.authorization !== 'string' || request.authorization.length > 8200) return unavailable();
      const bearer = BEARER.exec(request.authorization);
      if (!bearer || bearer[0] !== request.authorization) return unavailable();
      // Snapshot before the FIRST await, including before native source lookup.
      const body = bytes(request.rawBody), text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      const parsed = closed(JSON.parse(text), ['schemaVersion', 'operationId', 'generationJobId', 'phase']);
      if (parsed.schemaVersion !== 1 || parsed.phase !== 'admit' || !uuid(parsed.operationId) || !uuid(parsed.generationJobId))
        return unavailable();
      const canonical = JSON.stringify({ schemaVersion: 1, operationId: parsed.operationId,
        generationJobId: parsed.generationJobId, phase: 'admit' });
      if (!body.equals(Buffer.from(canonical, 'utf8'))) return unavailable();
      const identity = verifyObjectiveWorkloadCallerProof(bearer[1]!, { method: 'POST', path: OBJECTIVE_WORKLOAD_PROOF_PATH,
        query: '', body, operationId: parsed.operationId }, { publicKeys: keys, nowSeconds: now() });
      // A trusted terminal/retained-reader key is not a generation caller.
      if (identity.subject !== OBJECTIVE_GENERATION_WORKER_SUBJECT) return unavailable();
      const requestSha256 = createHash('sha256').update(body).digest('hex');
      const resolved = source(await resolve({ generationJobId: parsed.generationJobId, operationId: identity.operationId,
        callerIssuer: identity.issuer, callerSubject: identity.subject, issuanceRequestSha256: requestSha256 }), parsed.generationJobId);
      return await issue({ ...resolved, rawIssuanceRequestBytes: body,
        proof: { issuer: identity.issuer, subject: identity.subject, keyId: identity.kid,
          jti: identity.proofJti, operationId: identity.operationId,
          requestSha256, iatSeconds: identity.issuedAtSeconds,
          nbfSeconds: identity.notBeforeSeconds, expSeconds: identity.expiresAtSeconds } });
    } catch (error) {
      if (error instanceof ObjectiveWorkloadIssuanceError) throw error;
      return unavailable();
    }
  };
}
