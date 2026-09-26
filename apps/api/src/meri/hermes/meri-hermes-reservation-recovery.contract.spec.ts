import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestMaterialV2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
  type MeriHermesRecoveryCommandKeyV1,
  type MeriHermesRecoveryReceiptKeyV1,
} from './meri-hermes-dispatch-recovery.contract.js';
import {
  MERI_HERMES_RESERVATION_NATIVE_PATH,
  matchesMeriHermesReservationNativeRequestV1,
  matchesMeriHermesReservationNativeResponseV1,
  mintMeriHermesReservationCommandV1,
  verifyMeriHermesReservationCommandV1,
  verifyMeriHermesReservationReceiptV1,
} from './meri-hermes-reservation-recovery.contract.js';

const DELIVERY = '1790366290000000';
const COMMAND_BEFORE = '1790366300000000';
const COMMAND_AFTER = '1790366350000000';
const AUTH_NOW = '1790366320000000';
const OBSERVED = '1790366330000000';
const VERIFY_NOW = '1790366340000000';
const IDEMPOTENCY_KEY = 'phase4-dispatch-55555555';
const OPERATION_ID = '77777777-7777-4777-8777-777777777777';
const ATTEMPT_NONCE = 'ISEhISEhISEhISEhISEhIQ';

interface JsonKey {
  readonly purpose: string;
  readonly keyId: string;
  readonly tenantId: string;
  readonly workerAudience: string;
  readonly workerIngressId: string;
  readonly workerGeneration: string;
  readonly workerCredentialId: string;
  readonly secretBase64url: string;
  readonly notBeforeEpochMicros: string;
  readonly notAfterEpochMicros: string;
}

interface RecoveryVector {
  readonly identity: Readonly<Record<string, unknown>>;
  readonly commandKey: JsonKey;
  readonly receiptKey: JsonKey;
}

interface ReservationVector {
  readonly commandToken: string;
  readonly receiptToken: string;
  readonly nativeResponseBodyBase64url: string;
}

const ROOT = join(__dirname, '../../../../../docker/hermes-worker/overlay');
const BASE = JSON.parse(readFileSync(
  join(ROOT, 'recovery-receipt-vectors.json'), 'utf8',
)) as RecoveryVector;
const VECTOR = JSON.parse(readFileSync(
  join(ROOT, 'reservation-recovery-vectors.json'), 'utf8',
)) as ReservationVector;
const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const RUN = '55555555-5555-4555-8555-555555555555';
const SCOPE = `tenant:${TENANT}:user:${ACTOR}`;
const DISPATCH_MATERIAL: MeriDispatchRequestMaterialV2 = {
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
const IDENTITY: MeriDispatchRequestIdentityV2 =
  createMeriDispatchRequestIdentityV2(DISPATCH_MATERIAL);

function commandKey(row = BASE.commandKey): MeriHermesRecoveryCommandKeyV1 {
  return {
    purpose: MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
    keyId: row.keyId,
    tenantId: row.tenantId,
    workerAudience: row.workerAudience,
    workerIngressId: row.workerIngressId,
    workerGeneration: row.workerGeneration,
    workerCredentialId: row.workerCredentialId,
    secret: Buffer.from(row.secretBase64url, 'base64url'),
    notBeforeEpochMicros: row.notBeforeEpochMicros,
    notAfterEpochMicros: row.notAfterEpochMicros,
  };
}

function receiptKey(row = BASE.receiptKey): MeriHermesRecoveryReceiptKeyV1 {
  return {
    purpose: MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
    keyId: row.keyId,
    tenantId: row.tenantId,
    workerAudience: row.workerAudience,
    workerIngressId: row.workerIngressId,
    workerGeneration: row.workerGeneration,
    workerCredentialId: row.workerCredentialId,
    secret: Buffer.from(row.secretBase64url, 'base64url'),
    notBeforeEpochMicros: row.notBeforeEpochMicros,
    notAfterEpochMicros: row.notAfterEpochMicros,
  };
}

const COMMAND_KEY = commandKey();
const RECEIPT_KEY = receiptKey();
const RESPONSE_BODY = Buffer.from(VECTOR.nativeResponseBodyBase64url, 'base64url');
const MATERIAL = {
  identity: IDENTITY,
  idempotencyKey: IDEMPOTENCY_KEY,
  deliveryNotBeforeEpochMicros: DELIVERY,
  operationId: OPERATION_ID,
  attemptNonce: ATTEMPT_NONCE,
  notBeforeEpochMicros: COMMAND_BEFORE,
  notAfterEpochMicros: COMMAND_AFTER,
};

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as
    Record<string, unknown>;
}

function resign(prefix: 'mhrqc1' | 'mhrqr1', domain: string, json: string, secret: Uint8Array) {
  const payload = Buffer.from(json, 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(domain, 'utf8').update(`${prefix}.${payload}`, 'ascii').digest('base64url');
  return `${prefix}.${payload}.${signature}`;
}

function resignCommand(json: string) {
  return resign(
    'mhrqc1', 'capiro.meri.phase4.reservation-command/v1\0', json, COMMAND_KEY.secret,
  );
}

function resignReceipt(json: string) {
  return resign(
    'mhrqr1', 'capiro.meri.phase4.reservation-receipt/v1\0', json, RECEIPT_KEY.secret,
  );
}

describe('dormant Phase 4 unknown-worker reservation recovery contract v1', () => {
  test('matches the Python command, receipt, and exact native response vector', () => {
    const commandToken = mintMeriHermesReservationCommandV1(MATERIAL, COMMAND_KEY);
    expect(commandToken).toBe(VECTOR.commandToken);
    const command = verifyMeriHermesReservationCommandV1(
      commandToken, IDENTITY, COMMAND_KEY, AUTH_NOW,
    );
    expect(command).not.toBeNull();
    expect(Object.isFrozen(command)).toBe(true);
    expect(matchesMeriHermesReservationNativeRequestV1(
      command!, 'POST', MERI_HERMES_RESERVATION_NATIVE_PATH, '', Buffer.alloc(0),
    )).toBe(true);
    const receipt = verifyMeriHermesReservationReceiptV1(
      VECTOR.receiptToken, commandToken, IDENTITY, COMMAND_KEY, RECEIPT_KEY, VERIFY_NOW,
    );
    expect(receipt).toMatchObject({
      outcome: 'reserved', workerRunId: 'worker-run-1', workerStatus: 'running',
      observedAtEpochMicros: OBSERVED,
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(matchesMeriHermesReservationNativeResponseV1(
      receipt!, 200, RESPONSE_BODY,
    )).toBe(true);
    expect(matchesMeriHermesReservationNativeResponseV1(
      receipt!, 200, Buffer.concat([RESPONSE_BODY, Buffer.from(' ')]),
    )).toBe(false);
  });

  test('rejects noncanonical, duplicate, unknown, route-mutated, and unsigned commands', () => {
    const payload = payloadOf(VECTOR.commandToken);
    const verify = (token: unknown) => verifyMeriHermesReservationCommandV1(
      token, IDENTITY, COMMAND_KEY, AUTH_NOW,
    );
    expect(verify(resignCommand(JSON.stringify({ ...payload, extra: true })))).toBeNull();
    expect(verify(resignCommand(JSON.stringify(
      Object.fromEntries(Object.entries(payload).reverse()),
    )))).toBeNull();
    expect(verify(resignCommand(JSON.stringify(payload).replace(
      '"tenantId":', '"tenantId":"99999999-9999-4999-8999-999999999999","tenantId":',
    )))).toBeNull();
    for (const mutation of [
      { requestSha256: '0'.repeat(64) },
      { workerIngressId: 'different-ingress' },
      { nativeMethod: 'GET' },
      { nativePath: `${MERI_HERMES_RESERVATION_NATIVE_PATH}/` },
    ]) {
      expect(verify(resignCommand(JSON.stringify({ ...payload, ...mutation })))).toBeNull();
    }
    const [prefix, encoded, signature] = VECTOR.commandToken.split('.');
    expect(verify(`${prefix}.${encoded}.${signature!.slice(0, -1)}A`)).toBeNull();
    expect(verify(VECTOR.commandToken.replace('mhrqc1.', 'mhrqr1.'))).toBeNull();
  });

  test('enforces exclusive command windows and the post-delivery cutoff', () => {
    expect(verifyMeriHermesReservationCommandV1(
      VECTOR.commandToken, IDENTITY, COMMAND_KEY, COMMAND_BEFORE,
    )).not.toBeNull();
    expect(verifyMeriHermesReservationCommandV1(
      VECTOR.commandToken, IDENTITY, COMMAND_KEY, COMMAND_AFTER,
    )).toBeNull();
    expect(() => mintMeriHermesReservationCommandV1({
      ...MATERIAL, notBeforeEpochMicros: '1790366289999999',
    }, COMMAND_KEY)).toThrow('invalid Phase 4 reservation command window');
    expect(matchesMeriHermesReservationNativeRequestV1(
      verifyMeriHermesReservationCommandV1(
        VECTOR.commandToken, IDENTITY, COMMAND_KEY, AUTH_NOW,
      )!, 'POST', MERI_HERMES_RESERVATION_NATIVE_PATH, 'x=1', Buffer.alloc(0),
    )).toBe(false);
  });

  test('rejects receipt mutation, response substitution, and shared command/receipt secrets', () => {
    const payload = payloadOf(VECTOR.receiptToken);
    const verify = (token: unknown, selectedReceiptKey = RECEIPT_KEY) =>
      verifyMeriHermesReservationReceiptV1(
        token, VECTOR.commandToken, IDENTITY, COMMAND_KEY, selectedReceiptKey, VERIFY_NOW,
      );
    expect(verify(resignReceipt(JSON.stringify({ ...payload, extra: true })))).toBeNull();
    expect(verify(resignReceipt(JSON.stringify(
      Object.fromEntries(Object.entries(payload).reverse()),
    )))).toBeNull();
    expect(verify(resignReceipt(JSON.stringify(payload).replace(
      '"outcome":', '"outcome":"sealed_absent","outcome":',
    )))).toBeNull();
    for (const mutation of [
      { commandSha256: '0'.repeat(64) },
      { workerRunId: null },
      { workerStatus: 'not-a-status' },
      { observedAtEpochMicros: COMMAND_AFTER },
    ]) {
      expect(verify(resignReceipt(JSON.stringify({ ...payload, ...mutation })))).toBeNull();
    }
    expect(verify(VECTOR.receiptToken, {
      ...RECEIPT_KEY, secret: COMMAND_KEY.secret,
    })).toBeNull();
  });

  test('requires a sealed absence to be after delivery, observed, and before retention', () => {
    const payload = payloadOf(VECTOR.receiptToken);
    const verifySealed = (sealedAtEpochMicros: string) => verifyMeriHermesReservationReceiptV1(
      resignReceipt(JSON.stringify({
        ...payload,
        outcome: 'sealed_absent',
        workerRunId: null,
        workerStatus: null,
        sealedAtEpochMicros,
      })),
      VECTOR.commandToken, IDENTITY, COMMAND_KEY, RECEIPT_KEY, VERIFY_NOW,
    );
    expect(verifySealed('1790366289999999')).toBeNull();
    expect(verifySealed('1790366330000001')).toBeNull();
    expect(verifySealed(IDENTITY.retainUntilEpochMicros)).toBeNull();
  });
});
