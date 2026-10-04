import { cases } from '../cases.mjs';
import { sha256Stable as sha256Evidence } from '../artifact-collector.mjs';
import { sha256Stable, stableJson } from '../lib/stable.mjs';
import { FIXTURE_NAMESPACE, FixtureProvisioningError } from './contract.mjs';
import { assertManifest } from './manifest.mjs';
import { selectedApprovedMemoryDefinitions } from './approved-memory-runtime.mjs';
import { expectedMemoryCandidatePayload } from './memory-candidate-owner.mjs';

const fail = (code) => {
  throw new FixtureProvisioningError(code, code);
};

/** Internal current-source owner, with canonical helpers supplied by API composition.
 * A seed inventory locates expected rows; it never proves their current authority.
 * This first slice intentionally cannot mark the full original case01 corpus ready.
 */
export function createMemoryCaptureBindingRuntime({
  manifest,
  seedInventory,
  proposerForTenant,
  assertSyntheticApprovedMemoryInTx,
  memoryAuthorization,
}) {
  manifest = structuredClone(manifest);
  assertManifest(manifest);
  seedInventory = structuredClone(seedInventory);
  if (
    typeof proposerForTenant !== 'function' ||
    typeof assertSyntheticApprovedMemoryInTx !== 'function' ||
    typeof memoryAuthorization?.loadItemInTx !== 'function' ||
    typeof memoryAuthorization?.evaluateInTx !== 'function'
  )
    fail('CAPTURE_MEMORY_OWNER_INCOMPLETE');
  if (
    seedInventory?.kind !== 'meri-approved-memory-local-bindings' ||
    seedInventory.fixtureMapSha256 !== manifest.contentSha256 ||
    !Array.isArray(seedInventory.bindings) ||
    seedInventory.bindingsSha256 !== sha256Stable(seedInventory.bindings)
  )
    fail('CAPTURE_MEMORY_SEED_INVENTORY_INVALID');
  const selected = seedInventory.bindings.map((value) => value.logicalId);
  if (new Set(selected).size !== selected.length) fail('CAPTURE_MEMORY_DUPLICATE_SOURCE');
  const definitions = new Map(
    selectedApprovedMemoryDefinitions(manifest, selected).map((value) => [value.logicalId, value]),
  );
  const case01 = cases.find((value) => value.id === '01');

  return Object.freeze({
    async qualifyInTx(tx, ctx, { caseId, clientId }) {
      if (caseId !== '01') fail('CAPTURE_MEMORY_CASE_UNSUPPORTED');
      const client = manifest.clients[case01.client];
      if (
        !client ||
        client.physicalId !== clientId ||
        manifest.tenants[client.tenantId]?.id !== ctx.tenantId
      )
        fail('CAPTURE_MEMORY_CLIENT_MISMATCH');
      const sourceMap = {},
        observations = [];
      const missing = [];
      for (const logicalId of case01.requiredSources) {
        const definition = definitions.get(logicalId),
          seeded = seedInventory.bindings.find((value) => value.logicalId === logicalId);
        if (!definition || !seeded) {
          missing.push(`SOURCE_OWNER_MISSING:${logicalId}`);
          continue;
        }
        const candidate = definition.candidate;
        if (
          seeded.tenantId !== ctx.tenantId ||
          candidate.tenantId !== ctx.tenantId ||
          seeded.clientId !== clientId ||
          candidate.clientPhysicalId !== clientId ||
          seeded.owner !== 'memory_item' ||
          seeded.lifecycle !== 'approved' ||
          seeded.candidateId !== candidate.physicalId ||
          seeded.ownershipMarkerSha256 !== candidate.ownership.markerSha256 ||
          seeded.candidatePayloadSha256 !== candidate.payloadSha256
        )
          fail('CAPTURE_MEMORY_SEED_BINDING_MISMATCH');
        const proposerId = await proposerForTenant(ctx.tenantId);
        const proposers = await tx.$queryRawUnsafe(
          `SELECT proposed_by::text FROM memory_candidate WHERE tenant_id=$1::uuid AND id=$2::uuid
           AND proposed_by=$3::uuid AND xmin::text=$4 FOR UPDATE`,
          ctx.tenantId,
          candidate.physicalId,
          proposerId,
          seeded.candidateRowVersion,
        );
        if (proposers.length !== 1) fail('CAPTURE_MEMORY_PROPOSER_OR_VERSION_CHANGED');
        const guard = {
          candidateId: candidate.physicalId,
          expectedRowVersion: seeded.candidateRowVersion,
          expectedItemRowVersion: seeded.itemRowVersion,
          expectedPayload: expectedMemoryCandidatePayload(
            candidate,
            proposerId,
            stableJson({ ownership: candidate.ownership, payload: candidate.payload }),
          ),
        };
        const ownership = await assertSyntheticApprovedMemoryInTx(
          tx,
          ctx,
          seeded.physicalId,
          guard,
        );
        const subject = await memoryAuthorization.loadItemInTx(tx, ctx.tenantId, seeded.physicalId);
        if (
          !subject ||
          !(
            await memoryAuthorization.evaluateInTx(tx, ctx, subject, 'read', {
              emitDenialMetrics: false,
            })
          ).allowed
        )
          fail('CAPTURE_MEMORY_CURRENT_READ_DENIED');
        const actual = await tx.$queryRawUnsafe(
          `SELECT id::text,source_version,source_content_hash,sections_jsonb,xmin::text AS row_version
           FROM memory_items WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          ctx.tenantId,
          seeded.physicalId,
        );
        const item = actual[0];
        if (
          actual.length !== 1 ||
          item.row_version !== seeded.itemRowVersion ||
          typeof item.source_version !== 'string' ||
          !item.source_version ||
          typeof item.source_content_hash !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(item.source_content_hash)
        )
          fail('CAPTURE_MEMORY_SOURCE_VERSION_MISSING');
        sourceMap[logicalId] = {
          frozenFixtureId: logicalId,
          physicalId: item.id,
          tenantPhysicalId: ctx.tenantId,
          clientPhysicalId: clientId,
          kind: 'memory',
          version: item.source_version,
        };
        observations.push({
          logicalId,
          physicalId: item.id,
          candidateId: candidate.physicalId,
          candidateRowVersion: ownership.syntheticFixtureCandidateRowVersion,
          itemRowVersion: item.row_version,
          sourceVersion: item.source_version,
          sourceContentSha256: item.source_content_hash,
          sectionsSha256: sha256Evidence(item.sections_jsonb),
          ownershipMarkerSha256: candidate.ownership.markerSha256,
        });
      }
      // A positive memory is not proof of superseded/pending/revoked/other-client
      // fixture state, historical reset, or a canonical seeding operation receipt.
      missing.push(
        ...case01.forbiddenSources.map((id) => `NEGATIVE_CORPUS_OWNER_MISSING:${id}`),
        'CANONICAL_SEED_RECEIPT_OWNER_MISSING',
        'CANONICAL_RESET_RECEIPT_OWNER_MISSING',
      );
      const currentVerify = {
        kind: 'meri-capture-memory-current-verification',
        fixtureNamespace: FIXTURE_NAMESPACE,
        fixtureVersion: manifest.fixtureVersion,
        fixtureInstanceId: manifest.fixtureInstanceId ?? null,
        manifestContentSha256: manifest.contentSha256,
        seedInventorySha256: seedInventory.bindingsSha256,
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        clientId,
        caseId,
        observations,
      };
      return {
        fixtureReady: false,
        missing,
        liveAcceptance: 'NOT_RUN',
        fixtureNamespace: FIXTURE_NAMESPACE,
        fixtureVersion: manifest.fixtureVersion,
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        clientId,
        caseId,
        sourceMap,
        physicalMapSha256: sha256Evidence(sourceMap),
        currentVerify,
        currentVerifySha256: sha256Evidence(currentVerify),
        seedReceiptId: null,
        resetReceiptId: null,
      };
    },
  });
}
