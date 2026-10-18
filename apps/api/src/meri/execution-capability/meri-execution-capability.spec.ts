import { describe, expect, it } from '@jest/globals';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import {
  createInProcessEd25519Signer,
  createKmsEd25519Signer,
  type KmsEd25519SignClient,
} from '../../auth/core-ed25519-signer.js';
import { nativeCanonicalSha256 } from '../native-approvals/native-approval.contract.js';
import {
  MERI_EXECUTION_MAX_TTL_SECONDS,
  assertExecutionMatches,
  executionCoversDecisionRead,
  issueMeriExecutionCapability,
  taskCreateSourceBody,
  verifyMeriExecutionCapability,
} from './meri-execution-capability.js';

const vectorPath = resolve(__dirname, '../../../../../docs/integration/meri-execution-capability.vector.json');
const vector = JSON.parse(readFileSync(vectorPath, 'utf8'));
const seedKey = (seedHex: string) => createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedHex, 'hex')]),
  format: 'der', type: 'pkcs8',
});
const privateKey = seedKey(vector.key.seedHex);
const publicKey = createPublicKey(privateKey);
const signer = createInProcessEd25519Signer({ issuer: vector.key.issuer, kid: vector.key.kid, privateKey });
const trust = (nowMs = vector.inputs.nowMs, keys: Record<string, KeyObject> = { [vector.key.kid]: publicKey }) =>
  ({ issuer: vector.key.issuer, keys, nowMs });
// JSON clone, not structuredClone: under jest's VM, structuredClone returns objects from
// another realm, which the codec's closed-object check (Object.prototype) refuses.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const inputs = (overrides: Record<string, unknown> = {}) => ({ ...clone(vector.inputs), ...overrides });

describe('Meri execution capability (DRAFT capiro.meri-execution-capability.v1)', () => {
  it('reproduces the committed golden vector byte for byte', async () => {
    const issued = await issueMeriExecutionCapability(inputs(), signer);
    expect(issued.credential).toBe(vector.expected.credential);
    expect(issued.execution).toEqual(vector.expected.execution);
    expect(issued.expiresAtMs).toBe(vector.expected.expiresAtMs);
    expect(issued.checkedAtMs).toBe(vector.inputs.nowMs);
    const verified = verifyMeriExecutionCapability(issued.credential, trust());
    expect(verified.claimsJson).toBe(vector.expected.claimsJson);
    expect(vector.key.publicJwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x: publicKey.export({ format: 'jwk' }).x, kid: vector.key.kid, alg: 'EdDSA', use: 'sig' });
  });

  it('emits exactly Meri CapabilityClaims and a CommandExecutionRequest bound to the proposal and run', async () => {
    const issued = await issueMeriExecutionCapability(inputs(), signer);
    const { claims, execution } = verifyMeriExecutionCapability(issued.credential, trust());
    expect(Object.keys(JSON.parse(JSON.stringify(claims))).sort()).toEqual(
      ['actions', 'audience', 'binding', 'budgets', 'capabilityId', 'expiresAt', 'issuedAt', 'issuer', 'policyRevision', 'scopes']);
    expect(claims).toMatchObject({
      audience: 'meri-gateway', actions: ['command.execute'], policyRevision: vector.inputs.decision.policyRevision,
      binding: vector.inputs.executorBinding,
      // Copied from the authenticated allocation; maxCostMicroUSD -> maxCostMicrousd.
      budgets: { maxTurns: 20, maxRuntimeSeconds: 900, maxCostMicrousd: 2000000, maxOutputBytes: 262144 },
    });
    expect(claims.policyRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(execution.allocationSha256).toBe(nativeCanonicalSha256(vector.inputs.allocation));
    expect(execution.qualification).toEqual(vector.inputs.qualification);
    const proposal = vector.inputs.proposal;
    expect(issued.execution).toEqual({
      contractVersion: '0.1.0', requestId: vector.inputs.requestId, capabilityId: vector.inputs.capabilityId,
      executorBinding: vector.inputs.executorBinding, proposalId: proposal.proposalId, commandSha256: proposal.commandSha256,
      idempotencyKey: proposal.command.idempotencyKey,
    });
    expect(execution.argumentsSha256).toBe(nativeCanonicalSha256(proposal.command.arguments));
    expect(execution.sourceBodySha256).toBe(nativeCanonicalSha256({ title: 'Call the delegation', clientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }));
    expect(execution.clientIds).toEqual(['cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
    expect(execution.decisionSha256).toBe(nativeCanonicalSha256(vector.inputs.decision));
    expect(execution.requestSha256).toBe(nativeCanonicalSha256(issued.execution));
  });

  it('never outlives 120 s, the decision, the proposal or the run', async () => {
    const at = vector.inputs.nowMs;
    const exp = async (o: Record<string, unknown>) => (await issueMeriExecutionCapability(inputs(o), signer)).expiresAtMs;
    expect(await exp({})).toBe((Math.floor(at / 1000) + MERI_EXECUTION_MAX_TTL_SECONDS) * 1000);
    expect(await exp({ runDeadlineMs: at + 30_000 })).toBe(Math.floor((at + 30_000) / 1000) * 1000);
    const shortDecision = { ...vector.inputs.decision, expiresAt: new Date(at + 10_000).toISOString() };
    expect(await exp({ decision: shortDecision })).toBe(Math.floor((at + 10_000) / 1000) * 1000);
    await expect(exp({ runDeadlineMs: at })).rejects.toThrow('MERI_EXECUTION_CAPABILITY_REFUSED');
  });

  it.each([
    ['a rejected decision', { decision: { ...vector.inputs.decision, decision: 'rejected' } }],
    ['another proposal decision', { decision: { ...vector.inputs.decision, proposalId: '12121212-1212-4121-8121-121212121212' } }],
    ['another approver', { decision: { ...vector.inputs.decision, approver: { tenantId: vector.inputs.decision.approver.tenantId, actorId: '33333333-3333-4333-8333-333333333333' } } }],
    ['a decision revision other than the scopes', { decision: { ...vector.inputs.decision, policyRevision: 'policy-r2' } }],
    ['another run', { executorBinding: { ...vector.inputs.executorBinding, runId: '13131313-1313-4131-8131-131313131313' } }],
    ['another conversation', { executorBinding: { ...vector.inputs.executorBinding, conversationId: '14141414-1414-4141-8141-141414141414' } }],
    ['a non-v4 capability id', { capabilityId: '15151515-1515-1151-8151-151515151515' }],
    ['a decision taken after now', { nowMs: Date.parse(vector.inputs.decision.decidedAt) - 1 }],
    ['an unknown input key', { extra: true }],
    ['qualification facts for another fence', { qualification: { ...vector.inputs.qualification, fence: 5 } }],
    ['qualification facts for another policy revision', { qualification: { ...vector.inputs.qualification, policyRevision: 'f'.repeat(64) } }],
    ['qualification facts for another run', { qualification: { ...vector.inputs.qualification, runId: '13131313-1313-4131-8131-131313131313' } }],
    ['a worker that is not an ECS task ARN', { qualification: { ...vector.inputs.qualification, workerArn: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }],
    ['caller-chosen budgets instead of an allocation', { allocation: { budgets: { maxTurns: 1, maxRuntimeSeconds: 1, maxCostMicrousd: 1, maxOutputBytes: 1 } } }],
  ] as Array<[string, Record<string, unknown>]>)('refuses to issue for %s', async (_label, o) => {
    await expect(issueMeriExecutionCapability(inputs(o), signer)).rejects.toThrow('MERI_EXECUTION_CAPABILITY_REFUSED');
  });

  it("binds Meri's create_task body projection, which drops a null clientId or dueDate", () => {
    expect(taskCreateSourceBody({ title: 'T', clientId: null, dueDate: null })).toEqual({ title: 'T' });
    expect(taskCreateSourceBody({ title: 'T', clientId: 'c', dueDate: '2026-11-01' })).toEqual({ title: 'T', clientId: 'c', dueDate: '2026-11-01' });
    expect(() => taskCreateSourceBody({ title: 'T', clientId: null })).toThrow('MERI_EXECUTION_CAPABILITY_REFUSED');
    expect(() => taskCreateSourceBody({ title: 'T', clientId: null, dueDate: null, extra: 1 })).toThrow('MERI_EXECUTION_CAPABILITY_REFUSED');
  });

  it('refuses a tampered command (hash no longer matches) and a non-task action', async () => {
    const proposal = clone(vector.inputs.proposal);
    proposal.command.arguments.title = 'Something else';
    await expect(issueMeriExecutionCapability(inputs({ proposal }), signer)).rejects.toThrow('MERI_EXECUTION_CAPABILITY_REFUSED');
    const memory = clone(vector.inputs.proposal);
    memory.command.action = 'memory.propose';
    memory.commandSha256 = nativeCanonicalSha256(memory.command);
    const decision = { ...vector.inputs.decision, commandSha256: memory.commandSha256 };
    await expect(issueMeriExecutionCapability(inputs({ proposal: memory, decision }), signer)).rejects.toThrow('MERI_EXECUTION_CAPABILITY_REFUSED');
  });

  it('verifies only with the pinned key, issuer and clock', async () => {
    const { credential } = await issueMeriExecutionCapability(inputs(), signer);
    const other = generateKeyPairSync('ed25519').publicKey;
    const refused = (fn: () => unknown) => expect(fn).toThrow('MERI_EXECUTION_CAPABILITY_REFUSED');
    refused(() => verifyMeriExecutionCapability(credential, trust(undefined, { [vector.key.kid]: other })));
    refused(() => verifyMeriExecutionCapability(credential, trust(undefined, { 'other-kid': publicKey })));
    refused(() => verifyMeriExecutionCapability(credential, { ...trust(), issuer: 'capiro-core:other' }));
    refused(() => verifyMeriExecutionCapability(credential, trust(vector.expected.expiresAtMs)));
    refused(() => verifyMeriExecutionCapability(credential, trust(vector.inputs.nowMs - 1000)));
    const [h, p, s] = credential.split('.');
    const at = s!.length - 2;
    const flipped = `${h}.${p}.${s!.slice(0, at)}${s![at] === 'A' ? 'B' : 'A'}${s!.slice(at + 1)}`;
    expect(flipped).not.toBe(credential);
    refused(() => verifyMeriExecutionCapability(flipped, trust()));
  });

  it('refuses a correctly signed payload that is not the RFC 8785 form or widens actions', async () => {
    const { credential } = await issueMeriExecutionCapability(inputs(), signer);
    const [h, p] = credential.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8'));
    const resign = (body: string) => {
      const input = `${h}.${Buffer.from(body, 'utf8').toString('base64url')}`;
      return `${input}.${nodeSign(null, Buffer.from(input, 'ascii'), privateKey).toString('base64url')}`;
    };
    expect(() => verifyMeriExecutionCapability(resign(JSON.stringify(payload, null, 1)), trust())).toThrow('MERI_EXECUTION_CAPABILITY_REFUSED');
    const wider = clone(payload);
    wider.capability.actions = ['command.execute', 'tool.read'];
    expect(() => verifyMeriExecutionCapability(resign(canonicalizeCoreRetainedJson(wider)), trust())).toThrow('MERI_EXECUTION_CAPABILITY_REFUSED');
    const otherRequest = clone(payload);
    otherRequest.execution.idempotencyKey = 'intent-2';
    expect(() => verifyMeriExecutionCapability(resign(canonicalizeCoreRetainedJson(otherRequest)), trust())).toThrow('MERI_EXECUTION_CAPABILITY_REFUSED');
  });

  it('authorizes nothing until it equals the actual request, proposal, decision, allocation and qualification', async () => {
    const issued = await issueMeriExecutionCapability(inputs(), signer);
    const verified = verifyMeriExecutionCapability(issued.credential, trust());
    const actual = () => clone({
      request: issued.execution, proposal: vector.inputs.proposal, decision: vector.inputs.decision,
      allocation: vector.inputs.allocation, qualification: vector.inputs.qualification,
    });
    expect(() => assertExecutionMatches(verified, actual())).not.toThrow();
    const refused = (mutate: (a: ReturnType<typeof actual>) => void) => {
      const a = actual(); mutate(a);
      expect(() => assertExecutionMatches(verified, a)).toThrow('MERI_EXECUTION_CAPABILITY_REFUSED');
    };
    refused((a) => { a.request.requestId = '17171717-1717-4171-8171-171717171717'; });
    refused((a) => { a.proposal.command.arguments.title = 'Other'; });
    refused((a) => { a.decision.decidedAt = '2026-10-18T06:01:30.000Z'; });
    refused((a) => { a.allocation.budgets.maxCostMicroUSD = 1; });
    refused((a) => { a.qualification.attempt = 3; });
  });

  it('covers only its own proposal decision read in its own run (receiver-branch draft)', async () => {
    const { credential } = await issueMeriExecutionCapability(inputs(), signer);
    const verified = verifyMeriExecutionCapability(credential, trust());
    const read = { proposalId: vector.inputs.proposal.proposalId, commandSha256: vector.inputs.proposal.commandSha256, binding: vector.inputs.proposal.command.binding };
    expect(executionCoversDecisionRead(verified, read)).toBe(true);
    expect(executionCoversDecisionRead(verified, { ...read, proposalId: '12121212-1212-4121-8121-121212121212' })).toBe(false);
    expect(executionCoversDecisionRead(verified, { ...read, binding: { ...read.binding, runId: '13131313-1313-4131-8131-131313131313' } })).toBe(false);
  });
});

describe('Core Ed25519 signer shape (D7-2)', () => {
  const keyArn = 'arn:aws:kms:us-east-1:967807252336:key/00000000-0000-4000-8000-000000000001';
  const message = Buffer.from('capiro-signing-input', 'ascii');
  const kmsClient = (override: Partial<{ KeyId: string; SigningAlgorithm: string; key: KeyObject }> = {}): KmsEd25519SignClient & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return {
      calls,
      async sign(input) {
        calls.push(input);
        return { KeyId: override.KeyId ?? input.KeyId, SigningAlgorithm: override.SigningAlgorithm ?? input.SigningAlgorithm,
          Signature: nodeSign(null, Buffer.from(input.Message), override.key ?? privateKey) };
      },
    };
  };

  it('signs pure Ed25519 over RAW messages through KMS and checks the pinned public key', async () => {
    const client = kmsClient();
    const kms = createKmsEd25519Signer({ issuer: vector.key.issuer, kid: vector.key.kid, keyArn, publicKey, client });
    const local = createInProcessEd25519Signer({ issuer: vector.key.issuer, kid: vector.key.kid, privateKey });
    expect(await kms.sign(message)).toEqual(await local.sign(message));
    expect(client.calls).toEqual([{ KeyId: keyArn, Message: message, MessageType: 'RAW', SigningAlgorithm: 'ED25519_SHA_512' }]);
    expect(kms.publicKeySha256).toBe(createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'));
    // The same capability verifies whichever signer produced it.
    const issued = await issueMeriExecutionCapability(inputs(), kms);
    expect(issued.credential).toBe(vector.expected.credential);
  });

  it.each([
    ['another KMS key', { KeyId: 'arn:aws:kms:us-east-1:967807252336:key/00000000-0000-4000-8000-000000000002' }],
    ['a pre-hash (non-pure) algorithm answer', { SigningAlgorithm: 'ED25519_PH_SHA_512' }],
    ['a signature from a key other than the pinned one', { key: generateKeyPairSync('ed25519').privateKey }],
  ] as Array<[string, Record<string, unknown>]>)('refuses %s', async (_label, override) => {
    const kms = createKmsEd25519Signer({ issuer: vector.key.issuer, kid: vector.key.kid, keyArn, publicKey, client: kmsClient(override as never) });
    await expect(kms.sign(message)).rejects.toThrow('CORE_ED25519_SIGNER_UNAVAILABLE');
  });

  it('keeps the KMS ARN out of the kid and bounds the message to the KMS RAW limit', async () => {
    expect(() => createKmsEd25519Signer({ issuer: vector.key.issuer, kid: keyArn, keyArn, publicKey, client: kmsClient() }))
      .toThrow('CORE_ED25519_SIGNER_UNAVAILABLE');
    expect(() => createKmsEd25519Signer({ issuer: vector.key.issuer, kid: vector.key.kid, keyArn: 'alias/meri', publicKey, client: kmsClient() }))
      .toThrow('CORE_ED25519_SIGNER_UNAVAILABLE');
    const local = createInProcessEd25519Signer({ issuer: vector.key.issuer, kid: vector.key.kid, privateKey });
    await expect(local.sign(Buffer.alloc(4097, 1))).rejects.toThrow('CORE_ED25519_SIGNER_UNAVAILABLE');
    const aborted = AbortSignal.abort();
    await expect(local.sign(message, { signal: aborted })).rejects.toThrow('CORE_ED25519_SIGNER_UNAVAILABLE');
  });
});
