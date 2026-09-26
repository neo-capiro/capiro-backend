import { describe, expect, it } from '@jest/globals';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  capabilityShadowMembershipPayloadToCanonicalJson,
  verifyCapabilityShadowMembershipManifest,
  type CapabilityShadowMembershipPayload,
} from './capability-shadow';
import { deriveCapabilityShadowPseudonyms } from './capability-shadow-event-trust';
import {
  appendCapabilityShadowSignedEvent,
  capabilityShadowAppendReceiptPayloadSchema,
  capabilityShadowAuthenticatedAppendRequestDigest,
  capabilityShadowLedgerEntryDigest,
  capabilityShadowSinkReceiptSigningBytes,
  verifyCapabilityShadowAuthenticatedAppendRequestBytes,
  verifyCapabilityShadowAuthenticatedAppendRequestBytesForReplay,
  type CapabilityShadowAppendBoundaryInput,
  type CapabilityShadowAuthenticatedAppendRequest,
  type VerifiedCapabilityShadowCurrentAppendAuthorizedRequest,
  type VerifiedCapabilityShadowReplayLookupRequest,
} from './capability-shadow-append-boundary';

const sha256 = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
const occurredAt = '2026-09-25T10:00:03.000Z';
const appendedAt = '2026-09-25T10:00:04.000Z';
const receiptIssuedAt = '2026-09-25T10:00:05.000Z';
const trustedTime = { verifiedAt: receiptIssuedAt, maxFutureSkewMs: 1_000 };
const window = {
  notBefore: '2026-01-01T00:00:00.000Z',
  notAfter: '2027-01-01T00:00:00.000Z',
};

function terminalAttempt() {
  return {
    status: 'settled' as const,
    attemptedAt: '2026-09-25T10:00:00.000Z',
    dispatchedAt: '2026-09-25T10:00:01.000Z',
    finishedAt: '2026-09-25T10:00:02.000Z',
    durationMs: 50,
    inputTokens: 10,
    outputTokens: 4,
    costUsd: 0.001,
  };
}

function fixture(
  disposition: 'appended' | 'replayed' | 'append_then_replay' = 'appended',
  sinkKeyWindow = window,
) {
  const membershipSigning = generateKeyPairSync('ed25519');
  const producerSigning = generateKeyPairSync('ed25519');
  const sinkSigning = generateKeyPairSync('ed25519');
  const tenantIdentifier = Buffer.from('private-tenant-42', 'utf8');
  const evaluationUnitIdentifier = Buffer.from('private-evaluation-unit-99', 'utf8');
  const tenantKey = {
    keyId: 'tenant_2026', version: 'tenant_hmac.v1',
    secret: Buffer.alloc(32, 0x21), window,
  };
  const evaluationUnitKey = {
    keyId: 'unit_2026', version: 'eval_unit_hmac.v1',
    secret: Buffer.alloc(32, 0x31), window,
  };
  const pseudonyms = deriveCapabilityShadowPseudonyms({
    tenantIdentifier, evaluationUnitIdentifier, tenantKey, evaluationUnitKey, occurredAt,
  });
  const assignment: CapabilityShadowMembershipPayload['assignments'][number] = {
    turnKeyHash: sha256('turn-1'),
    evaluationUnitHash: pseudonyms.evaluationUnitHash,
    evaluationUnitKeyVersion: pseudonyms.evaluationUnitKeyVersion,
    tenantPseudonymHash: pseudonyms.tenantPseudonymHash,
    tenantPseudonymKeyVersion: pseudonyms.tenantPseudonymKeyVersion,
    eligibleSelected: true,
    eligibilityReason: null,
    source: 'live',
    cohort: 'representative',
    split: 'tuning',
    surface: 'chat',
    domain: 'gov_affairs',
    taskFamily: 'awards_search',
  };
  const membershipPayload: CapabilityShadowMembershipPayload = {
    version: 'meri_capability_shadow_membership.v1',
    keyId: 'membership_2026',
    versions: {
      catalog: 'catalog.v1', routingModel: 'jev_luna.v1', question: 'route.v1',
      policy: 'policy.v1', selectionPolicy: 'sampling.v1',
    },
    registry: {
      surfaces: ['chat'], domains: ['gov_affairs'], taskFamilies: ['awards_search'],
      routes: ['general', 'awards'], tools: ['award_search'], reasonCodes: ['no_result'],
    },
    assignments: [assignment],
  };
  const membership = verifyCapabilityShadowMembershipManifest({
    payload: membershipPayload,
    signatureBase64: sign(
      null,
      Buffer.from(capabilityShadowMembershipPayloadToCanonicalJson(membershipPayload)),
      membershipSigning.privateKey,
    ).toString('base64'),
  }, membershipSigning.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  sha256(membershipSigning.publicKey.export({ type: 'spki', format: 'der' })));

  const producerRegistry = {
    signing: [{
      keyId: 'event_2026', version: 'event_ed25519.v1',
      publicKeyPem: producerSigning.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      trustedSpkiSha256: sha256(producerSigning.publicKey.export({ type: 'spki', format: 'der' })),
      window,
    }],
    tenant: [{ keyId: tenantKey.keyId, version: tenantKey.version, window }],
    evaluationUnit: [{ keyId: evaluationUnitKey.keyId, version: evaluationUnitKey.version, window }],
  };
  const producerRegistryBytes = Buffer.from(JSON.stringify(producerRegistry), 'utf8');
  const sinkRegistry = {
    version: 'meri_capability_shadow_sink_registry.v1',
    keys: [{
      keyId: 'sink_2026', version: 'sink_receipt_ed25519.v1',
      audience: 'meri-shadow-evidence', endpointId: 'primary',
      publicKeyPem: sinkSigning.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      trustedSpkiSha256: sha256(sinkSigning.publicKey.export({ type: 'spki', format: 'der' })),
      window: sinkKeyWindow,
    }],
  };
  const sinkRegistryBytes = Buffer.from(JSON.stringify(sinkRegistry), 'utf8');
  let producerSignCalls = 0;
  let authorizationCalls = 0;
  let appendCalls = 0;
  let lastRequest: CapabilityShadowAuthenticatedAppendRequest | null = null;

  const producer = {
    mode: 'prepare_only' as const,
    membership,
    observed: {
      turnKeyHash: assignment.turnKeyHash,
      occurredAt,
      route: { baseline: 'general', candidate: 'awards', confidence: 0.8, fallbackReason: null },
      tools: {
        required: ['award_search'], candidateExposed: ['award_search'],
        baselineExposed: ['award_search'], baselineUsed: ['award_search'],
      },
      execution: { executor: 'baseline' as const, baseline: terminalAttempt(), jev: terminalAttempt() },
    },
    tenantIdentifier,
    evaluationUnitIdentifier,
    tenantKey,
    evaluationUnitKey,
    signingKeyId: 'event_2026',
    publicRegistryBytes: producerRegistryBytes,
    expectedPublicRegistrySha256: sha256(producerRegistryBytes),
    sign: async (bytes: Uint8Array) => {
      producerSignCalls += 1;
      return sign(null, bytes, producerSigning.privateKey);
    },
  };
  const input: Extract<CapabilityShadowAppendBoundaryInput, { mode: 'append_only' }> = {
    mode: 'append_only',
    producer,
    trustedTime,
    sink: {
      audience: 'meri-shadow-evidence',
      endpointId: 'primary',
      publicRegistryBytes: sinkRegistryBytes,
      expectedPublicRegistrySha256: sha256(sinkRegistryBytes),
      authorize: async (bytes: Uint8Array) => {
        authorizationCalls += 1;
        return sign(null, bytes, producerSigning.privateKey);
      },
      append: async (requestBytes) => {
        appendCalls += 1;
        const { request } = verifyCapabilityShadowAuthenticatedAppendRequestBytes(
          requestBytes,
          producerRegistryBytes,
          sha256(producerRegistryBytes),
          {
            audience: 'meri-shadow-evidence',
            endpointId: 'primary',
            sinkRegistrySha256: sha256(sinkRegistryBytes),
          },
          trustedTime,
        );
        lastRequest = request;
        const requestDigest = capabilityShadowAuthenticatedAppendRequestDigest(request);
        const entryWithoutDigest = {
          sequence: 1,
          previousEntryDigest: null,
          appendedAt,
          requestDigest,
          eventId: request.payload.envelope.payload.event.eventId,
          idempotencyKey: request.payload.idempotencyKey,
          eventPayloadDigest: request.payload.eventPayloadDigest,
        };
        const payload = {
          version: 'meri_capability_shadow_append_receipt.v1' as const,
          audience: request.payload.audience,
          endpointId: request.payload.endpointId,
          disposition: disposition === 'append_then_replay'
            ? (appendCalls === 1 ? 'appended' as const : 'replayed' as const)
            : disposition,
          receiptIssuedAt,
          requestDigest,
          entry: {
            ...entryWithoutDigest,
            ledgerEntryDigest: capabilityShadowLedgerEntryDigest(entryWithoutDigest),
          },
        };
        return Buffer.from(JSON.stringify({
          payload,
          sinkKey: { keyId: 'sink_2026', version: 'sink_receipt_ed25519.v1' },
          signatureBase64: sign(
            null,
            capabilityShadowSinkReceiptSigningBytes(payload),
            sinkSigning.privateKey,
          ).toString('base64'),
        }), 'utf8');
      },
    },
  };
  return {
    input,
    tenantIdentifier,
    evaluationUnitIdentifier,
    sinkRegistry,
    sinkRegistryBytes,
    sinkSigning,
    producerRegistryBytes,
    calls: () => ({ producerSignCalls, authorizationCalls, appendCalls }),
    lastRequest: () => lastRequest,
  };
}

describe('dormant capability shadow authenticated append boundary', () => {
  it('keeps off mode zero-touch even with hostile getters', async () => {
    const input = {
      mode: 'off' as const,
      get producer() { throw new Error('producer accessed'); },
      get sink() { throw new Error('sink accessed'); },
    };
    expect(await appendCapabilityShadowSignedEvent(input)).toBeNull();
  });

  it('authenticates one content-free final event and verifies an appended ledger receipt', async () => {
    const f = fixture();
    const result = await appendCapabilityShadowSignedEvent(f.input);
    expect(result).not.toBeNull();
    expect(f.calls()).toEqual({ producerSignCalls: 1, authorizationCalls: 1, appendCalls: 1 });
    expect(result!.request.payload.idempotencyKey)
      .toBe(result!.prepared.envelope.payload.event.eventId);
    expect(result!.receipt.payload.disposition).toBe('appended');
    expect(result!.requestDigest).toBe(result!.receipt.payload.entry.requestDigest);
    const serialized = JSON.stringify({ request: f.lastRequest(), result });
    expect(serialized).not.toContain(f.tenantIdentifier.toString('utf8'));
    expect(serialized).not.toContain(f.evaluationUnitIdentifier.toString('utf8'));
    expect(serialized).not.toContain('liveEvidenceVerified');
    expect(serialized).not.toContain('qualified');
  });

  it('uses identical bytes and returns the original immutable entry on a second-call replay', async () => {
    const f = fixture('append_then_replay');
    const first = await appendCapabilityShadowSignedEvent(f.input);
    const second = await appendCapabilityShadowSignedEvent(f.input);
    expect(first!.receipt.payload.disposition).toBe('appended');
    expect(second!.receipt.payload.disposition).toBe('replayed');
    expect(Buffer.from(second!.requestBytes)).toEqual(Buffer.from(first!.requestBytes));
    expect(second!.requestDigest).toBe(first!.requestDigest);
    expect(second!.receipt.payload.entry).toEqual(first!.receipt.payload.entry);
    expect(second!.receipt.payload.entry.eventId).toBe(second!.request.payload.idempotencyKey);
    expect(f.calls()).toEqual({ producerSignCalls: 2, authorizationCalls: 2, appendCalls: 2 });
  });

  it('gives the sink an exact-byte verifier that rejects ambiguous request JSON', async () => {
    const f = fixture();
    const result = await appendCapabilityShadowSignedEvent(f.input);
    const noncanonical = Buffer.concat([Buffer.from(' ', 'utf8'), result!.requestBytes]);
    expect(() => verifyCapabilityShadowAuthenticatedAppendRequestBytes(
      noncanonical,
      f.producerRegistryBytes,
      sha256(f.producerRegistryBytes),
      {
        audience: 'meri-shadow-evidence', endpointId: 'primary',
        sinkRegistrySha256: sha256(f.sinkRegistryBytes),
      },
      trustedTime,
    )).toThrow('not canonical JSON');

    const duplicate = Buffer.from(
      Buffer.from(result!.requestBytes).toString('utf8')
        .replace('{"payload":', '{"payload":null,"payload":'),
      'utf8',
    );
    expect(() => verifyCapabilityShadowAuthenticatedAppendRequestBytes(
      duplicate,
      f.producerRegistryBytes,
      sha256(f.producerRegistryBytes),
      {
        audience: 'meri-shadow-evidence', endpointId: 'primary',
        sinkRegistrySha256: sha256(f.sinkRegistryBytes),
      },
      trustedTime,
    )).toThrow('duplicate raw JSON key');

    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), result!.requestBytes]);
    expect(() => verifyCapabilityShadowAuthenticatedAppendRequestBytes(
      bom,
      f.producerRegistryBytes,
      sha256(f.producerRegistryBytes),
      {
        audience: 'meri-shadow-evidence', endpointId: 'primary',
        sinkRegistrySha256: sha256(f.sinkRegistryBytes),
      },
      trustedTime,
    )).toThrow('UTF-8 BOM');
  });

  it('rejects a ledger sequence above the exact JavaScript integer boundary', async () => {
    const f = fixture();
    const result = await appendCapabilityShadowSignedEvent(f.input);
    const oversized = {
      ...result!.receipt.payload,
      entry: {
        ...result!.receipt.payload.entry,
        sequence: (2 ** 53) + 2,
        previousEntryDigest: sha256('previous'),
      },
    };
    expect(capabilityShadowAppendReceiptPayloadSchema.safeParse(oversized).success).toBe(false);
  });

  it('keeps a private canonical request snapshot when the sink mutates and retains its copy', async () => {
    const f = fixture();
    const validAppend = f.input.sink.append;
    let retained: Uint8Array | null = null;
    const result = await appendCapabilityShadowSignedEvent({
      ...f.input,
      sink: {
        ...f.input.sink,
        append: async (requestBytes) => {
          retained = requestBytes;
          const pristine = Buffer.from(requestBytes);
          requestBytes.fill(0);
          return validAppend(pristine);
        },
      },
    });
    const returned = Buffer.from(result!.requestBytes);
    retained!.fill(0xff);
    expect(Buffer.from(result!.requestBytes)).toEqual(returned);
    const verified = verifyCapabilityShadowAuthenticatedAppendRequestBytes(
      result!.requestBytes,
      f.producerRegistryBytes,
      sha256(f.producerRegistryBytes),
      {
        audience: 'meri-shadow-evidence', endpointId: 'primary',
        sinkRegistrySha256: sha256(f.sinkRegistryBytes),
      },
      trustedTime,
    );
    expect(verified.requestDigest).toBe(result!.requestDigest);
  });

  it('rejects expired authorization at trusted verification time and future-dated receipts', async () => {
    const expired = fixture();
    await expect(appendCapabilityShadowSignedEvent({
      ...expired.input,
      trustedTime: { verifiedAt: window.notAfter, maxFutureSkewMs: 0 },
    })).rejects.toThrow('authorization key');
    expect(expired.calls().appendCalls).toBe(0);

    const future = fixture();
    await expect(appendCapabilityShadowSignedEvent({
      ...future.input,
      trustedTime: { verifiedAt: occurredAt, maxFutureSkewMs: 500 },
    })).rejects.toThrow('sink append time');
    expect(future.calls().appendCalls).toBe(1);

    const receiptKeyExpired = fixture('appended', {
      notBefore: window.notBefore,
      notAfter: '2026-09-25T10:00:05.500Z',
    });
    await expect(appendCapabilityShadowSignedEvent({
      ...receiptKeyExpired.input,
      trustedTime: { verifiedAt: '2026-09-25T10:00:06.000Z', maxFutureSkewMs: 0 },
    })).rejects.toThrow('receipt key');
    expect(receiptKeyExpired.calls().appendCalls).toBe(1);
  });

  it('allows expired-key historical verification only for exact replay lookup', async () => {
    const f = fixture();
    const result = await appendCapabilityShadowSignedEvent(f.input);
    const afterProducerExpiry = {
      verifiedAt: '2027-01-02T00:00:00.000Z',
      maxFutureSkewMs: 0,
    };
    const replayCapability = verifyCapabilityShadowAuthenticatedAppendRequestBytesForReplay(
      result!.requestBytes,
      f.producerRegistryBytes,
      sha256(f.producerRegistryBytes),
      {
        audience: 'meri-shadow-evidence', endpointId: 'primary',
        sinkRegistrySha256: sha256(f.sinkRegistryBytes),
      },
      afterProducerExpiry,
    );
    expect(replayCapability.requestDigest).toBe(result!.requestDigest);
    expect(() => verifyCapabilityShadowAuthenticatedAppendRequestBytes(
      result!.requestBytes,
      f.producerRegistryBytes,
      sha256(f.producerRegistryBytes),
      {
        audience: 'meri-shadow-evidence', endpointId: 'primary',
        sinkRegistrySha256: sha256(f.sinkRegistryBytes),
      },
      afterProducerExpiry,
    )).toThrow('authorization key');

    const currentCapability = verifyCapabilityShadowAuthenticatedAppendRequestBytes(
      result!.requestBytes,
      f.producerRegistryBytes,
      sha256(f.producerRegistryBytes),
      {
        audience: 'meri-shadow-evidence', endpointId: 'primary',
        sinkRegistrySha256: sha256(f.sinkRegistryBytes),
      },
      trustedTime,
    );
    expect(currentCapability.producerAuthorizationKeyNotAfter).toBe(window.notAfter);
    const replaySymbols = Object.getOwnPropertySymbols(replayCapability);
    const currentSymbols = Object.getOwnPropertySymbols(currentCapability);
    expect(replaySymbols).toHaveLength(1);
    expect(currentSymbols).toHaveLength(1);
    expect(replaySymbols[0]).not.toBe(currentSymbols[0]);
    expect(JSON.stringify(replayCapability)).not.toContain('replay_lookup_only');
    expect(JSON.stringify(currentCapability)).not.toContain('current_append_authorized');

    const replayTyped: VerifiedCapabilityShadowReplayLookupRequest = replayCapability;
    const currentTyped: VerifiedCapabilityShadowCurrentAppendAuthorizedRequest = currentCapability;
    expect(replayTyped.requestDigest).toBe(currentTyped.requestDigest);
    // @ts-expect-error replay-only proof is not new-append authority
    const notAppendAuthority: VerifiedCapabilityShadowCurrentAppendAuthorizedRequest = replayCapability;
    // @ts-expect-error current-append proof is not a historical lookup capability
    const notReplayAuthority: VerifiedCapabilityShadowReplayLookupRequest = currentCapability;
    expect(notAppendAuthority.requestDigest).toBe(notReplayAuthority.requestDigest);
  });

  it('rejects an unpinned or untrusted sink registry before protected producer signing', async () => {
    const f = fixture();
    await expect(appendCapabilityShadowSignedEvent({
      ...f.input,
      sink: { ...f.input.sink, expectedPublicRegistrySha256: sha256('wrong') },
    })).rejects.toThrow('sink registry SHA-256 pin mismatch');
    expect(f.calls()).toEqual({ producerSignCalls: 0, authorizationCalls: 0, appendCalls: 0 });

    const badRegistry = {
      ...f.sinkRegistry,
      keys: [{ ...f.sinkRegistry.keys[0]!, trustedSpkiSha256: sha256('untrusted') }],
    };
    const badRegistryBytes = Buffer.from(JSON.stringify(badRegistry), 'utf8');
    await expect(appendCapabilityShadowSignedEvent({
      ...f.input,
      sink: {
        ...f.input.sink,
        publicRegistryBytes: badRegistryBytes,
        expectedPublicRegistrySha256: sha256(badRegistryBytes),
      },
    })).rejects.toThrow('sink registry key fingerprint');
    expect(f.calls()).toEqual({ producerSignCalls: 0, authorizationCalls: 0, appendCalls: 0 });
  });

  it('refuses an in-flight lifecycle before authorization or append', async () => {
    const f = fixture();
    const attempted = {
      status: 'attempted' as const,
      attemptedAt: '2026-09-25T10:00:00.000Z',
      dispatchedAt: null,
      finishedAt: null,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    };
    await expect(appendCapabilityShadowSignedEvent({
      ...f.input,
      producer: {
        ...f.input.producer,
        observed: {
          ...f.input.producer.observed,
          route: {
            ...f.input.producer.observed.route,
            candidate: null,
            confidence: null,
            fallbackReason: 'no_result',
          },
          tools: { ...f.input.producer.observed.tools, candidateExposed: [] },
          execution: { ...f.input.producer.observed.execution, jev: attempted },
        },
      },
    })).rejects.toThrow('final lifecycle');
    expect(f.calls()).toEqual({ producerSignCalls: 1, authorizationCalls: 0, appendCalls: 0 });
  });

  it('rejects a receipt that does not bind the request or authenticate under the pinned sink key', async () => {
    const f = fixture();
    const validAppend = f.input.sink.append;
    await expect(appendCapabilityShadowSignedEvent({
      ...f.input,
      sink: {
        ...f.input.sink,
        append: async (requestBytes) => {
          const receipt = JSON.parse(Buffer.from(await validAppend(requestBytes)).toString('utf8')) as Record<string, unknown>;
          return Buffer.from(JSON.stringify({
            ...receipt,
            payload: {
              ...(receipt.payload as Record<string, unknown>),
              requestDigest: sha256('different-request'),
            },
          }), 'utf8');
        },
      },
    })).rejects.toThrow();

    const g = fixture();
    const gValidAppend = g.input.sink.append;
    await expect(appendCapabilityShadowSignedEvent({
      ...g.input,
      sink: {
        ...g.input.sink,
        append: async (requestBytes) => {
          const receipt = JSON.parse(Buffer.from(await gValidAppend(requestBytes)).toString('utf8')) as Record<string, unknown>;
          return Buffer.from(JSON.stringify({
            ...receipt,
            signatureBase64: Buffer.alloc(64, 0x7f).toString('base64'),
          }), 'utf8');
        },
      },
    })).rejects.toThrow('sink receipt signature');

    const h = fixture();
    const hValidAppend = h.input.sink.append;
    await expect(appendCapabilityShadowSignedEvent({
      ...h.input,
      sink: {
        ...h.input.sink,
        append: async (requestBytes) => Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          await hValidAppend(requestBytes),
        ]),
      },
    })).rejects.toThrow('UTF-8 BOM');
  });
});
