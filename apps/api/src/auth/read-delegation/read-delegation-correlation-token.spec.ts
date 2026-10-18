import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { createInProcessEd25519Signer } from '../core-ed25519-signer.js';
import type { CoreEd25519KeyConfig } from '../core-ed25519-key-config.js';
import { signReadToken, verifyReadToken, type ReadTokenClaims } from './read-delegation-token.js';

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const V = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const R = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const D = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const keys = generateKeyPairSync('ed25519');
const signer = createInProcessEd25519Signer({ issuer: 'capiro-core:meri-read:v1', kid: 'source-correlation-test', privateKey: keys.privateKey });
const config: CoreEd25519KeyConfig = { issuer: signer.issuer, kid: signer.kid, keyArn: 'synthetic', region: 'synthetic', publicKey: keys.publicKey };
const nowMs = Date.now();
const seconds = Math.floor(nowMs / 1000);

function claims(id: string): Omit<ReadTokenClaims, 'iss' | 'aud' | 'jti'> {
  return { sub: D, iat: seconds, nbf: seconds, exp: seconds + 30,
    kind: 'tool', callKey: 'test-call', method: 'POST', path: `/api/clio/tools/${id}`,
    bodySha256: sha('body'), operation: { id, version: '0.2.0' },
    toolRequestSha256: null, referenceSha256: null, tenantId: T, actorId: A,
    clientId: C, conversationId: V, runId: R };
}

/** Re-sign a mutated canonical payload to exercise verifier claim admission,
 * independent of the new sign-time guard. */
function mutateSigned(token: string, change: (payload: Record<string, unknown>) => void): string {
  const [header, body] = token.split('.');
  const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as Record<string, unknown>;
  change(payload);
  const encoded = Buffer.from(canonicalizeCoreRetainedJson(payload), 'utf8').toString('base64url');
  const input = `${header}.${encoded}`;
  return `${input}.${nodeSign(null, Buffer.from(input, 'ascii'), keys.privateKey).toString('base64url')}`;
}

describe('retained source read token correlation claim', () => {
  it('preserves the exact legacy claim set for an existing tool', async () => {
    const { token } = await signReadToken(signer, claims('query_tasks'));
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(Object.hasOwn(payload, 'correlationSha256')).toBe(false);
    expect(verifyReadToken(token, config, nowMs)?.operation).toEqual({ id: 'query_tasks', version: '0.2.0' });
    await expect(signReadToken(signer, { ...claims('query_tasks'), correlationSha256: sha('unexpected') })).rejects.toThrow();
    expect(verifyReadToken(mutateSigned(token, (body) => { body.correlationSha256 = sha('unexpected'); }), config, nowMs)).toBeNull();
  });

  it('requires and verifies a signed hash for an exact source operation', async () => {
    const correlationSha256 = sha('authenticated-correlation');
    const source = claims('mail.list_messages');
    await expect(signReadToken(signer, source)).rejects.toThrow();
    const { token } = await signReadToken(signer, { ...source, correlationSha256 });
    expect(verifyReadToken(token, config, nowMs)?.correlationSha256).toBe(correlationSha256);
    expect(verifyReadToken(mutateSigned(token, (body) => { delete body.correlationSha256; }), config, nowMs)).toBeNull();
    expect(verifyReadToken(mutateSigned(token, (body) => { body.correlationSha256 = null; }), config, nowMs)).toBeNull();
    expect(verifyReadToken(mutateSigned(token, (body) => { body.correlationSha256 = 'not-a-hash'; }), config, nowMs)).toBeNull();
    expect(verifyReadToken(mutateSigned(token, (body) => { body.kind = 'mode'; }), config, nowMs)).toBeNull();
    expect(verifyReadToken(mutateSigned(token, (body) => { body.operation = { id: 'mail.list_messages', version: '0.3.0' }; }),
      config, nowMs)).toBeNull();
    await expect(signReadToken(signer, { ...source, operation: { id: 'mail.list_messages', version: '0.3.0' },
      correlationSha256 })).rejects.toThrow();
  });

  it('signs only get_client_context 0.3.0 while preserving other 0.2.0 source versions', async () => {
    const correlationSha256 = sha('profile-observation-correlation');
    const legacy = claims('get_client_context');
    await expect(signReadToken(signer, {...legacy, correlationSha256})).rejects.toThrow();
    const profile = {...legacy, operation: {id: 'get_client_context', version: '0.3.0'}, correlationSha256};
    const {token} = await signReadToken(signer, profile);
    expect(verifyReadToken(token, config, nowMs)?.operation).toEqual(profile.operation);
    expect(verifyReadToken(mutateSigned(token, (body) => {
      body.operation = {id: 'get_client_context', version: '0.2.0'};
    }), config, nowMs)).toBeNull();
    expect(verifyReadToken(mutateSigned(token, (body) => {
      body.operation = {id: 'read_client_documents', version: '0.3.0'};
    }), config, nowMs)).toBeNull();
  });
});
