import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { selectPendingMemoryFixturePlan } from '../fixture-provisioning/memory-pending-fixture-plan.mjs';
import { fixtureRecordKey } from '../fixture-provisioning/contract.mjs';
import { inspectCase17SavedEvidence } from '../case17-saved-checks.mjs';
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

async function evidence() {
  const f = await fixture();
  const rounds = ['initial', 'afterReload'].map((phase, index) => {
    const pages = structuredClone(f.pages);
    if (index === 1) {
      pages[0].candidates.reverse();
      pages[1].candidates.reverse();
    }
    for (const page of pages) page.fixtureEvidence = f.owner;
    return {
      phase,
      pages,
      apiPageCount: pages.length,
      pageHashes: pages.map(sha256Stable),
      uiLoadMoreCount: 1,
      cards: f.owner.records.map((row) => ({
        logicalSourceId: row.logicalSourceId,
        physicalId: row.physicalId,
        scope: row.scope,
        visible: true,
        actionable: true,
        textSha256: 'a'.repeat(64),
        screenshot: {
          ref: `case17/${phase}/${row.logicalSourceId}.png`,
          sha256: 'b'.repeat(64),
          bytes: 42,
        },
      })),
    };
  });
  return {
    ...f,
    before: f.owner,
    after: structuredClone(f.owner),
    rounds,
    synthesisSubmissionCount: 0,
    applicationWrites: 0,
    blockedWrites: 0,
  };
}
it('saved checks accept complete multiple pages and reorder after reload without minting authority', async () => {
  assert.deepEqual(inspectCase17SavedEvidence(await evidence()), {
    status: 'SAVED_CHECKS_ONLY',
    caseId: '17',
    independentProposalCount: 6,
    reloadVerified: true,
  });
});
it('missing/current/foreign/action/page/byte/write evidence fails closed', async () => {
  const original = await evidence();
  for (const alter of [
    (f) => f.rounds.pop(),
    (f) => f.rounds[1].cards.pop(),
    (f) => {
      f.after.records[0].rowVersion = '43';
    },
    (f) => {
      f.rounds[1].cards[0].physicalId = randomUUID();
    },
    (f) => {
      f.rounds[0].cards[0].actionable = false;
    },
    (f) => {
      f.rounds[0].cards[0].screenshot = f.rounds[1].cards[0].screenshot;
    },
    (f) => {
      f.rounds[1].cards[0].screenshot.bytes = 0;
    },
    (f) => {
      f.rounds[1].pages[1].nextCursor = 'unread';
    },
    (f) => {
      f.rounds[1].pageHashes[0] = '0'.repeat(64);
    },
    (f) => {
      f.rounds[1].uiLoadMoreCount = 10;
    },
    (f) => {
      f.rounds[1].pages[0].fixtureEvidence = {};
    },
    ...['synthesisSubmissionCount', 'applicationWrites', 'blockedWrites'].flatMap((key) => [
      (f) => {
        f[key] = 1;
      },
      (f) => {
        delete f[key];
      },
    ]),
  ]) {
    const f = structuredClone(original);
    alter(f);
    assert.throws(() => inspectCase17SavedEvidence(f));
  }
});
