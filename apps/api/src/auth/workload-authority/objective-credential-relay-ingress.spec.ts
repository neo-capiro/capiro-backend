import { describe, expect, it } from '@jest/globals';
import { constants, createHash, generateKeyPairSync, sign } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { authenticateObjectiveCredentialRelayHttpRequest } from './objective-credential-relay-ingress.js';
import { OBJECTIVE_CREDENTIAL_RELAY_PATH, objectiveEffectOperationId } from './objective-credential-relay-request.js';
import { OBJECTIVE_WORKLOAD_PROOF_AUDIENCE, OBJECTIVE_WORKLOAD_PROOF_TYPE } from './objective-workload-proof.js';
import { OBJECTIVE_GENERATION_WORKER_SUBJECT } from './objective-workload-jwt.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jobId = id(1), now = 1_800_000_000, issuer = 'urn:capiro:objective:meri:test:v1', kid = 'worker-test';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const jcs = (value: unknown) => sha(canonicalizeCoreRetainedJson(value));
const source = { generationJobId: jobId, binding: { tenantId: id(2), actorId: 'user_test',
  conversationId: id(3), runId: id(4), attemptId: id(5), workerId: id(6), writerFence: 1 } };
const operationId = objectiveEffectOperationId(jobId, 'admit');
const targetBody = JSON.stringify({ schemaVersion: 1, generationJobId: jobId });
const relay = { schemaVersion: 1, operationId, generationJobId: jobId, phase: 'admit', method: 'POST',
  route: '/strategy-api/internal/objective-canonical/generation-admissions', source,
  sourceSha256: jcs(source), requestSha256: jcs({ schemaVersion: 1, generationJobId: jobId }),
  bodySha256: sha(targetBody) };
const body = Buffer.from(JSON.stringify(relay), 'utf8');
const keys = { [kid]: { issuer, subject: OBJECTIVE_GENERATION_WORKER_SUBJECT, publicKey } };
const header = { alg: 'RS256', typ: OBJECTIVE_WORKLOAD_PROOF_TYPE, kid };
function proof(overrides: Record<string, unknown> = {}) {
  const payload = { iss: issuer, sub: OBJECTIVE_GENERATION_WORKER_SUBJECT,
    aud: OBJECTIVE_WORKLOAD_PROOF_AUDIENCE, iat: now, nbf: now, exp: now + 30,
    jti: id(8), operationId, method: 'POST', path: OBJECTIVE_CREDENTIAL_RELAY_PATH,
    query: '', bodySha256: sha(body), ...overrides };
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.` +
    Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(input, 'ascii'),
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING }).toString('base64url');
  return `${input}.${signature}`;
}
function http(authorization = `Bearer ${proof()}`) {
  return { method: 'POST', originalUrl: OBJECTIVE_CREDENTIAL_RELAY_PATH,
    authorization, rawBody: body };
}
const denied = (request: unknown) => expect(() => authenticateObjectiveCredentialRelayHttpRequest(
  request as never, keys, now)).toThrow('OBJECTIVE_CREDENTIAL_RELAY_REQUEST_REFUSED');

describe('Objective relay HTTP request proof boundary', () => {
  it('binds the exact captured entity, operation and named Meri caller', () => {
    const result = authenticateObjectiveCredentialRelayHttpRequest(http(), keys, now);
    expect(result.request.rawBody).toEqual(body);
    expect(result.request.rawBody).not.toBe(body);
    expect(result.request.operationId).toBe(operationId);
    expect(result.caller).toMatchObject({ issuer, subject: OBJECTIVE_GENERATION_WORKER_SUBJECT,
      proofJti: id(8), operationId });
    expect(result.issuanceRequestSha256).toBe(sha(body));
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('refuses another route, repeated authorization, changed entity and mismatched proof target', () => {
    denied({ ...http(), originalUrl: OBJECTIVE_CREDENTIAL_RELAY_PATH + '?x=1' });
    denied({ ...http(), authorization: [`Bearer ${proof()}`, `Bearer ${proof()}`] });
    denied({ ...http(), rawBody: Buffer.from(' ' + body.toString('utf8')) });
    denied(http(`Bearer ${proof({ path: '/api/internal/objective-workload-authority/decisions' })}`));
    denied(http(`Bearer ${proof({ operationId: id(9) })}`));
    denied({ ...http(), method: 'GET' });
  });

  it('refuses an unpinned caller, expired proof and accessor-backed HTTP input', () => {
    expect(() => authenticateObjectiveCredentialRelayHttpRequest(http(), {}, now))
      .toThrow('OBJECTIVE_CREDENTIAL_RELAY_REQUEST_REFUSED');
    expect(() => authenticateObjectiveCredentialRelayHttpRequest(http(), keys, now + 30))
      .toThrow('OBJECTIVE_CREDENTIAL_RELAY_REQUEST_REFUSED');
    const getter = http();
    Object.defineProperty(getter, 'authorization', { enumerable: true, get: () => `Bearer ${proof()}` });
    denied(getter);
  });
});
