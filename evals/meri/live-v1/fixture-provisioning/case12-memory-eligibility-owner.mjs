import { createCase12MemoryInventoryOwner } from './case12-memory-inventory-owner.mjs';
import { sha256Stable } from '../lib/stable.mjs';

/** Internal transaction-bound source composition, never a JSON capture capability. */
export function createCase12MemoryEligibilityOwner({
  readCase12CanonicalEligibilityInTx,
  ...inventoryDependencies
}) {
  if (typeof readCase12CanonicalEligibilityInTx !== 'function')
    throw new Error('CASE12_CANONICAL_ELIGIBILITY_OWNER_REQUIRED');
  const inventory = createCase12MemoryInventoryOwner(inventoryDependencies);
  return Object.freeze({
    async inspectInTx(tx, suppliedContext, suppliedRequest) {
      const ctx = structuredClone(suppliedContext),
        request = structuredClone(suppliedRequest);
      const current = await inventory.inspectInTx(tx, ctx, request);
      if (!current.inventoryVerified) return current;
      const target = current.observations.find((row) => row.logicalId === 'MA510');
      const native = await readCase12CanonicalEligibilityInTx(tx, ctx, {
        clientId: current.clientId,
        targetItemId: target.physicalId,
        inventoryItemIds: current.observations.map((row) => row.physicalId),
      });
      if (
        native?.kind !== 'case12-current-canonical-retrieval-eligibility' ||
        native.tenantId !== current.tenantId ||
        native.actorUserId !== current.actorUserId ||
        native.clientId !== current.clientId ||
        native.targetItemId !== target.physicalId ||
        native.comparisonClock !== 'CURRENT_DATABASE_AND_PROCESS_CLOCK' ||
        native.semanticClockQualified !== false ||
        !Array.isArray(native.observations)
      )
        throw new Error('CASE12_CANONICAL_ELIGIBILITY_SCOPE_MISMATCH');
      const clock = native.observation;
      const timestamps = [
        'databaseTransactionStartedAt',
        'databaseObservedAt',
        'processStartedAt',
        'processCompletedAt',
      ];
      if (
        !clock ||
        !/^\d+:\d+:(?:\d+(?:,\d+)*)?$/u.test(clock.databaseSnapshot ?? '') ||
        timestamps.some(
          (key) => typeof clock[key] !== 'string' || !Number.isFinite(Date.parse(clock[key])),
        ) ||
        Date.parse(clock.databaseTransactionStartedAt) > Date.parse(clock.databaseObservedAt) ||
        Date.parse(clock.processStartedAt) > Date.parse(clock.processCompletedAt)
      )
        throw new Error('CASE12_CANONICAL_ELIGIBILITY_OBSERVATION_MISSING');
      const known = new Map(current.observations.map((row) => [row.physicalId, row])),
        seen = new Set();
      let newerEligible = 0;
      for (const row of native.observations) {
        const expected = known.get(row.physicalId);
        if (
          !expected ||
          seen.has(row.physicalId) ||
          row.tenantId !== expected.tenantId ||
          row.clientId !== expected.clientId ||
          row.itemRowVersion !== expected.itemRowVersion ||
          row.sourceVersion !== expected.sourceVersion ||
          row.sourceContentSha256 !== expected.sourceContentSha256 ||
          typeof row.newerThanTarget !== 'boolean' ||
          (row.physicalId === target.physicalId && row.newerThanTarget)
        )
          throw new Error('CASE12_CANONICAL_ELIGIBILITY_JOIN_MISMATCH');
        seen.add(row.physicalId);
        if (row.newerThanTarget) newerEligible++;
      }
      if (!seen.has(target.physicalId) || newerEligible < 500)
        throw new Error('CASE12_OLDER_THAN_500_CURRENT_ELIGIBLE_ROWS_NOT_VERIFIED');
      return {
        ...current,
        retrievalEligibility: 'CURRENT_CANONICAL_SOURCE_QUALIFIED',
        olderThan500CurrentEligibleRowsVerified: true,
        newerCurrentEligibleRecordCount: newerEligible,
        currentEligibility: native,
        currentEligibilitySha256: sha256Stable(native),
        missing: [
          'CASE12_SEMANTIC_CLOCK_NOT_QUALIFIED',
          'CASE12_CAPTURE_AND_LIVE_ACCEPTANCE_NOT_RUN',
        ],
        fixtureReady: false,
        captureAuthority: false,
        liveAcceptance: 'NOT_RUN',
      };
    },
  });
}
