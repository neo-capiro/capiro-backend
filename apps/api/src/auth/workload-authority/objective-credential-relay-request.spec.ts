import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import {
  OBJECTIVE_CREDENTIAL_RELAY_MAX_BYTES,
  objectiveEffectOperationId,
  parseObjectiveCredentialRelayRequest,
  type ObjectiveMeriCredentialPhase,
} from './objective-credential-relay-request.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jobId = id(1);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const jcs = (value: unknown) => sha(canonicalizeCoreRetainedJson(value));
const source = { generationJobId: jobId, binding: { tenantId: id(2), actorId: id(3),
  conversationId: id(4), runId: id(5), attemptId: id(6), workerId: id(7), writerFence: 1 } };
const targets: Record<ObjectiveMeriCredentialPhase, readonly ['GET' | 'POST', string]> = {
  admit: ['POST', 'generation-admissions'],
  'admission-read': ['GET', 'generation-admissions'],
  publish: ['POST', 'generation-requests'],
  'request-read': ['GET', 'generation-requests'],
  accept: ['POST', 'generation-acceptances'],
  complete: ['POST', 'generation-completions'],
  'completion-read': ['GET', 'generation-completions'],
};
function request(phase: ObjectiveMeriCredentialPhase) {
  const [method, suffix] = targets[phase];
  const route = `/strategy-api/internal/objective-canonical/${suffix}${method === 'GET' ? `/${jobId}` : ''}`;
  const targetBody = method === 'GET' ? '' : JSON.stringify({ schemaVersion: 1, generationJobId: jobId });
  return { schemaVersion: 1, operationId: method === 'POST' ? objectiveEffectOperationId(jobId,
    phase as 'admit' | 'publish' | 'accept' | 'complete') : id(8), generationJobId: jobId, phase, method, route,
    source, sourceSha256: jcs(source), requestSha256: jcs({ schemaVersion: 1, generationJobId: jobId }),
    bodySha256: sha(targetBody) };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');
const denied = (value: Uint8Array) => expect(() => parseObjectiveCredentialRelayRequest(value))
  .toThrow('OBJECTIVE_CREDENTIAL_RELAY_REQUEST_REFUSED');

describe('Objective Meri credential relay request boundary', () => {
  it.each(Object.keys(targets) as ObjectiveMeriCredentialPhase[])('captures the exact %s target and Meri hashes', phase => {
    const b = bytes(request(phase));
    const parsed = parseObjectiveCredentialRelayRequest(b);
    expect(parsed.rawBody).toEqual(b);
    expect(parsed.rawBody).not.toBe(b);
    expect(parsed.phase).toBe(phase);
    expect(parsed.route).toBe(request(phase).route);
    expect(parsed.targetBody.toString('utf8')).toBe(
      parsed.method === 'GET' ? '' : JSON.stringify({ schemaVersion: 1, generationJobId: jobId }));
  });

  it('refuses a changed method, route, source, target body or identity hash', () => {
    const valid = request('admit');
    denied(bytes({ ...valid, method: 'GET' }));
    denied(bytes({ ...valid, route: valid.route + '/' + jobId }));
    denied(bytes({ ...valid, source: { ...source, binding: { ...source.binding, actorId: id(9) } } }));
    denied(bytes({ ...valid, bodySha256: 'a'.repeat(64) }));
    denied(bytes({ ...valid, requestSha256: 'b'.repeat(64) }));
    denied(bytes({ ...valid, generationJobId: id(9) }));
    denied(bytes({ ...valid, operationId: id(8) }));
    denied(bytes({ ...request('admission-read'), operationId: objectiveEffectOperationId(jobId, 'admit') }));
  });

  it('derives a stable version-8 effect ID scoped to the original job and phase', () => {
    const effect = objectiveEffectOperationId(jobId, 'admit');
    expect(effect).toBe('c866242a-2fce-8d93-aace-1d84475a3ddf');
    expect(effect).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(effect).toBe(objectiveEffectOperationId(jobId, 'admit'));
    expect(effect).not.toBe(objectiveEffectOperationId(jobId, 'publish'));
    expect(effect).not.toBe(objectiveEffectOperationId(id(9), 'admit'));
  });

  it('refuses aliases, extra fields, duplicate keys, whitespace and invalid UTF-8', () => {
    const valid = request('publish');
    denied(bytes({ ...valid, phase: 'Publish' }));
    denied(bytes({ ...valid, credential: 'not-in-request' }));
    denied(Buffer.from(JSON.stringify(valid).replace('"phase":"publish"', '"phase":"admit","phase":"publish"')));
    denied(Buffer.from(' ' + JSON.stringify(valid)));
    denied(Buffer.from([0x7b, 0xff, 0x7d]));
    denied(Buffer.alloc(OBJECTIVE_CREDENTIAL_RELAY_MAX_BYTES + 1, 0x20));
  });

  it('refuses a changed source binding even if Meri hashes it again when fields are missing or unsafe', () => {
    const valid = request('complete');
    const missing = { ...source, binding: { tenantId: source.binding.tenantId } };
    denied(bytes({ ...valid, source: missing, sourceSha256: jcs(missing) }));
    const unsafe = { ...source, binding: { ...source.binding, writerFence: 0 } };
    denied(bytes({ ...valid, source: unsafe, sourceSha256: jcs(unsafe) }));
  });
});
