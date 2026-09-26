import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestMaterialV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
  matchesMeriHermesRecoveryNativeRequestV1,
  matchesMeriHermesRecoveryNativeResponseV1,
  meriHermesRecoveryDispositionV1,
  mintMeriHermesRecoveryCommandV1,
  mintMeriHermesRecoveryReceiptV1,
  verifyMeriHermesRecoveryCommandV1,
  verifyMeriHermesRecoveryReceiptV1,
  type MeriHermesRecoveryCommandClaimsV1,
  type MeriHermesRecoveryCommandKeyV1,
  type MeriHermesRecoveryReceiptKeyV1,
} from './meri-hermes-dispatch-recovery.contract.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const RUN = '55555555-5555-4555-8555-555555555555';
const SCOPE = `tenant:${TENANT}:user:${ACTOR}`;
const WORKER_RUN = 'worker-run-recovery-1';
const NOW = '1790366300000000';
const OBSERVED = '1790366310000000';
const VERIFY_AT = '1790366320000000';
const AFTER = '1790366350000000';
const OPERATION = '66666666-6666-4666-8666-666666666666';
const STOP_OPERATION = '77777777-7777-4777-8777-777777777777';
const NONCE = Buffer.alloc(16, 31).toString('base64url');
const STOP_NONCE = Buffer.alloc(16, 32).toString('base64url');
const STOP_BODY = Buffer.from('{}', 'utf8');
const STATUS_BODY = Buffer.alloc(0);
const STATUS_RESPONSE = Buffer.from(
  `{"run_id":"${WORKER_RUN}","status":"running"}`,
  'utf8',
);
const TERMINAL_RESPONSE = Buffer.from(
  `{"run_id":"${WORKER_RUN}","status":"cancelled"}`,
  'utf8',
);
const NOT_FOUND_RESPONSE = Buffer.from('{"error":"not found"}', 'utf8');

const MATERIAL: MeriDispatchRequestMaterialV2 = {
  metadata: {
    version: 2,
    tenantId: TENANT,
    actorType: 'user',
    actorId: ACTOR,
    meriAudience: 'private',
    clientId: null,
    workspaceId: null,
    scopeId: SCOPE,
    conversationId: CONVERSATION,
    userMessageId: '44444444-4444-4444-8444-444444444444',
    runId: RUN,
    idempotencyKey: 'phase4-recovery-contract',
    conversationEpoch: 3,
    workerAudience: 'meri-hermes-scope-worker',
    workerIngressId: 'private-ingress-a',
    workerGeneration: 'worker-image-sha256:2026',
    workerCredentialId: 'worker-credential-2026-09',
    authorizationVersion: 'authorization-v8',
    authorizationPolicyVersion: 'policy-v8',
    grantVersion: 'grant-v4',
    catalogDigest: 'a'.repeat(64),
    toolViewDigest: 'b'.repeat(64),
    sessionHeaderKeyId: 'dispatch-hmac-2026-09',
    claimNotAfterEpochMicros: '1790366400000000',
    deliveryNotAfterEpochMicros: '1790366460000000',
    workerCredentialNotAfterEpochMicros: '1790366460000000',
    reconciliationNotAfterEpochMicros: '1790456460000000',
    retainUntilEpochMicros: '1790546460000000',
  },
  sourceMessage: { body: 'recover this exact turn', metadata: { runtime: 'hermes' } },
  bodyBytes: Buffer.from('{"input":"recover"}', 'utf8'),
  sessionKeyHeaderValue: `${SCOPE}:conversation:${CONVERSATION}:e3`,
  sessionHeaderHmacKey: Buffer.alloc(32, 7),
};
const IDENTITY = createMeriDispatchRequestIdentityV2(MATERIAL);
const BINDING = {
  tenantId: TENANT,
  workerAudience: MATERIAL.metadata.workerAudience,
  workerIngressId: MATERIAL.metadata.workerIngressId,
  workerGeneration: MATERIAL.metadata.workerGeneration,
  workerCredentialId: MATERIAL.metadata.workerCredentialId,
};
const COMMAND_KEY: MeriHermesRecoveryCommandKeyV1 = {
  purpose: MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  keyId: 'phase4-recovery-command-key-2026-09',
  ...BINDING,
  secret: Buffer.alloc(32, 41),
  notBeforeEpochMicros: '1790366200000000',
  notAfterEpochMicros: '1790366500000000',
};
const RECEIPT_KEY: MeriHermesRecoveryReceiptKeyV1 = {
  purpose: MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
  keyId: 'phase4-recovery-receipt-key-2026-09',
  ...BINDING,
  secret: Buffer.alloc(32, 42),
  notBeforeEpochMicros: '1790366200000000',
  notAfterEpochMicros: '1790366500000000',
};

const statusCommandMaterial = {
  identity: IDENTITY,
  workerRunId: WORKER_RUN,
  action: 'status' as const,
  operationId: OPERATION,
  attemptNonce: NONCE,
  nativeBodyBytes: STATUS_BODY,
  notBeforeEpochMicros: NOW,
  notAfterEpochMicros: AFTER,
};
const stopCommandMaterial = {
  ...statusCommandMaterial,
  action: 'stop' as const,
  operationId: STOP_OPERATION,
  attemptNonce: STOP_NONCE,
  nativeBodyBytes: STOP_BODY,
};

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as
    Record<string, unknown>;
}

function resignCommand(json: string, secret = COMMAND_KEY.secret): string {
  const payload = Buffer.from(json, 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret)
    .update('capiro.meri.phase4.recovery-command/v1\0', 'utf8')
    .update(`mhrc1.${payload}`, 'ascii').digest('base64url');
  return `mhrc1.${payload}.${signature}`;
}

function resignReceipt(json: string, secret = RECEIPT_KEY.secret): string {
  const payload = Buffer.from(json, 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret)
    .update('capiro.meri.phase4.recovery-receipt/v1\0', 'utf8')
    .update(`mhrr1.${payload}`, 'ascii').digest('base64url');
  return `mhrr1.${payload}.${signature}`;
}

function verifiedCommand(token = mintMeriHermesRecoveryCommandV1(
  statusCommandMaterial, COMMAND_KEY,
)): MeriHermesRecoveryCommandClaimsV1 {
  const result = verifyMeriHermesRecoveryCommandV1(
    token, IDENTITY, WORKER_RUN, COMMAND_KEY, VERIFY_AT,
  );
  if (!result) throw new Error('fixture command did not verify');
  return result;
}

describe('dormant Phase 4 recovery cryptographic contract v1', () => {
  test('matches the checked-in TypeScript/Python golden command and receipt tokens', () => {
    const vector = JSON.parse(readFileSync(join(
      __dirname,
      '../../../../../docker/hermes-worker/overlay/recovery-receipt-vectors.json',
    ), 'utf8')) as {
      commandToken: string;
      commandClaims: Record<string, unknown>;
      receiptToken: string;
      receiptClaims: Record<string, unknown>;
    };
    const commandToken = mintMeriHermesRecoveryCommandV1(statusCommandMaterial, COMMAND_KEY);
    const command = verifiedCommand(commandToken);
    const receiptToken = mintMeriHermesRecoveryReceiptV1({
      commandToken,
      command,
      observation: 'run_nonterminal',
      workerStatus: 'running',
      nativeHttpStatus: 200,
      nativeResponseBodyBytes: STATUS_RESPONSE,
      observedAtEpochMicros: OBSERVED,
    }, RECEIPT_KEY);

    expect(commandToken).toBe(vector.commandToken);
    expect(command).toEqual(vector.commandClaims);
    expect(receiptToken).toBe(vector.receiptToken);
    expect(verifyMeriHermesRecoveryReceiptV1(
      receiptToken, commandToken, IDENTITY, WORKER_RUN,
      COMMAND_KEY, RECEIPT_KEY, VERIFY_AT,
    )).toEqual(vector.receiptClaims);
  });

  test('uses one exact canonical command field order and binds the native status request', () => {
    const token = mintMeriHermesRecoveryCommandV1(statusCommandMaterial, COMMAND_KEY);
    const payload = payloadOf(token);
    expect(Object.keys(payload)).toEqual([
      'version', 'purpose', 'keyId', 'tenantId', 'runId', 'requestSha256', 'workerRunId',
      'workerAudience', 'workerIngressId', 'workerGeneration', 'workerCredentialId',
      'action', 'operationId', 'attemptNonce', 'nativeMethod', 'nativePath',
      'nativeBodySha256', 'notBeforeEpochMicros', 'notAfterEpochMicros',
    ]);
    expect(payload).toEqual({
      version: 1,
      purpose: MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
      keyId: COMMAND_KEY.keyId,
      tenantId: TENANT,
      runId: RUN,
      requestSha256: IDENTITY.requestSha256,
      workerRunId: WORKER_RUN,
      workerAudience: BINDING.workerAudience,
      workerIngressId: BINDING.workerIngressId,
      workerGeneration: BINDING.workerGeneration,
      workerCredentialId: BINDING.workerCredentialId,
      action: 'status',
      operationId: OPERATION,
      attemptNonce: NONCE,
      nativeMethod: 'GET',
      nativePath: `/v1/runs/${encodeURIComponent(WORKER_RUN)}`,
      nativeBodySha256: sha256(STATUS_BODY),
      notBeforeEpochMicros: NOW,
      notAfterEpochMicros: AFTER,
    });
    expect(token).toBe(resignCommand(JSON.stringify(payload)));
    const claims = verifiedCommand(token);
    expect(Object.isFrozen(claims)).toBe(true);
    expect(matchesMeriHermesRecoveryNativeRequestV1(
      claims, 'GET', `/v1/runs/${WORKER_RUN}`, STATUS_BODY,
    )).toBe(true);
    expect(matchesMeriHermesRecoveryNativeRequestV1(
      claims, 'POST', `/v1/runs/${WORKER_RUN}`, STATUS_BODY,
    )).toBe(false);
    expect(matchesMeriHermesRecoveryNativeRequestV1(
      claims, 'GET', `/v1/runs/${WORKER_RUN}`, Buffer.from('{}'),
    )).toBe(false);
  });

  test('rejects duplicate, unknown, reordered, malformed, route-mutated, and unsigned mutations', () => {
    const token = mintMeriHermesRecoveryCommandV1(statusCommandMaterial, COMMAND_KEY);
    const payload = payloadOf(token);
    const verify = (candidate: unknown) => verifyMeriHermesRecoveryCommandV1(
      candidate, IDENTITY, WORKER_RUN, COMMAND_KEY, VERIFY_AT,
    );
    expect(verify(resignCommand(JSON.stringify({ ...payload, extra: true })))).toBeNull();
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    expect(verify(resignCommand(JSON.stringify(reordered)))).toBeNull();
    const duplicate = JSON.stringify(payload).replace(
      '"tenantId":',
      '"tenantId":"99999999-9999-4999-8999-999999999999","tenantId":',
    );
    expect(verify(resignCommand(duplicate))).toBeNull();
    expect(verify(resignCommand('{'))).toBeNull();
    expect(verify(resignCommand('[]'))).toBeNull();
    for (const mutation of [
      { keyId: 'another-command-key' },
      { tenantId: '99999999-9999-4999-8999-999999999999' },
      { runId: '99999999-9999-4999-8999-999999999999' },
      { requestSha256: 'c'.repeat(64) },
      { workerRunId: 'another-worker-run' },
      { workerAudience: 'another-audience' },
      { workerIngressId: 'another-ingress' },
      { workerGeneration: 'another-generation' },
      { workerCredentialId: 'another-credential' },
      { action: 'stop' },
      { nativeMethod: 'POST' },
      { nativePath: `/v1/runs/${WORKER_RUN}/stop` },
      { nativeBodySha256: 'd'.repeat(64) },
    ]) {
      expect(verify(resignCommand(JSON.stringify({ ...payload, ...mutation })))).toBeNull();
    }
    const [prefix, encoded, signature] = token.split('.');
    const mutatedSignature = `${signature!.slice(0, -1)}${signature!.endsWith('A') ? 'B' : 'A'}`;
    expect(verify(`${prefix}.${encoded}.${mutatedSignature}`)).toBeNull();
    expect(verify(token.replace('mhrc1.', 'mhrr1.'))).toBeNull();
    expect(verify(`${token}=`)).toBeNull();
  });

  test('enforces purpose-separated route keys and exclusive explicit windows', () => {
    const token = mintMeriHermesRecoveryCommandV1(statusCommandMaterial, COMMAND_KEY);
    expect(verifyMeriHermesRecoveryCommandV1(
      token, IDENTITY, WORKER_RUN, COMMAND_KEY, NOW,
    )).not.toBeNull();
    expect(verifyMeriHermesRecoveryCommandV1(
      token, IDENTITY, WORKER_RUN, COMMAND_KEY, AFTER,
    )).toBeNull();
    expect(verifyMeriHermesRecoveryCommandV1(
      token, IDENTITY, WORKER_RUN, COMMAND_KEY, '1790366299999999',
    )).toBeNull();
    expect(verifyMeriHermesRecoveryCommandV1(
      token, IDENTITY, WORKER_RUN,
      { ...COMMAND_KEY, workerCredentialId: 'another-credential' }, VERIFY_AT,
    )).toBeNull();
    expect(verifyMeriHermesRecoveryCommandV1(
      token, IDENTITY, WORKER_RUN,
      { ...COMMAND_KEY, purpose: MERI_HERMES_RECOVERY_RECEIPT_PURPOSE } as unknown as
        MeriHermesRecoveryCommandKeyV1,
      VERIFY_AT,
    )).toBeNull();
    expect(() => mintMeriHermesRecoveryCommandV1({
      ...statusCommandMaterial,
      notAfterEpochMicros: '1790366360000001',
    }, COMMAND_KEY)).toThrow('invalid Phase 4 recovery command window');
    expect(() => mintMeriHermesRecoveryCommandV1({
      ...statusCommandMaterial,
      nativeBodyBytes: Buffer.from('{}'),
    }, COMMAND_KEY)).toThrow('invalid Phase 4 recovery command material');
    expect(() => mintMeriHermesRecoveryCommandV1({
      ...statusCommandMaterial,
      attemptNonce: Buffer.alloc(15).toString('base64url'),
    }, COMMAND_KEY)).toThrow('invalid Phase 4 recovery command material');
  });

  test('signs a canonical nonterminal observation bound to the exact command and response', () => {
    const commandToken = mintMeriHermesRecoveryCommandV1(statusCommandMaterial, COMMAND_KEY);
    const command = verifiedCommand(commandToken);
    const receiptToken = mintMeriHermesRecoveryReceiptV1({
      commandToken,
      command,
      observation: 'run_nonterminal',
      workerStatus: 'running',
      nativeHttpStatus: 200,
      nativeResponseBodyBytes: STATUS_RESPONSE,
      observedAtEpochMicros: OBSERVED,
    }, RECEIPT_KEY);
    const payload = payloadOf(receiptToken);
    expect(Object.keys(payload)).toEqual([
      'version', 'purpose', 'keyId', 'tenantId', 'runId', 'requestSha256', 'workerRunId',
      'workerAudience', 'workerIngressId', 'workerGeneration', 'workerCredentialId',
      'action', 'operationId', 'attemptNonce', 'commandSha256', 'nativeMethod',
      'nativePath', 'nativeBodySha256', 'nativeHttpStatus',
      'nativeResponseBodySha256', 'observation', 'workerStatus',
      'observedAtEpochMicros', 'notBeforeEpochMicros', 'notAfterEpochMicros',
    ]);
    expect(payload).toMatchObject({
      version: 1,
      purpose: MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
      keyId: RECEIPT_KEY.keyId,
      tenantId: TENANT,
      runId: RUN,
      requestSha256: IDENTITY.requestSha256,
      workerRunId: WORKER_RUN,
      action: 'status',
      operationId: OPERATION,
      attemptNonce: NONCE,
      commandSha256: sha256(commandToken),
      nativeMethod: 'GET',
      nativePath: `/v1/runs/${WORKER_RUN}`,
      nativeHttpStatus: 200,
      nativeResponseBodySha256: sha256(STATUS_RESPONSE),
      observation: 'run_nonterminal',
      workerStatus: 'running',
      observedAtEpochMicros: OBSERVED,
      notAfterEpochMicros: AFTER,
    });
    expect(receiptToken).toBe(resignReceipt(JSON.stringify(payload)));
    const receipt = verifyMeriHermesRecoveryReceiptV1(
      receiptToken, commandToken, IDENTITY, WORKER_RUN,
      COMMAND_KEY, RECEIPT_KEY, VERIFY_AT,
    );
    expect(receipt).not.toBeNull();
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(meriHermesRecoveryDispositionV1(receipt)).toBe('nonterminal');
    expect(matchesMeriHermesRecoveryNativeResponseV1(
      receipt!, 200, STATUS_RESPONSE,
    )).toBe(true);
    expect(matchesMeriHermesRecoveryNativeResponseV1(
      receipt!, 200, TERMINAL_RESPONSE,
    )).toBe(false);
  });

  test('keeps not_found and transport UNKNOWN, stop acceptance nonterminal, and only terminal status terminal', () => {
    const statusToken = mintMeriHermesRecoveryCommandV1(statusCommandMaterial, COMMAND_KEY);
    const statusCommand = verifiedCommand(statusToken);
    const mintStatus = (
      observation: 'run_terminal' | 'not_found',
      workerStatus: 'cancelled' | null,
      nativeHttpStatus: 200 | 404,
      body: Buffer,
    ) => mintMeriHermesRecoveryReceiptV1({
      commandToken: statusToken,
      command: statusCommand,
      observation,
      workerStatus,
      nativeHttpStatus,
      nativeResponseBodyBytes: body,
      observedAtEpochMicros: OBSERVED,
    }, RECEIPT_KEY);
    const terminal = verifyMeriHermesRecoveryReceiptV1(
      mintStatus('run_terminal', 'cancelled', 200, TERMINAL_RESPONSE),
      statusToken, IDENTITY, WORKER_RUN, COMMAND_KEY, RECEIPT_KEY, VERIFY_AT,
    );
    const notFound = verifyMeriHermesRecoveryReceiptV1(
      mintStatus('not_found', null, 404, NOT_FOUND_RESPONSE),
      statusToken, IDENTITY, WORKER_RUN, COMMAND_KEY, RECEIPT_KEY, VERIFY_AT,
    );
    expect(meriHermesRecoveryDispositionV1(terminal)).toBe('terminal');
    expect(meriHermesRecoveryDispositionV1(notFound)).toBe('UNKNOWN');
    expect(meriHermesRecoveryDispositionV1(null)).toBe('UNKNOWN');

    const stopToken = mintMeriHermesRecoveryCommandV1(stopCommandMaterial, COMMAND_KEY);
    const stopCommand = verifyMeriHermesRecoveryCommandV1(
      stopToken, IDENTITY, WORKER_RUN, COMMAND_KEY, VERIFY_AT,
    )!;
    expect(matchesMeriHermesRecoveryNativeRequestV1(
      stopCommand, 'POST', `/v1/runs/${WORKER_RUN}/stop`, STOP_BODY,
    )).toBe(true);
    const stopAcceptedToken = mintMeriHermesRecoveryReceiptV1({
      commandToken: stopToken,
      command: stopCommand,
      observation: 'stop_accepted',
      workerStatus: null,
      nativeHttpStatus: 202,
      nativeResponseBodyBytes: Buffer.from('{"accepted":true}'),
      observedAtEpochMicros: OBSERVED,
    }, RECEIPT_KEY);
    const stopAccepted = verifyMeriHermesRecoveryReceiptV1(
      stopAcceptedToken, stopToken, IDENTITY, WORKER_RUN,
      COMMAND_KEY, RECEIPT_KEY, VERIFY_AT,
    );
    expect(meriHermesRecoveryDispositionV1(stopAccepted)).toBe('nonterminal');
  });

  test('rejects invalid normalized facts, receipt mutation, wrong command, and cross-purpose keys', () => {
    const commandToken = mintMeriHermesRecoveryCommandV1(statusCommandMaterial, COMMAND_KEY);
    const command = verifiedCommand(commandToken);
    const base = {
      commandToken,
      command,
      nativeResponseBodyBytes: STATUS_RESPONSE,
      observedAtEpochMicros: OBSERVED,
    };
    expect(() => mintMeriHermesRecoveryReceiptV1({
      ...base, observation: 'run_nonterminal', workerStatus: 'completed', nativeHttpStatus: 200,
    }, RECEIPT_KEY)).toThrow('invalid Phase 4 recovery receipt material');
    expect(() => mintMeriHermesRecoveryReceiptV1({
      ...base, observation: 'stop_accepted', workerStatus: null, nativeHttpStatus: 202,
    }, RECEIPT_KEY)).toThrow('invalid Phase 4 recovery receipt material');
    expect(() => mintMeriHermesRecoveryReceiptV1({
      ...base, observation: 'not_found', workerStatus: null, nativeHttpStatus: 200,
    }, RECEIPT_KEY)).toThrow('invalid Phase 4 recovery receipt material');

    const receiptToken = mintMeriHermesRecoveryReceiptV1({
      ...base,
      observation: 'run_nonterminal',
      workerStatus: 'running',
      nativeHttpStatus: 200,
    }, RECEIPT_KEY);
    const receiptPayload = payloadOf(receiptToken);
    const verify = (candidate: unknown, selectedCommand = commandToken) =>
      verifyMeriHermesRecoveryReceiptV1(
        candidate, selectedCommand, IDENTITY, WORKER_RUN,
        COMMAND_KEY, RECEIPT_KEY, VERIFY_AT,
      );
    expect(verify(resignReceipt(JSON.stringify({ ...receiptPayload, extra: true })))).toBeNull();
    expect(verify(resignReceipt(JSON.stringify(
      Object.fromEntries(Object.entries(receiptPayload).reverse()),
    )))).toBeNull();
    const duplicate = JSON.stringify(receiptPayload).replace(
      '"observation":', '"observation":"not_found","observation":',
    );
    expect(verify(resignReceipt(duplicate))).toBeNull();
    expect(verify(resignReceipt(JSON.stringify({
      ...receiptPayload, workerCredentialId: 'other-credential',
    })))).toBeNull();
    expect(verify(resignReceipt(JSON.stringify({
      ...receiptPayload, keyId: 'another-receipt-key',
    })))).toBeNull();
    expect(verify(resignReceipt(JSON.stringify({
      ...receiptPayload, observation: 'run_terminal', workerStatus: 'running',
    })))).toBeNull();
    const otherCommand = mintMeriHermesRecoveryCommandV1({
      ...statusCommandMaterial,
      operationId: '88888888-8888-4888-8888-888888888888',
      attemptNonce: Buffer.alloc(16, 33).toString('base64url'),
    }, COMMAND_KEY);
    expect(verify(receiptToken, otherCommand)).toBeNull();
    expect(verifyMeriHermesRecoveryReceiptV1(
      receiptToken, commandToken, IDENTITY, WORKER_RUN, COMMAND_KEY,
      { ...RECEIPT_KEY, purpose: MERI_HERMES_RECOVERY_COMMAND_PURPOSE } as unknown as
        MeriHermesRecoveryReceiptKeyV1,
      VERIFY_AT,
    )).toBeNull();
    expect(verifyMeriHermesRecoveryReceiptV1(
      receiptToken, commandToken, IDENTITY, WORKER_RUN, COMMAND_KEY,
      { ...RECEIPT_KEY, secret: COMMAND_KEY.secret }, VERIFY_AT,
    )).toBeNull();
    const reusedReceiptKey = { ...RECEIPT_KEY, secret: COMMAND_KEY.secret };
    const reusedKeyReceipt = mintMeriHermesRecoveryReceiptV1({
      ...base,
      observation: 'run_nonterminal',
      workerStatus: 'running',
      nativeHttpStatus: 200,
    }, reusedReceiptKey);
    expect(verifyMeriHermesRecoveryReceiptV1(
      reusedKeyReceipt, commandToken, IDENTITY, WORKER_RUN,
      COMMAND_KEY, reusedReceiptKey, VERIFY_AT,
    )).toBeNull();
  });

  test('uses only caller-supplied times and never reads the process clock', () => {
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('process clock must not be read');
    });
    try {
      const commandToken = mintMeriHermesRecoveryCommandV1(statusCommandMaterial, COMMAND_KEY);
      const command = verifiedCommand(commandToken);
      const receiptToken = mintMeriHermesRecoveryReceiptV1({
        commandToken,
        command,
        observation: 'run_nonterminal',
        workerStatus: 'running',
        nativeHttpStatus: 200,
        nativeResponseBodyBytes: STATUS_RESPONSE,
        observedAtEpochMicros: OBSERVED,
      }, RECEIPT_KEY);
      expect(verifyMeriHermesRecoveryReceiptV1(
        receiptToken, commandToken, IDENTITY, WORKER_RUN,
        COMMAND_KEY, RECEIPT_KEY, VERIFY_AT,
      )).not.toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});
