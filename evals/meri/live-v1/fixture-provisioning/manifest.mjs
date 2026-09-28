import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import contractLock from '../contract-lock.json' with { type: 'json' };
import { frozenFixture } from '../fixture.mjs';
import { sha256Stable } from '../lib/stable.mjs';
import { clientDocumentPhysicalId } from './canonical-owner-adapter.mjs';
import {
  AUTHORIZED_TENANTS,
  FIXTURE_NAMESPACE,
  FixtureProvisioningError,
  PROVISIONING_CONTRACT_VERSION,
  PROVISIONING_SCHEMA_VERSION,
  assertAuthorizedTenant,
  ownedIdentity,
} from './contract.mjs';

const ASSET_MANIFEST_URL = new URL('../source-binaries/asset-manifest.json', import.meta.url);
const ASSET_ROOT_URL = new URL('../source-binaries/', import.meta.url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const MEMORY_ITEM_KINDS = new Set([
  'institutional_memory',
  'memory_governance_receipt',
  'private_preference',
]);
const MEMORY_CANDIDATE_KINDS = new Set(['memory_candidate_fixture']);
const MEETING_KINDS = new Set(['meeting', 'meeting_media', 'legislative_event']);
const DEBRIEF_KINDS = new Set(['transcript']);
const RESEARCH_KINDS = new Set([
  'research_portfolio',
  'research_snapshot',
  'research_output',
  'research_event',
  'research_evidence',
  'durable_run_fixture',
]);
const BILL_KINDS = new Set(['bill_text', 'bill_status', 'amendment_status', 'report_passage']);
const BUDGET_KINDS = new Set([
  'budget_document',
  'house_report',
  'senate_committee_report',
  'enacted_appropriation',
  'program_element_identity',
  'project_identity',
  'budget_row',
  'complete_budget_index',
]);
const EXTERNAL_KINDS = new Set([
  'disposable_effect_sink',
  'search_snippet',
  'primary_public_page',
  'primary_public_notice',
  'untrusted_public_page',
  'stubbed_company_enrichment',
]);

const EXTENSION_RECORDS = Object.freeze([
  {
    logicalId: 'CD-M-OLDER',
    tenantId: 'T1',
    clientId: 'ASTER',
    owner: 'meeting',
    facts: { caseIds: ['CD-02', 'CD-03', 'CD-04', 'CD-07'], olderThanSevenDays: true },
  },
  {
    logicalId: 'CD-DEBRIEF-LATER',
    tenantId: 'T1',
    clientId: 'ASTER',
    owner: 'meeting_debrief',
    facts: { caseIds: ['CD-02', 'CD-07'], confirmsPromise: true },
  },
  {
    logicalId: 'CD-NATIVE-TASK-BEYOND-FIRST-PAGE',
    tenantId: 'T1',
    clientId: 'ASTER',
    owner: 'engagement_task',
    facts: { caseIds: ['CD-03'], paginationPosition: 'beyond_first_page' },
  },
  {
    logicalId: 'CD-SEPARATE-ACTION-SINK',
    tenantId: 'T1',
    clientId: 'ASTER',
    owner: 'controlled_action_adapter',
    facts: { caseIds: ['CD-05'], firstResponse: 'non_2xx', expectedLogicalEffects: 1 },
  },
  {
    logicalId: 'CD-MONDAY-AVAILABILITY',
    tenantId: 'T1',
    clientId: 'ASTER',
    owner: 'monday_test_adapter',
    facts: { caseIds: ['CD-02', 'CD-03', 'CD-04', 'CD-06', 'CD-07'] },
  },
  {
    logicalId: 'CD-MAIL-AVAILABILITY',
    tenantId: 'T1',
    clientId: 'ASTER',
    owner: 'mail_test_adapter',
    facts: { caseIds: ['CD-02', 'CD-03', 'CD-04', 'CD-07'] },
  },
  ...Array.from({ length: 8 }, (_, index) => ({
    logicalId: `CW-${String(index + 1).padStart(2, '0')}-FAULT-ADAPTER`,
    tenantId: 'T1',
    clientId: 'ASTER',
    owner: 'coworker_fault_adapter',
    facts: { caseIds: [`CW-${String(index + 1).padStart(2, '0')}`] },
  })),
]);

function canonicalOwner(logicalId, source) {
  if (MEMORY_ITEM_KINDS.has(source.kind)) return 'memory_item';
  if (MEMORY_CANDIDATE_KINDS.has(source.kind)) return 'memory_candidate';
  if (MEETING_KINDS.has(source.kind)) return 'meeting';
  if (DEBRIEF_KINDS.has(source.kind)) return 'meeting_debrief';
  if (RESEARCH_KINDS.has(source.kind)) return 'research_portfolio';
  if (BILL_KINDS.has(source.kind)) return 'federal_legislative_evidence';
  if (BUDGET_KINDS.has(source.kind)) return 'defense_budget_source';
  if (EXTERNAL_KINDS.has(source.kind)) return `${source.kind}_test_adapter`;
  if (source.kind === 'client_profile') return 'client';
  if (source.kind === 'client_facility_evidence') return 'client_facility';
  if (source.kind === 'business_development_record') return 'business_development_prospect';
  if (source.kind === 'program_record') return 'client_capability';
  if (source.kind === 'generated_artifact_fixture') return 'engagement_attachment';
  if (logicalId === 'MEETING-TRANSCRIPT-OWNERS') return 'meeting_debrief';
  return 'canonical_source_adapter';
}

function unavailableReason(owner) {
  if (owner.endsWith('_test_adapter') || owner === 'coworker_fault_adapter') {
    return 'explicit controlled test adapter is not configured; real provider credentials and network effects are forbidden';
  }
  if (owner === 'federal_legislative_evidence' || owner === 'defense_budget_source') {
    return 'shared global canonical source owner is read-only for this tenant fixture; bind reviewed existing evidence or a controlled test adapter';
  }
  if (owner === 'engagement_attachment') {
    return 'canonical ClientDocumentWriterService uploader and authoritative readback are not configured';
  }
  return `canonical owner ${owner} is not declared available`;
}

async function loadAssets(assetManifestUrl, assetRootUrl) {
  const manifest = JSON.parse(await readFile(assetManifestUrl, 'utf8'));
  if (manifest.fixtureVersion !== frozenFixture.version) {
    throw new FixtureProvisioningError(
      'ASSET_FIXTURE_VERSION_MISMATCH',
      'asset manifest fixture version mismatch',
    );
  }
  const assets = new Map();
  for (const asset of manifest.assets) {
    const bytes = await readFile(new URL(asset.filename, assetRootUrl));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== asset.byteSha256 || bytes.byteLength !== asset.byteSize) {
      throw new FixtureProvisioningError(
        'ASSET_BYTE_HASH_MISMATCH',
        `immutable source bytes do not match manifest for ${asset.logicalSourceId}`,
      );
    }
    assets.set(asset.logicalSourceId, {
      byteSha256: actual,
      byteSize: bytes.byteLength,
      fileName: asset.filename,
      mediaType: asset.mediaType,
      sourcePath: `source-binaries/${asset.filename}`,
      version: asset.version,
    });
  }
  return assets;
}

function availabilityFor(owner, availableOwners) {
  if (availableOwners.has(owner)) return { status: 'available', reason: null };
  return { status: 'unavailable', reason: unavailableReason(owner) };
}

function recordFor(input, options) {
  const tenant = options.tenants[input.tenantId];
  assertAuthorizedTenant(input.tenantId, tenant);
  const client = input.clientId ? options.clients[input.clientId] : null;
  const availability = availabilityFor(input.owner, options.availableOwners);
  let reason = availability.reason;
  let status = availability.status;
  if (
    input.clientId &&
    (!client || client.tenantId !== input.tenantId || !UUID.test(client.physicalId ?? ''))
  ) {
    status = 'unavailable';
    reason = `canonical client binding for ${input.clientId} is absent or crosses tenants`;
  }
  const baseIdentity = ownedIdentity(
    input.logicalId,
    tenant.id,
    input.owner,
    frozenFixture.version,
  );
  const writerActor = options.actors.PAT?.physicalId ?? options.actors.PAT?.userId ?? null;
  const assetByteSha256 = input.asset?.byteSha256 ?? input.facts?.byteSha256 ?? null;
  if (input.owner === 'engagement_attachment' && !writerActor) {
    status = 'unavailable';
    reason = 'canonical uploader actor binding is absent';
  }
  const identity =
    input.owner === 'engagement_attachment' && writerActor && assetByteSha256
      ? {
          ...baseIdentity,
          physicalId: clientDocumentPhysicalId({
            tenantId: tenant.id,
            userId: writerActor,
            clientId: client?.physicalId ?? null,
            idempotencyKey: `${FIXTURE_NAMESPACE}:${input.logicalId}`,
            contentType: input.asset?.mediaType ?? 'text/plain',
            byteSha256: assetByteSha256,
          }),
        }
      : baseIdentity;
  const payload = {
    facts: input.facts,
    fixtureKind: input.fixtureKind,
    sourceAsset: input.asset ?? null,
  };
  return {
    logicalId: input.logicalId,
    physicalId: identity.physicalId,
    tenantKey: input.tenantId,
    tenantId: tenant.id,
    clientLogicalId: input.clientId ?? null,
    clientPhysicalId: client?.physicalId ?? null,
    owner: input.owner,
    ownership: identity,
    expectedRowVersion: null,
    availability: { status, reason },
    payload,
    payloadSha256: sha256Stable(payload),
    references: input.clientId
      ? [
          {
            kind: 'client',
            logicalId: input.clientId,
            physicalId: client?.physicalId ?? null,
            tenantId: tenant.id,
          },
        ]
      : [],
  };
}

export async function buildFixtureManifest({
  tenants = AUTHORIZED_TENANTS,
  clients = {},
  actors = {},
  availableOwners = [],
  assetManifestUrl = ASSET_MANIFEST_URL,
  assetRootUrl = ASSET_ROOT_URL,
} = {}) {
  for (const [key, tenant] of Object.entries(tenants)) assertAuthorizedTenant(key, tenant);
  const ownerSet = new Set(availableOwners);
  const assets = await loadAssets(assetManifestUrl, assetRootUrl);
  const records = [];

  for (const [logicalId, source] of Object.entries(frozenFixture.sources)) {
    let asset = assets.get(logicalId) ?? null;
    if (
      !asset &&
      source.kind === 'generated_artifact_fixture' &&
      typeof source.facts?.utf8Bytes === 'string'
    ) {
      const bytes = Buffer.from(source.facts.utf8Bytes, 'utf8');
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== source.facts.byteSha256) {
        throw new FixtureProvisioningError(
          'ASSET_BYTE_HASH_MISMATCH',
          `inline generated bytes do not match fixture for ${logicalId}`,
        );
      }
      asset = {
        byteSha256: actual,
        byteSize: bytes.byteLength,
        fileName: source.facts.filename,
        mediaType: 'text/plain',
        sourcePath: null,
        version: 'v1',
      };
    }
    const owner = asset ? 'engagement_attachment' : canonicalOwner(logicalId, source);
    records.push(
      recordFor(
        {
          logicalId,
          tenantId: source.tenantId,
          clientId: source.clientId,
          owner,
          fixtureKind: source.kind,
          facts: source.facts,
          asset,
        },
        { tenants, clients, actors, availableOwners: ownerSet },
      ),
    );
  }
  for (const extension of EXTENSION_RECORDS) {
    records.push(
      recordFor(
        { ...extension, fixtureKind: 'acceptance_extension' },
        { tenants, clients, actors, availableOwners: ownerSet },
      ),
    );
  }

  records.sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  const sourceMap = {
    schemaVersion: PROVISIONING_SCHEMA_VERSION,
    contractVersion: PROVISIONING_CONTRACT_VERSION,
    fixtureNamespace: FIXTURE_NAMESPACE,
    fixtureVersion: frozenFixture.version,
    fixtureSha256: contractLock.fixtureSha256,
    contractSourceSha256: contractLock.contractSourceSha256,
    tenants,
    clients,
    actors,
    records,
  };
  return Object.freeze({ ...sourceMap, contentSha256: sha256Stable(sourceMap) });
}

export function assertManifest(manifest) {
  const { contentSha256, ...body } = manifest ?? {};
  if (
    body.fixtureNamespace !== FIXTURE_NAMESPACE ||
    body.fixtureVersion !== frozenFixture.version
  ) {
    throw new FixtureProvisioningError(
      'MANIFEST_FIXTURE_MISMATCH',
      'manifest is not bound to the frozen fixture',
    );
  }
  if (
    body.fixtureSha256 !== contractLock.fixtureSha256 ||
    body.contractSourceSha256 !== contractLock.contractSourceSha256
  ) {
    throw new FixtureProvisioningError(
      'MANIFEST_CONTRACT_MISMATCH',
      'manifest contract hashes are not current',
    );
  }
  if (contentSha256 !== sha256Stable(body)) {
    throw new FixtureProvisioningError('MANIFEST_HASH_MISMATCH', 'manifest content hash mismatch');
  }
  const byPhysicalId = new Map();
  for (const record of body.records ?? []) {
    assertAuthorizedTenant(record.tenantKey, body.tenants?.[record.tenantKey]);
    if (record.tenantId !== body.tenants[record.tenantKey].id) {
      throw new FixtureProvisioningError(
        'RECORD_TENANT_MISMATCH',
        `${record.logicalId} tenant binding mismatch`,
      );
    }
    if (record.payloadSha256 !== sha256Stable(record.payload)) {
      throw new FixtureProvisioningError(
        'RECORD_PAYLOAD_HASH_MISMATCH',
        `${record.logicalId} payload hash mismatch`,
      );
    }
    if (byPhysicalId.has(record.physicalId)) {
      throw new FixtureProvisioningError(
        'PHYSICAL_ID_COLLISION',
        `${record.logicalId} physical ID collision`,
      );
    }
    byPhysicalId.set(record.physicalId, record);
    for (const reference of record.references) {
      if (!UUID.test(reference.physicalId ?? '') || reference.tenantId !== record.tenantId) {
        throw new FixtureProvisioningError(
          'CROSS_CLIENT_REFERENCE',
          `${record.logicalId} has an absent or cross-tenant client reference`,
        );
      }
      const binding = body.clients?.[reference.logicalId];
      if (
        !binding ||
        binding.physicalId !== reference.physicalId ||
        binding.tenantId !== record.tenantKey
      ) {
        throw new FixtureProvisioningError(
          'CROSS_CLIENT_REFERENCE',
          `${record.logicalId} client reference does not match the source map`,
        );
      }
    }
  }
  return body;
}
