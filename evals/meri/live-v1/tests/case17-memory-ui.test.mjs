import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { selectPendingMemoryFixturePlan } from '../fixture-provisioning/memory-pending-fixture-plan.mjs';
import { fixtureRecordKey } from '../fixture-provisioning/contract.mjs';
import { inspectPendingUiPage } from '../case17-memory-ui.mjs';
import { sha256Stable } from '../lib/stable.mjs';

async function fixture() {
  const manifest = await buildFixtureManifest({
    fixtureInstanceId: randomUUID(),
    actors: {
      PAT: { tenantId: 'T1', physicalId: randomUUID() },
      PRIYA: { tenantId: 'T1', physicalId: randomUUID() },
    },
    clients: Object.fromEntries(
      ['ASTER', 'BLUEHAVEN', 'CEDAR'].map((key) => [
        key,
        { tenantId: key === 'CEDAR' ? 'T2' : 'T1', physicalId: randomUUID() },
      ]),
    ),
  });
  const selection = selectPendingMemoryFixturePlan(manifest, '17');
  const records = selection.records.map((record) => ({
    logicalSourceId: record.logicalId,
    physicalId: record.physicalId,
    tenantId: record.tenantId,
    proposerUserId: selection.proposerUserId,
    clientId: record.clientPhysicalId,
    scope:
      record.payload.facts.scope === 'private'
        ? 'personal'
        : record.clientPhysicalId
          ? 'client'
          : 'firm',
    status: 'pending',
    rowVersion: '42',
    payloadSha256: record.payloadSha256,
    ownershipMarkerSha256: record.ownership.markerSha256,
  }));
  const owner = {
    kind: 'meri-pending-memory-current-readback',
    caseId: '17',
    fixtureInstanceId: manifest.fixtureInstanceId,
    manifestContentSha256: manifest.contentSha256,
    ctx: { userId: selection.proposerUserId },
    records,
    currentVerifySha256: sha256Stable(records),
  };
  const rows = records.map((row) => ({
    id: row.physicalId,
    scope: row.scope,
    clientId: row.clientId,
    clientName: row.clientId ? 'Actual client' : null,
    status: 'pending',
    restricted: false,
    sourceKind: 'model_extraction',
    recordedSource: {
      sourceType: 'meri_synthetic_fixture',
      sourceId: row.ownershipMarkerSha256,
    },
    capabilities: { withdraw: true },
    proposal: {
      key: fixtureRecordKey(row.logicalSourceId, manifest.fixtureInstanceId),
      value: `Synthetic pending proposal ${row.logicalSourceId}`,
      canonicalItem: null,
    },
  }));
  return {
    selection,
    owner,
    pages: [
      { enabled: true, candidates: rows.slice(0, 3), nextCursor: 'real-next-cursor' },
      { enabled: true, candidates: rows.slice(3), nextCursor: null },
    ],
  };
}
it('joins all six actual physical source mappings across complete pages, without asserting acceptance', async () => {
  const f = await fixture(),
    result = inspectPendingUiPage(f);
  assert.equal(result.length, 6);
  assert.equal(result[5].scope, 'personal');
  assert.equal(result[0].recordedSource.sourceType, 'meri_synthetic_fixture');
  assert.equal(result[0].recordedSource.sourceId, f.selection.records[0].ownership.markerSha256);
  assert.equal(Object.hasOwn(result, 'verdict'), false);
});
it('rejects absent, unknown, malformed, swapped and duplicated API source references', async () => {
  const original = await fixture();
  const cases = [
    (f) => {
      delete f.pages[0].candidates[0].recordedSource;
    },
    (f) => {
      f.pages[0].candidates[0].recordedSource.sourceType = 'unknown_source';
    },
    (f) => {
      f.pages[0].candidates[0].recordedSource.sourceId = 'not-a-marker-hash';
    },
    (f) => {
      const first = f.pages[0].candidates[0].recordedSource.sourceId;
      f.pages[0].candidates[0].recordedSource.sourceId = f.pages[0].candidates[1].recordedSource.sourceId;
      f.pages[0].candidates[1].recordedSource.sourceId = first;
    },
    (f) => {
      f.pages[0].candidates[1].recordedSource.sourceId = f.pages[0].candidates[0].recordedSource.sourceId;
    },
    (f) => {
      f.pages[0].candidates[0].recordedSource.unexpected = 'duplicate reference field';
    },
  ];
  for (const alter of cases) {
    const f = structuredClone(original);
    alter(f);
    assert.throws(() => inspectPendingUiPage(f), /CASE17_UI_RECORDED_SOURCE_BINDING/u);
  }
});
it('rejects absent private proposal, duplicate pages, incomplete traversal, incorrect actor/version/provenance and non-actionable rows', async () => {
  const original = await fixture();
  for (const alter of [
    (f) => f.pages[1].candidates.pop(),
    (f) => f.pages.push(f.pages[1]),
    (f) => {
      f.pages[1].nextCursor = 'unread';
    },
    (f) => {
      f.owner.ctx.userId = randomUUID();
    },
    (f) => {
      f.owner.records[0].payloadSha256 = '0'.repeat(64);
    },
    (f) => {
      f.pages[0].candidates[0].id = randomUUID();
    },
    (f) => {
      f.pages[0].candidates[0].proposal.value = 'different fact';
    },
    (f) => {
      f.pages[0].candidates[0].restricted = true;
    },
    (f) => {
      f.pages[0].candidates[0].capabilities.withdraw = false;
    },
    (f) => {
      f.pages[0].candidates[0].sourceKind = 'different';
    },
  ]) {
    const f = structuredClone(original);
    alter(f);
    assert.throws(() => inspectPendingUiPage(f));
  }
});
