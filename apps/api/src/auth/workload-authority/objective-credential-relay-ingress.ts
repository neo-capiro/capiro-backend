import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { ObjectiveAdmissionHttpRequest } from './objective-workload-admission-ingress.js';
import { OBJECTIVE_GENERATION_WORKER_SUBJECT } from './objective-workload-jwt.js';
import { OBJECTIVE_WORKLOAD_CREDENTIAL_PATH, verifyObjectiveWorkloadCallerProof,
  type ObjectiveWorkloadCallerKeyPin, type ObjectiveWorkloadProofIdentity } from './objective-workload-proof.js';
import { ObjectiveCredentialRelayRequestRefused, parseObjectiveCredentialRelayRequest,
  type ObjectiveCredentialRelayRequest } from './objective-credential-relay-request.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const refuse = (): never => { throw new ObjectiveCredentialRelayRequestRefused(); };

/** First, source-only half of the proposed Meri relay. The controller must
 * supply a transport snapshot with duplicate Authorization and raw-body
 * capture already checked. This boundary binds the actual Core HTTP entity to
 * a named RSA caller proof and Meri's seven fixed target shapes. It neither
 * consumes the proof JTI nor loads native authority or issues a credential;
 * those must happen together in the later tenant-scoped issuer transaction. */
export function authenticateObjectiveCredentialRelayHttpRequest(
  raw: ObjectiveAdmissionHttpRequest,
  callerKeys: Readonly<Record<string, ObjectiveWorkloadCallerKeyPin>>,
  nowSeconds: number,
): Readonly<{ request: ObjectiveCredentialRelayRequest; caller: ObjectiveWorkloadProofIdentity;
  issuanceRequestSha256: string }> {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || nodeTypes.isProxy(raw) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
        Reflect.ownKeys(raw).length !== 4 || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) return refuse();
    const fields = ['method', 'originalUrl', 'authorization', 'rawBody'];
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of fields) {
      const d = Object.getOwnPropertyDescriptor(raw, key);
      if (!d?.enumerable || !('value' in d)) return refuse();
      snapshot[key] = d.value;
    }
    if (Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !fields.includes(key)) ||
        snapshot.method !== 'POST' || snapshot.originalUrl !== OBJECTIVE_WORKLOAD_CREDENTIAL_PATH ||
        typeof snapshot.authorization !== 'string' || snapshot.authorization.length > 8200) return refuse();
    const bearer = BEARER.exec(snapshot.authorization);
    if (!bearer || bearer[0] !== snapshot.authorization) return refuse();
    const request = parseObjectiveCredentialRelayRequest(snapshot.rawBody as Uint8Array);
    const caller = verifyObjectiveWorkloadCallerProof(bearer[1]!, {
      method: 'POST', path: OBJECTIVE_WORKLOAD_CREDENTIAL_PATH, query: '',
      body: request.rawBody, operationId: request.operationId,
    }, { publicKeys: callerKeys, nowSeconds });
    if (caller.subject !== OBJECTIVE_GENERATION_WORKER_SUBJECT) return refuse();
    return Object.freeze({ request, caller,
      issuanceRequestSha256: createHash('sha256').update(request.rawBody).digest('hex') });
  } catch { return refuse(); }
}
