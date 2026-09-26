import type {
  AcquisitionIdentity,
  AcquisitionIdentityInput,
  AcquisitionIdentityResult,
  AcquisitionRecordKind,
  AcquisitionRelationshipInput,
  AcquisitionRelationshipResult,
} from './acquisition-continuity.types.js';

function nonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function encode(parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join('|');
}

function providerId(input: AcquisitionIdentityInput): string | null {
  return (
    nonEmpty(input.sourceRecordId) ??
    nonEmpty(input.noticeId) ??
    nonEmpty(input.solicitationId) ??
    nonEmpty(input.vehicleId) ??
    nonEmpty(input.orderId) ??
    nonEmpty(input.modificationId)
  );
}

function identity(
  input: AcquisitionIdentityInput,
  authority: AcquisitionIdentity['authority'],
  parts: string[],
): AcquisitionIdentityResult {
  const source = input.source.trim().toLowerCase();
  return {
    ok: true,
    identity: {
      source,
      recordKind: input.recordKind,
      key: encode([source, input.recordKind, ...parts]),
      authority,
      parentIdentityKey: nonEmpty(input.parentIdentityKey),
    },
  };
}

/**
 * Construct a deterministic identity from a source-authoritative key.
 * PIID is intentionally never accepted by itself: it is only a component of a
 * composite identity that also contains source and parent award identity.
 */
export function buildAcquisitionIdentity(input: AcquisitionIdentityInput): AcquisitionIdentityResult {
  const source = nonEmpty(input.source);
  if (!source) return { ok: false, reason: 'source is required' };

  if (input.recordKind === 'award' && source.toLowerCase() === 'usaspending') {
    const generatedAwardId = nonEmpty(input.generatedAwardId);
    if (generatedAwardId) {
      return identity(input, 'usaspending_generated_award_id', [generatedAwardId]);
    }
  }

  if (input.recordKind === 'modification') {
    const transactionId = nonEmpty(input.transactionId) ?? nonEmpty(input.modificationId);
    if (transactionId) return identity(input, 'source_transaction_id', [transactionId]);
  }

  const explicitId = providerId(input);
  if (explicitId) return identity(input, 'source_record_id', [explicitId]);

  const parentAwardId = nonEmpty(input.parentAwardId);
  const piid = nonEmpty(input.piid);
  if (parentAwardId && piid && input.recordKind !== 'notice' && input.recordKind !== 'vehicle') {
    if (input.recordKind === 'modification') {
      const modificationNumber = nonEmpty(input.modificationNumber);
      if (!modificationNumber) {
        return {
          ok: false,
          reason: 'modification requires a source transaction ID or parent award ID + PIID + modification number',
        };
      }
      return identity(input, 'parent_piid_modification', [parentAwardId, piid, modificationNumber]);
    }
    return identity(input, 'parent_award_and_piid', [parentAwardId, piid]);
  }

  if (piid) return { ok: false, reason: 'PIID alone is not an authoritative acquisition identity' };
  return {
    ok: false,
    reason: `${input.recordKind} requires a source record ID${input.recordKind === 'modification' ? ' or a complete parent award + PIID + modification composite' : ''}`,
  };
}

export function acquisitionRecordKinds(): readonly AcquisitionRecordKind[] {
  return ['notice', 'solicitation', 'vehicle', 'order', 'award', 'modification'];
}

const FINANCIAL_RELATIONSHIPS = new Set([
  'source_stated_financial_allocation',
  'deterministic_financial_allocation',
]);

function validDate(value: string | null | undefined): boolean {
  return value == null || (value.trim().length > 0 && Number.isFinite(Date.parse(value)));
}

/** Validate the financial and unresolved-state boundaries for one acquisition edge. */
export function buildAcquisitionRelationship(
  input: AcquisitionRelationshipInput,
): AcquisitionRelationshipResult {
  const required = [input.source, input.sourceRecordId, input.fromIdentityKey, input.toIdentityKey];
  if (required.some((value) => !nonEmpty(value))) {
    return { ok: false, reason: 'source, sourceRecordId, fromIdentityKey, and toIdentityKey are required' };
  }
  if (!validDate(input.validFrom) || !validDate(input.validTo)) {
    return { ok: false, reason: 'relationship validity dates must be parseable dates' };
  }
  if (input.validFrom && input.validTo && Date.parse(input.validFrom) > Date.parse(input.validTo)) {
    return { ok: false, reason: 'validFrom must be on or before validTo' };
  }

  const financial = FINANCIAL_RELATIONSHIPS.has(input.relationshipClass);
  const allocatedAmountUsd = nonEmpty(input.allocatedAmountUsd);
  if (allocatedAmountUsd && !financial) {
    return { ok: false, reason: `${input.relationshipClass} cannot carry allocated dollars` };
  }
  if (allocatedAmountUsd && !/^-?\d+(\.\d+)?$/.test(allocatedAmountUsd)) {
    return { ok: false, reason: 'allocatedAmountUsd must be a decimal string' };
  }
  if (input.relationshipClass === 'unresolved') {
    if (!nonEmpty(input.unresolvedReason)) {
      return { ok: false, reason: 'unresolved relationships require a reason' };
    }
    if (!input.sourceFreshness || !input.coverage) {
      return { ok: false, reason: 'unresolved relationships require source freshness and coverage' };
    }
    if (!input.coverage.note.trim()) {
      return { ok: false, reason: 'unresolved relationships require a coverage note' };
    }
  }

  const canonical = [
    input.source.trim(),
    input.sourceRecordId.trim(),
    input.fromIdentityKey.trim(),
    input.toIdentityKey.trim(),
    input.relationshipClass,
    input.validFrom ?? '',
    input.validTo ?? '',
  ];
  return {
    ok: true,
    relationship: {
      ...input,
      key: encode(canonical),
      evidenceReference: nonEmpty(input.evidenceReference),
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      allocatedAmountUsd,
      unresolvedReason: nonEmpty(input.unresolvedReason),
    },
  };
}
