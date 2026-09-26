import type { HermesCreateRunInput } from './meri-hermes-runtime.client.js';
import {
  createMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
  type MeriDispatchRequestMetadataV2,
  type MeriDispatchSourceMessageMaterialV2,
} from './meri-hermes-dispatch-intent.contract.js';

/** Fields whose insertion order is part of the pinned v2 identity request. */
const RESERVED_BODY_FIELDS = new Set([
  'input',
  'session_id',
  'instructions',
  'model',
  'provider',
  'model_options',
]);

export interface MeriHermesExactDispatchMaterialV2 {
  input: Readonly<HermesCreateRunInput>;
  metadata: Readonly<MeriDispatchRequestMetadataV2>;
  sourceMessage: Readonly<MeriDispatchSourceMessageMaterialV2>;
  sessionHeaderHmacKey: Uint8Array;
  /**
   * Future request-local extensions such as the signed tool-view token. A key
   * may not replace a base Hermes field. Values must be JSON-serializable.
   */
  extraBody?: Readonly<Record<string, unknown>>;
}

/**
 * A build-once, content-bearing request capsule.
 *
 * The private Buffer is the sole serialization of the outbound JSON. It is
 * never returned directly: callers receive byte-for-byte copies, so neither a
 * persistence callback nor a transport can mutate the authoritative bytes.
 * The identity was computed from that private Buffer. Retrying must reuse this
 * capsule; rebuilding from the input object is forbidden because the object or
 * JSON serialization behavior may have changed.
 *
 * This class does not authorize or perform a dispatch. It intentionally has no
 * fetch dependency and is not wired into the active runtime client.
 */
export class MeriHermesExactDispatchRequestV2 {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  readonly sessionKeyHeaderValue: string;
  readonly sessionId: string | null;
  readonly idempotencyKey: string;
  readonly contentType = 'application/json' as const;
  readonly method = 'POST' as const;
  readonly path = '/v1/runs' as const;

  readonly #bodyBytes: Buffer;

  private constructor(
    bodyBytes: Buffer,
    identity: MeriDispatchRequestIdentityV2,
    sessionKeyHeaderValue: string,
    sessionId: string | null,
    idempotencyKey: string,
  ) {
    this.#bodyBytes = bodyBytes;
    this.identity = identity;
    this.sessionKeyHeaderValue = sessionKeyHeaderValue;
    this.sessionId = sessionId;
    this.idempotencyKey = idempotencyKey;
    Object.freeze(this);
  }

  static build(material: MeriHermesExactDispatchMaterialV2): MeriHermesExactDispatchRequestV2 {
    const { input, metadata } = material;
    if (!input || typeof input !== 'object' || typeof input.input !== 'string') {
      throw new Error('Hermes dispatch input must contain a string input');
    }
    if (typeof input.sessionKey !== 'string' || input.sessionKey.length === 0) {
      throw new Error('Phase 4 exact dispatch requires a session key');
    }
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0 ||
        input.idempotencyKey !== metadata.idempotencyKey) {
      throw new Error('Phase 4 exact dispatch idempotency key must match its metadata');
    }
    const extra = material.extraBody ?? {};
    for (const key of Object.keys(extra)) {
      if (!/^[a-z][a-z0-9_]*$/.test(key)) {
        throw new Error(`Hermes dispatch extension has an invalid key '${key}'`);
      }
      if (RESERVED_BODY_FIELDS.has(key)) {
        throw new Error(`Hermes dispatch extension may not replace '${key}'`);
      }
    }

    // Keep this order synchronized with MeriHermesRuntimeClient.createRunBody.
    // Serialize exactly once; a toJSON hook or a later mutation cannot alter a
    // retry because neither the source object nor a reconstructed object is
    // consulted again.
    const body: Record<string, unknown> = { input: input.input, ...extra };
    if (input.sessionId) body.session_id = input.sessionId;
    if (input.instructions) body.instructions = input.instructions;
    if (input.model) body.model = input.model;
    if (input.provider) body.provider = input.provider;
    if (input.modelOptions) body.model_options = input.modelOptions;
    const serialized = JSON.stringify(body);
    if (typeof serialized !== 'string' || serialized.length === 0) {
      throw new Error('Hermes dispatch body is not JSON-serializable');
    }
    const bodyBytes = Buffer.from(serialized, 'utf8');
    const identity = createMeriDispatchRequestIdentityV2({
      metadata: { ...metadata },
      sourceMessage: {
        body: material.sourceMessage.body,
        metadata: material.sourceMessage.metadata,
      },
      bodyBytes,
      sessionKeyHeaderValue: input.sessionKey,
      sessionHeaderHmacKey: Uint8Array.from(material.sessionHeaderHmacKey),
    });
    return new MeriHermesExactDispatchRequestV2(
      bodyBytes,
      identity,
      input.sessionKey,
      input.sessionId || null,
      input.idempotencyKey,
    );
  }

  /** A defensive copy of the one authoritative serialization. */
  copyExactBodyBytes(): Uint8Array {
    return Uint8Array.from(this.#bodyBytes);
  }

  /**
   * Supplies a defensive copy to a future transport. The callback receiving
   * the bytes is not a claim or launch grant; runtime wiring must first observe
   * a newly committed worker-side claim.
   */
  async withExactBodyCopy<T>(send: (body: Uint8Array) => Promise<T>): Promise<T> {
    return send(this.copyExactBodyBytes());
  }
}
