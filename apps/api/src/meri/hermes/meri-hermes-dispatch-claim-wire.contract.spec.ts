import {
  decodeMeriHermesDispatchClaimWireV2,
  handleMeriHermesDispatchClaimWireV2,
} from './meri-hermes-dispatch-claim-wire.contract.js';

const raw = Buffer.from('{ "z": 1, "input" : "hello", "a": 2 }', 'utf8');
const wire = {
  version: 2 as const,
  receivedMethod: 'POST' as const,
  receivedPath: '/v1/runs' as const,
  receivedContentType: 'application/json' as const,
  tenantId: '11111111-1111-4111-8111-111111111111',
  runId: '55555555-5555-4555-8555-555555555555',
  requestSha256: 'a'.repeat(64),
  workerRunId: 'run_worker_1',
  bearer: 'mdgb1.payload.signature',
  toolViewAttestation: 'payload.signature',
  bodyBase64url: raw.toString('base64url'),
  sessionHeaderValue: 'scope:conversation:e1',
  idempotencyKeyHeaderValue: 'stable-idempotency-key',
};
const { tenantId: _tenantId, ...wireWithoutTenant } = wire;
const reorderedWire = { tenantId: wire.tenantId, ...wireWithoutTenant };

describe('dormant Phase 4 claim HTTP wire contract', () => {
  test('preserves exact noncanonical body bytes and received request attributes', () => {
    const decoded = decodeMeriHermesDispatchClaimWireV2(wire, 's'.repeat(32));
    expect(decoded).not.toBeNull();
    expect(Buffer.from(decoded!.bodyBytes)).toEqual(raw);
    expect(decoded).toMatchObject({
      receivedMethod: 'POST', receivedPath: '/v1/runs',
      receivedContentType: 'application/json',
      sessionHeaderValue: wire.sessionHeaderValue,
      idempotencyKeyHeaderValue: wire.idempotencyKeyHeaderValue,
      serviceSecretHeaderValue: 's'.repeat(32),
    });
  });

  test.each([
    { ...wire, receivedMethod: 'PUT' },
    { ...wire, receivedPath: '/p/other/v1/runs' },
    { ...wire, receivedContentType: 'application/json; charset=utf-8' },
    { ...wire, bodyBase64url: `${wire.bodyBase64url}=` },
    { ...wire, extra: true },
    reorderedWire,
  ])('rejects noncanonical or widened wire input %#', (invalid) => {
    expect(decodeMeriHermesDispatchClaimWireV2(invalid, 's'.repeat(32))).toBeNull();
  });

  test('never calls the boundary for malformed input', async () => {
    const boundary = { claim: jest.fn() };
    await expect(handleMeriHermesDispatchClaimWireV2(
      boundary, { ...wire, receivedPath: '/p/other/v1/runs' }, 's'.repeat(32),
    )).resolves.toEqual({ version: 2, kind: 'rejected', launchAuthorized: false });
    expect(boundary.claim).not.toHaveBeenCalled();
  });
});
