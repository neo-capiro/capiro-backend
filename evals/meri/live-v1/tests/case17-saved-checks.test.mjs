import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { selectPendingMemoryFixturePlan } from '../fixture-provisioning/memory-pending-fixture-plan.mjs';
import { fixtureRecordKey } from '../fixture-provisioning/contract.mjs';
import { inspectCase17SavedEvidence } from '../case17-saved-checks.mjs';
import { sha256Stable } from '../lib/stable.mjs';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { collectCase17MemoryUi } from '../case17-memory-ui.mjs';
import { createWindowsArtifactStorage } from '../windows-artifact-storage.mjs';

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
    manifest,
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
        recordedSourceProof: {
          sourceType: 'meri_synthetic_fixture',
          sourceId: row.ownershipMarkerSha256,
          sourceTypeLabel: 'Source type: Synthetic fixture',
          sourceReferenceLabel: `Recorded source reference: ${row.ownershipMarkerSha256}`,
          expanded: true,
          visible: true,
        },
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
    blockedPreferenceWrites: 0,
    blockedWriteRequests: [],
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
it('saved checks accept only accounted blocked panel preferences and still reject owner changes', async () => {
  const f = await evidence();
  f.blockedWrites = f.blockedPreferenceWrites = 2;
  f.blockedWriteRequests = ['initial', 'afterReload'].map((phase) => ({
    method: 'PUT',
    path: '/api/clio/vnext/preferences',
    phase,
    kind: 'blocked_panel_preference',
  }));
  assert.equal(inspectCase17SavedEvidence(f).status, 'SAVED_CHECKS_ONLY');
  const changed = structuredClone(f);
  changed.after.records[0].rowVersion = '43';
  assert.throws(() => inspectCase17SavedEvidence(changed), /CURRENT_OWNER_CHANGED/u);
  f.blockedWriteRequests[1].path = '[redacted]';
  assert.throws(() => inspectCase17SavedEvidence(f), /WRITE_ACCOUNTING/u);
});
it('saved checks reject absent, swapped, duplicated, foreign, hidden and closed source proof in either round', async () => {
  const original = await evidence();
  const alterProofs = [
    (round) => {
      delete round.cards[0].recordedSourceProof;
    },
    (round) => {
      const first = round.cards[0].recordedSourceProof;
      round.cards[0].recordedSourceProof = round.cards[1].recordedSourceProof;
      round.cards[1].recordedSourceProof = first;
    },
    (round) => {
      round.cards[1].recordedSourceProof = structuredClone(round.cards[0].recordedSourceProof);
    },
    (round) => {
      round.cards[0].recordedSourceProof.sourceType = 'foreign_source';
    },
    (round) => {
      round.cards[0].recordedSourceProof.visible = false;
    },
    (round) => {
      round.cards[0].recordedSourceProof.expanded = false;
    },
    (round) => {
      round.cards[0].recordedSourceProof.unexpected = 'foreign proof field';
    },
  ];
  for (let roundIndex = 0; roundIndex < 2; roundIndex++) {
    for (const alter of alterProofs) {
      const f = structuredClone(original);
      alter(f.rounds[roundIndex]);
      assert.throws(() => inspectCase17SavedEvidence(f), /CASE17_SAVED_RECORDED_SOURCE_PROOF/u);
    }
  }
});
it('saved checks reject absent, unknown, malformed, swapped and duplicated API source references after page rehash', async () => {
  const original = await evidence();
  const alterSources = [
    (row) => {
      delete row.recordedSource;
    },
    (row) => {
      row.recordedSource.sourceType = 'unknown_source';
    },
    (row) => {
      row.recordedSource.sourceId = 'not-a-marker-hash';
    },
    (row, rows) => {
      const first = row.recordedSource;
      row.recordedSource = rows[1].recordedSource;
      rows[1].recordedSource = first;
    },
    (row, rows) => {
      rows[1].recordedSource.sourceId = row.recordedSource.sourceId;
    },
    (row) => {
      row.recordedSource.unexpected = 'duplicate reference field';
    },
  ];
  for (let roundIndex = 0; roundIndex < 2; roundIndex++) {
    for (const alter of alterSources) {
      const f = structuredClone(original);
      const round = f.rounds[roundIndex];
      const rows = round.pages.flatMap((page) => page.candidates);
      alter(rows[0], rows);
      round.pageHashes = round.pages.map(sha256Stable);
      assert.throws(() => inspectCase17SavedEvidence(f), /CASE17_UI_RECORDED_SOURCE_BINDING/u);
    }
  }
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

it(
  'real collector persists redacted owner/count diagnostics before each final guard, including failures',
  { timeout: 90000 },
  async () => {
    const scratch = process.env.MERI_WINDOWS_ARTIFACT_TEST_ROOT;
    const pythonExecutable = process.env.MERI_WINDOWS_ARTIFACT_PYTHON;
    assert.ok(
      process.platform === 'win32' && scratch && pythonExecutable,
      'explicit owned Windows test storage is required',
    );
    await mkdir(scratch, { recursive: true });
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      for (const mode of ['preferences', 'business-write', 'owner-change']) {
        const f = await fixture();
        const storage = createWindowsArtifactStorage(join(scratch, 'case17-' + randomUUID()), {
          pythonExecutable,
        });
        storage.init(Buffer.from('{"kind":"unit-only-case17-test"}'), Buffer.from('unit-only'));
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const apiSha = 'a'.repeat(40),
          webSha = 'b'.repeat(40);
        const ctx = {
          userId: f.selection.proposerUserId,
          tenantId: 'unit-tenant',
          tenantSlug: 'unit-synthetic',
          role: 'user_admin',
        };
        let ownerReads = 0,
          forwardedWrites = 0;
        const rows = f.pages.flatMap((value) => value.candidates);
        const markup = `<script>window.__CAPIRO_CONFIG__=${JSON.stringify({ releaseSha: webSha, webSurface: 'vnext' })}</script>
        <div data-meri-context-rail><button id="memory">Memory</button><section style="width:650px;height:780px;overflow:auto"><div>YOUR PROPOSALS · 6</div></section></div>
        <script>
        for (const row of ${JSON.stringify(rows)}) {
          const card = document.createElement('article');
          card.style.cssText='margin:10px;padding:10px;overflow-wrap:anywhere;background:#eee';
          for(const text of [row.proposal.key,row.proposal.value,
            row.scope==='personal'?'PERSONAL MEMORY':row.scope==='client'?'CLIENT MEMORY':'FIRM MEMORY',
            'PENDING','Source: model extraction',row.clientName||'']) {
            const p=document.createElement('p');p.textContent=text;card.append(p);
          }
          const sourceDetails=document.createElement('details');
          const sourceSummary=document.createElement('summary');sourceSummary.textContent='Source details';sourceDetails.append(sourceSummary);
          for(const text of ['Source type: Synthetic fixture','Recorded source reference: '+row.recordedSource.sourceId]) {
            const p=document.createElement('p');p.textContent=text;sourceDetails.append(p);
          }
          card.append(sourceDetails);
          const withdraw=document.createElement('button');withdraw.textContent='Withdraw';card.append(withdraw);
          document.querySelector('section').append(card);
        }
        document.querySelector('#memory').onclick=()=>fetch(${JSON.stringify(mode === 'business-write' ? '/api/memory/proposals/synthetic-only' : '/api/clio/vnext/preferences')},
          {method:${JSON.stringify(mode === 'business-write' ? 'POST' : 'PUT')}}).catch(()=>{});
        </script>`;
        await page.route('**/*', (route) => {
          if (route.request().method() !== 'GET') forwardedWrites++;
          return route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: markup,
          });
        });
        const invoke = () =>
          collectCase17MemoryUi({
            page,
            recipe: {
              caseId: '17',
              fixtureInstanceId: f.manifest.fixtureInstanceId,
              actors: f.manifest.actors,
              clients: f.manifest.clients,
              ctx,
              clerkUserId: 'user_unit',
            },
            expectedApiSha: apiSha,
            expectedWebSha: webSha,
            artifactStorage: storage,
            readCurrentOwner: async () => {
              ownerReads++;
              const value = structuredClone(f.owner);
              if (mode === 'owner-change' && ownerReads > 1) value.records[0].rowVersion = '43';
              return value;
            },
            readApi: async (path) => ({
              status: 200,
              bytes: 1024,
              releaseSha: apiSha,
              value:
                path === '/api/me'
                  ? {
                      user: { id: ctx.userId, clerkUserId: 'user_unit' },
                      tenant: { id: ctx.tenantId, slug: ctx.tenantSlug },
                      role: ctx.role,
                    }
                  : { ...f.pages[path.includes('&cursor=') ? 1 : 0], fixtureEvidence: f.owner },
            }),
          });
        if (mode === 'preferences') {
          const result = await invoke();
          assert.equal(result.evidence.blockedWrites, 2);
          assert.equal(result.evidence.blockedPreferenceWrites, 2);
          assert.equal(inspectCase17SavedEvidence(result.evidence).status, 'SAVED_CHECKS_ONLY');
          for (const round of result.evidence.rounds) {
            for (const card of round.cards) {
              assert.equal(card.recordedSourceProof.expanded, true);
              assert.equal(card.recordedSourceProof.visible, true);
            }
          }
        } else {
          await assert.rejects(
            invoke(),
            mode === 'business-write' ? /WRITE_ACCOUNTING/u : /OWNER_OR_WRITE_CHANGED/u,
          );
        }
        const diagnostic = JSON.parse(storage.readBytes('case17/readonly-guard-diagnostic.json'));
        assert.equal(diagnostic.ownerBeforeSha256, sha256Stable(f.owner));
        assert.equal(diagnostic.ownerUnchanged, mode !== 'owner-change');
        assert.equal(
          diagnostic.ownerBeforeSha256 === diagnostic.ownerAfterSha256,
          mode !== 'owner-change',
        );
        assert.equal(diagnostic.blockedWrites, 2);
        assert.equal(diagnostic.blockedPreferenceWrites, mode === 'business-write' ? 0 : 2);
        assert.equal(diagnostic.applicationWrites, 0);
        assert.equal(forwardedWrites, 0);
        assert.doesNotMatch(JSON.stringify(diagnostic), /synthetic-only|rowVersion|user_unit/u);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  },
);
