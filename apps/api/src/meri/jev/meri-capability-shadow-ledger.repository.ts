import {
  capabilityShadowLedgerEntryDigest,
  verifyCapabilityShadowAuthenticatedAppendRequestBytes,
  verifyCapabilityShadowAuthenticatedAppendRequestBytesForReplay,
  type CapabilityShadowAuthenticatedAppendRequest,
  type CapabilityShadowTrustedTime,
  type VerifiedCapabilityShadowCurrentAppendAuthorizedRequest,
  type VerifiedCapabilityShadowReplayLookupRequest,
} from '@capiro/meriv2-core';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_SAFE_LEDGER_SEQUENCE = 9_007_199_254_740_991n;
const MAX_TRUSTED_PROCESSING_WINDOW_MS = 5 * 60 * 1000;

type AppendRow = {
  disposition: 'appended' | 'replayed';
  audience: string;
  endpoint_id: string;
  sequence: bigint;
  previous_entry_digest: string | null;
  appended_at: Date;
  request_digest: string;
  event_id: string;
  idempotency_key: string;
  event_payload_digest: string;
  ledger_entry_digest: string;
};

export interface CapabilityShadowTrustedProcessingWindow {
  /** Independently observed trusted processing start, inclusive. */
  notBefore: string;
  /** Independently observed trusted processing end, exclusive. */
  notAfter: string;
}

export interface CapabilityShadowLedgerAppendInput {
  /** Authenticated sink tenant context; never copied into a public receipt. */
  tenantId: string;
  /**
   * Pseudonym independently authorized for tenantId by the eventual sink
   * service. Passing the hash copied from the request is not authorization.
   */
  authorizedTenantPseudonymHash: string;
  exactCanonicalRequestBytes: Uint8Array;
  producerRegistryBytes: Uint8Array;
  expectedProducerRegistrySha256: string;
  expectedSink: {
    audience: string;
    endpointId: string;
    sinkRegistrySha256: string;
  };
  trustedTime: CapabilityShadowTrustedTime;
  /** Separate from event future-skew policy; bounds database processing time. */
  trustedProcessingWindow: CapabilityShadowTrustedProcessingWindow;
}

export interface CapabilityShadowLedgerEntryV1 {
  sequence: number;
  previousEntryDigest: string | null;
  appendedAt: string;
  requestDigest: string;
  eventId: string;
  idempotencyKey: string;
  eventPayloadDigest: string;
  ledgerEntryDigest: string;
}

export interface CapabilityShadowLedgerAppendResult {
  disposition: 'appended' | 'replayed';
  request: CapabilityShadowAuthenticatedAppendRequest;
  requestDigest: string;
  entry: CapabilityShadowLedgerEntryV1;
}

/**
 * The append call may have committed. The only safe automated response is an
 * identical-byte retry through historical lookup; never mint a replacement.
 */
export class CapabilityShadowAppendCommitUnconfirmedError extends Error {
  constructor(cause: unknown) {
    super('capability-shadow append outcome or returned integrity is unconfirmed; retry only the identical canonical request');
    this.name = 'CapabilityShadowAppendCommitUnconfirmedError';
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export class CapabilityShadowReplayLookupUnconfirmedError extends Error {
  constructor(cause: unknown) {
    super('capability-shadow historical lookup is unconfirmed; retry only the identical canonical request');
    this.name = 'CapabilityShadowReplayLookupUnconfirmedError';
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export class CapabilityShadowLedgerIntegrityError extends Error {
  constructor(cause: unknown) {
    super('capability-shadow immutable ledger integrity alarm; do not append replacement bytes');
    this.name = 'CapabilityShadowLedgerIntegrityError';
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export class CapabilityShadowAppendRejectedError extends Error {
  constructor(cause: unknown) {
    super('capability-shadow append was rejected by the database authority');
    this.name = 'CapabilityShadowAppendRejectedError';
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

function isConfirmedDatabaseRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const confirmed = [
    'capability-shadow append tenant context mismatch',
    'capability-shadow append identity is malformed',
    'capability-shadow idempotency key reused',
    'capability-shadow JavaScript-safe ledger sequence exhausted',
    'capability-shadow original append predates its signed event',
    'capability-shadow database append time predates the signed event',
    'capability-shadow database clock is outside the trusted processing window',
  ];
  return confirmed.some((fragment) => message.includes(fragment))
    || message.includes('meri_capability_shadow_ledger_idempotency_key');
}

function validateProcessingWindow(
  input: CapabilityShadowTrustedProcessingWindow,
  trustedTime: CapabilityShadowTrustedTime,
): CapabilityShadowTrustedProcessingWindow {
  const notBefore = Date.parse(input.notBefore);
  const notAfter = Date.parse(input.notAfter);
  const verifiedAt = Date.parse(trustedTime.verifiedAt);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)
    || !Number.isFinite(verifiedAt) || notBefore >= notAfter
    || new Date(notBefore).toISOString() !== input.notBefore
    || new Date(notAfter).toISOString() !== input.notAfter
    || notAfter - notBefore > MAX_TRUSTED_PROCESSING_WINDOW_MS
    || verifiedAt < notBefore || verifiedAt >= notAfter) {
    throw new Error('capability-shadow trusted processing window is invalid');
  }
  return {
    notBefore: new Date(notBefore).toISOString(),
    notAfter: new Date(notAfter).toISOString(),
  };
}

function assertExactRowIdentity(
  row: AppendRow,
  verified: {
    request: CapabilityShadowAuthenticatedAppendRequest;
    requestDigest: string;
  },
): void {
  const event = verified.request.payload.envelope.payload.event;
  if (row.audience !== verified.request.payload.audience
    || row.endpoint_id !== verified.request.payload.endpointId
    || row.request_digest !== verified.requestDigest
    || row.event_id !== event.eventId
    || row.idempotency_key !== verified.request.payload.idempotencyKey
    || row.event_payload_digest !== verified.request.payload.eventPayloadDigest) {
    throw new CapabilityShadowAppendRejectedError(
      new Error('idempotency key is already bound to different authenticated request bytes'),
    );
  }
}

function verifiedEntryFromRow(row: AppendRow): CapabilityShadowLedgerEntryV1 {
  if ((row.disposition !== 'appended' && row.disposition !== 'replayed')
    || !(row.appended_at instanceof Date)
    || !Number.isFinite(row.appended_at.getTime())
    || row.sequence < 1n
    || row.sequence > MAX_SAFE_LEDGER_SEQUENCE) {
    throw new Error('capability-shadow ledger returned a malformed entry');
  }
  const entry: CapabilityShadowLedgerEntryV1 = {
    sequence: Number(row.sequence),
    previousEntryDigest: row.previous_entry_digest,
    appendedAt: row.appended_at.toISOString(),
    requestDigest: row.request_digest,
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    eventPayloadDigest: row.event_payload_digest,
    ledgerEntryDigest: row.ledger_entry_digest,
  };
  if (capabilityShadowLedgerEntryDigest(entry) !== entry.ledgerEntryDigest) {
    throw new Error('capability-shadow database entry digest is invalid');
  }
  return entry;
}

/**
 * Dormant source-only protocol. It is not registered in Nest and the migration
 * grants neither lookup nor append to capiro_app. Activation requires a
 * dedicated non-login/non-BYPASS sink service identity and a database-enforced
 * authenticated tenant mapping in a later reviewed migration.
 */
export class MeriCapabilityShadowLedgerRepository {
  constructor(private readonly prisma: PrismaService) {}

  private lookupExisting(
    input: CapabilityShadowLedgerAppendInput,
    processing: CapabilityShadowTrustedProcessingWindow,
    replayCapability: VerifiedCapabilityShadowReplayLookupRequest,
  ): Promise<AppendRow[]> {
    return this.prisma.withTenant(input.tenantId, (tx) =>
      tx.$queryRaw<AppendRow[]>(Prisma.sql`
        SELECT * FROM lookup_meri_capability_shadow_entry_v1(
          ${input.tenantId}::uuid,
          ${replayCapability.request.payload.audience}::text,
          ${replayCapability.request.payload.endpointId}::text,
          ${replayCapability.request.payload.idempotencyKey}::text,
          ${processing.notBefore}::timestamptz,
          ${processing.notAfter}::timestamptz
        )
      `),
    );
  }

  private appendCurrentAuthorized(
    input: CapabilityShadowLedgerAppendInput,
    processing: CapabilityShadowTrustedProcessingWindow,
    appendCapability: VerifiedCapabilityShadowCurrentAppendAuthorizedRequest,
  ): Promise<AppendRow[]> {
    const event = appendCapability.request.payload.envelope.payload.event;
    return this.prisma.withTenant(input.tenantId, (tx) =>
      tx.$queryRaw<AppendRow[]>(Prisma.sql`
        SELECT * FROM append_meri_capability_shadow_entry_v1(
          ${input.tenantId}::uuid,
          ${appendCapability.request.payload.audience}::text,
          ${appendCapability.request.payload.endpointId}::text,
          ${appendCapability.requestDigest}::text,
          ${event.eventId}::text,
          ${appendCapability.request.payload.idempotencyKey}::text,
          ${appendCapability.request.payload.eventPayloadDigest}::text,
          ${event.tenantPseudonymHash}::text,
          ${appendCapability.request.payload.producerRegistrySha256}::text,
          ${appendCapability.request.payload.sinkRegistrySha256}::text,
          ${event.occurredAt}::timestamptz,
          ${processing.notBefore}::timestamptz,
          ${processing.notAfter}::timestamptz
        )
      `),
    );
  }

  async append(
    input: CapabilityShadowLedgerAppendInput,
  ): Promise<CapabilityShadowLedgerAppendResult> {
    if (!UUID.test(input.tenantId)
      || !SHA256.test(input.authorizedTenantPseudonymHash)) {
      throw new Error('capability-shadow tenant authorization context is malformed');
    }
    const processing = validateProcessingWindow(
      input.trustedProcessingWindow,
      input.trustedTime,
    );

    // Historical verification authenticates exact old bytes at event time. It
    // is intentionally sufficient only for immutable lookup, never insertion.
    const historical = verifyCapabilityShadowAuthenticatedAppendRequestBytesForReplay(
      input.exactCanonicalRequestBytes,
      input.producerRegistryBytes,
      input.expectedProducerRegistrySha256,
      input.expectedSink,
      input.trustedTime,
    );
    const historicalEvent = historical.request.payload.envelope.payload.event;
    if (historicalEvent.tenantPseudonymHash !== input.authorizedTenantPseudonymHash) {
      throw new Error('capability-shadow request is not authorized for the tenant context');
    }

    let existing: AppendRow[];
    try {
      existing = await this.lookupExisting(input, processing, historical);
    } catch (error) {
      throw new CapabilityShadowReplayLookupUnconfirmedError(error);
    }
    if (existing.length > 1) {
      throw new CapabilityShadowLedgerIntegrityError(
        new Error('historical lookup returned multiple immutable entries'),
      );
    }
    if (existing.length === 1) {
      const row = existing[0]!;
      assertExactRowIdentity(row, historical);
      try {
        return {
          disposition: 'replayed',
          request: historical.request,
          requestDigest: historical.requestDigest,
          entry: verifiedEntryFromRow(row),
        };
      } catch (error) {
        throw new CapabilityShadowLedgerIntegrityError(error);
      }
    }

    // Absence is not append authority. Reverify the same bytes under a producer
    // key that is valid now before entering the only mutation path.
    const current = verifyCapabilityShadowAuthenticatedAppendRequestBytes(
      input.exactCanonicalRequestBytes,
      input.producerRegistryBytes,
      input.expectedProducerRegistrySha256,
      input.expectedSink,
      input.trustedTime,
    );
    if (current.requestDigest !== historical.requestDigest) {
      throw new CapabilityShadowLedgerIntegrityError(
        new Error('historical and current verification digests differ'),
      );
    }
    if (Date.parse(processing.notAfter)
      > Date.parse(current.producerAuthorizationKeyNotAfter)) {
      throw new CapabilityShadowAppendRejectedError(
        new Error('trusted processing window extends beyond producer authorization key expiry'),
      );
    }

    // From this call onward, any error may follow a successful commit. Keep the
    // query and every row/integrity assertion inside the ambiguity wrapper.
    try {
      const rows = await this.appendCurrentAuthorized(input, processing, current);
      if (rows.length !== 1) {
        throw new Error('append function did not return exactly one immutable entry');
      }
      const row = rows[0]!;
      assertExactRowIdentity(row, current);
      return {
        disposition: row.disposition,
        request: current.request,
        requestDigest: current.requestDigest,
        entry: verifiedEntryFromRow(row),
      };
    } catch (error) {
      if (isConfirmedDatabaseRejection(error)) {
        throw new CapabilityShadowAppendRejectedError(error);
      }
      throw new CapabilityShadowAppendCommitUnconfirmedError(error);
    }
  }
}
