import { createHash } from 'node:crypto';
import { buildFixtureManifest } from './fixture-provisioning/manifest.mjs';
import { selectPendingMemoryFixturePlan } from './fixture-provisioning/memory-pending-fixture-plan.mjs';
import { fixtureRecordKey } from './fixture-provisioning/contract.mjs';
import { sha256Stable, stableJson } from './lib/stable.mjs';
import { assertWindowsArtifactStorage } from './windows-artifact-storage.mjs';

const origin = 'https://os.capiro.ai';
const need = (ok, code) => {
  if (!ok) throw new Error(`CASE17_UI_${code}`);
};

/** Pure join only; caller objects cannot become a LIVE verification capability. */
export function inspectPendingUiPage({ selection, owner, pages }) {
  need(
    owner?.kind === 'meri-pending-memory-current-readback' &&
      owner.caseId === '17' &&
      owner.fixtureInstanceId === selection.fixtureInstanceId &&
      owner.manifestContentSha256 === selection.manifestContentSha256 &&
      owner.ctx?.userId === selection.proposerUserId &&
      owner.currentVerifySha256 === sha256Stable(owner.records),
    'OWNER_BINDING',
  );
  need(Array.isArray(pages) && pages.length > 0 && pages.length <= 10, 'PAGE_BOUND');
  const rows = [],
    seen = new Set();
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    need(
      page.enabled === true && Array.isArray(page.candidates) && page.candidates.length <= 50,
      'PAGE_FORMAT',
    );
    need(
      index === pages.length - 1
        ? page.nextCursor === null
        : typeof page.nextCursor === 'string' && page.nextCursor.length > 0,
      'PAGE_CHAIN',
    );
    for (const row of page.candidates) {
      need(!seen.has(row.id), 'DUPLICATE_ROW');
      seen.add(row.id);
      rows.push(row);
    }
  }
  need(
    rows.length === 6 &&
      owner.records.length === 6 &&
      new Set(owner.records.map((row) => row.physicalId)).size === 6,
    'OWNER_ROW_COUNT',
  );
  return selection.records.map((record) => {
    const bound = owner.records.find((row) => row.logicalSourceId === record.logicalId);
    const row = rows.find((row) => row.id === record.physicalId);
    const scope =
      record.payload.facts.scope === 'private'
        ? 'personal'
        : record.clientPhysicalId
          ? 'client'
          : 'firm';
    const key = fixtureRecordKey(record.logicalId, selection.fixtureInstanceId);
    const text =
      record.payload.facts.proposedText ??
      record.payload.facts.text ??
      `Synthetic pending proposal ${record.logicalId}`;
    need(
      bound?.physicalId === record.physicalId &&
        bound.tenantId === record.tenantId &&
        bound.proposerUserId === selection.proposerUserId &&
        bound.payloadSha256 === record.payloadSha256 &&
        bound.ownershipMarkerSha256 === record.ownership.markerSha256 &&
        bound.status === 'pending' &&
        bound.scope === scope &&
        bound.clientId === record.clientPhysicalId,
      'OWNER_ROW_BINDING',
    );
    need(
      row?.scope === scope &&
        row.clientId === record.clientPhysicalId &&
        row.status === 'pending' &&
        row.restricted === false &&
        row.sourceKind === 'model_extraction' &&
        row.capabilities?.withdraw === true &&
        row.proposal?.key === key &&
        row.proposal.value === text &&
        row.proposal.canonicalItem === null,
      'API_ROW_BINDING',
    );
    need(
      scope !== 'client' || (typeof row.clientName === 'string' && row.clientName.length > 0),
      'CLIENT_LABEL',
    );
    return {
      logicalSourceId: record.logicalId,
      physicalId: row.id,
      key,
      text,
      scope,
      clientName: row.clientName ?? null,
      sourceKind: row.sourceKind,
    };
  });
}

/** The native collector supplies its new approved synthetic authenticated page and fresh
 * source-owned canonical read function. No login, model turn, mutation or LIVE
 * acceptance verdict is performed here. Saved bytes are graded separately. */
export async function openCase17MemoryPanel(page) {
  // Navigation's DOMContentLoaded precedes the React rail mount. Wait for its
  // atomic render before deciding whether either optional entry is present.
  await page.locator('[data-meri-context-rail]').waitFor({ state: 'visible', timeout: 15000 });
  const expand = page.getByRole('button', { name: 'Expand panel', exact: true });
  if (await expand.isVisible()) await expand.click();
  const context = page.getByRole('button', { name: 'Open Context and Memory', exact: true });
  if (await context.isVisible()) await context.click();
  await page.getByRole('button', { name: 'Memory', exact: true }).click({ timeout: 15000 });
}

// The section mounts while its owned-proposals query is still loading. Wait for
// the actual query state before inspecting pagination or exact card identities.
export async function waitForCase17ProposalQuery(page) {
  const section = page.locator('section').filter({ has: page.getByText(/^YOUR PROPOSALS ·/u) });
  await section.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(
    () => {
      const section = [...document.querySelectorAll('section')].find((node) =>
        node.textContent.includes('YOUR PROPOSALS ·'),
      );
      return (
        !!section &&
        !section.textContent.includes('Loading your proposals…') &&
        (section.querySelectorAll('article').length > 0 ||
          section.textContent.includes('Your proposal history could not be loaded.') ||
          section.textContent.includes('You have not proposed an institutional memory change.'))
      );
    },
    null,
    { timeout: 15000 },
  );
  need(
    !(await section.getByText('Your proposal history could not be loaded.', { exact: true }).isVisible()),
    'PROPOSALS_QUERY_FAILED',
  );
  return section;
}

export async function collectCase17MemoryUi({
  page,
  recipe,
  readCurrentOwner,
  readApi,
  expectedApiSha,
  expectedWebSha,
  artifactStorage,
}) {
  need(
    typeof readCurrentOwner === 'function' &&
      typeof readApi === 'function' &&
      /^[a-f0-9]{40}$/u.test(expectedApiSha ?? '') &&
      /^[a-f0-9]{40}$/u.test(expectedWebSha ?? ''),
    'QUALIFIED_OPERATOR_REQUIRED',
  );
  assertWindowsArtifactStorage(artifactStorage, artifactStorage?.root);
  const manifest = await buildFixtureManifest({
    fixtureInstanceId: recipe.fixtureInstanceId,
    actors: recipe.actors,
    clients: recipe.clients,
  });
  const selection = selectPendingMemoryFixturePlan(manifest, '17');
  need(recipe.caseId === '17' && recipe.ctx?.userId === selection.proposerUserId, 'RECIPE_SCOPE');
  let blockedWrites = 0,
    requests = 0;
  const guard = async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
      url.origin !== 'https://clerk.app.capiro.ai'
    ) {
      blockedWrites++;
      return route.abort();
    }
    if (
      request.isNavigationRequest() &&
      (request.frame() === page.mainFrame()
        ? url.origin !== origin || !url.pathname.startsWith('/meri')
        : ![origin, 'https://clerk.app.capiro.ai'].includes(url.origin))
    )
      return route.abort();
    return route.fallback();
  };
  await page.route('**/*', guard);
  const deadline = Date.now() + 120000;
  const bounded = () => need(Date.now() < deadline && requests <= 24, 'READ_BOUND');
  const get = async (path) => {
    bounded();
    requests++;
    need(
      path === '/api/me' ||
        /^\/api\/memory\/proposals\?limit=50(?:&cursor=[A-Za-z0-9%_-]+)?$/u.test(path),
      'READ_ROUTE',
    );
    const value = await readApi(path);
    need(
      value.status === 200 && value.bytes <= 262144 && value.releaseSha === expectedApiSha,
      'AUTHENTICATED_READ',
    );
    return value.value;
  };
  const rounds = [];
  try {
    const before = await readCurrentOwner();
    for (const phase of ['initial', 'afterReload']) {
      bounded();
      if (phase === 'initial')
        await page.goto(origin + '/meri', { waitUntil: 'domcontentloaded', timeout: 30000 });
      else await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      need(
        new URL(page.url()).origin === origin && new URL(page.url()).pathname.startsWith('/meri'),
        'APPLICATION_ORIGIN',
      );
      const web = await page.evaluate(() => ({
        releaseSha: window.__CAPIRO_CONFIG__?.releaseSha,
        surface: window.__CAPIRO_CONFIG__?.webSurface,
      }));
      need(web.releaseSha === expectedWebSha && web.surface === 'vnext', 'WEB_SOURCE');
      const me = await get('/api/me');
      need(
        me?.user?.id === recipe.ctx.userId &&
          me.user.clerkUserId === recipe.clerkUserId &&
          me.tenant?.id === recipe.ctx.tenantId &&
          me.tenant.slug === recipe.ctx.tenantSlug &&
          me.role === recipe.ctx.role,
        'CURRENT_ACTOR',
      );
      const pages = [],
        cursors = new Set();
      let cursor;
      do {
        const pageResult = await get(
          '/api/memory/proposals?limit=50' +
            (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
        );
        pages.push(pageResult);
        need(
          sha256Stable(pageResult.fixtureEvidence) === sha256Stable(before),
          'PAGE_OWNER_CHANGED',
        );
        cursor = pageResult.nextCursor;
        need(pages.length <= 10 && (!cursor || !cursors.has(cursor)), 'PAGE_BOUND');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const rows = inspectPendingUiPage({ selection, owner: before, pages });
      await openCase17MemoryPanel(page);
      const section = await waitForCase17ProposalQuery(page);
      let loads = 0;
      while (
        await section.getByRole('button', { name: 'Load more proposals', exact: true }).count()
      ) {
        need(++loads <= 9, 'UI_PAGE_BOUND');
        const count = await section.locator('article').count();
        await section.getByRole('button', { name: 'Load more proposals', exact: true }).click();
        await page.waitForFunction(
          ({ count }) =>
            [...document.querySelectorAll('section')]
              .find((section) => section.textContent.includes('YOUR PROPOSALS ·'))
              ?.querySelectorAll('article').length > count,
          { count },
          { timeout: 15000 },
        );
      }
      const cards = [];
      for (const row of rows) {
        bounded();
        const card = section
          .locator('article')
          .filter({ has: page.getByText(row.key, { exact: true }) });
        need((await card.count()) === 1, 'UNIQUE_CARD');
        await card
          .getByText(row.text, { exact: true })
          .waitFor({ state: 'visible', timeout: 15000 });
        const withdraw = card.getByRole('button', { name: 'Withdraw', exact: true });
        need((await withdraw.isVisible()) && (await withdraw.isEnabled()), 'ACTIONABLE');
        const text = await card.innerText();
        const scopeLabel =
          row.scope === 'personal'
            ? 'PERSONAL MEMORY'
            : row.scope === 'client'
              ? 'CLIENT MEMORY'
              : 'FIRM MEMORY';
        need(
          text.includes(scopeLabel) &&
            text.includes('PENDING') &&
            text.includes('Source: model extraction') &&
            (!row.clientName || text.includes(row.clientName)),
          'VISIBLE_PROVENANCE',
        );
        const bytes = await card.screenshot();
        const descriptor = artifactStorage.writeBytes(
          `case17/${phase}/${row.logicalSourceId}.png`,
          bytes,
        );
        cards.push({
          logicalSourceId: row.logicalSourceId,
          physicalId: row.physicalId,
          scope: row.scope,
          visible: true,
          actionable: true,
          textSha256: createHash('sha256').update(text).digest('hex'),
          screenshot: descriptor,
        });
      }
      rounds.push({
        phase,
        apiPageCount: pages.length,
        pageHashes: pages.map(sha256Stable),
        pages,
        uiLoadMoreCount: loads,
        cards,
      });
    }
    const after = await readCurrentOwner();
    need(
      sha256Stable(before) === sha256Stable(after) && blockedWrites === 0,
      'OWNER_OR_WRITE_CHANGED',
    );
    const receipt = {
      kind: 'meri-case17-ui-readonly-receipt',
      schemaVersion: 1,
      caseId: '17',
      status: 'CAPTURE_COMPLETE',
      fixtureInstanceId: selection.fixtureInstanceId,
      ownerReadbackSha256: sha256Stable(after),
      expectedApiSha,
      expectedWebSha,
      rounds,
      authenticatedReadCount: requests,
      blockedWrites,
      synthesisSubmissionCount: 0,
      applicationWrites: 0,
      liveAcceptance: 'NOT_RUN',
    };
    const descriptor = artifactStorage.writeBytes(
      'case17/receipt.json',
      Buffer.from(stableJson(receipt)),
    );
    need(
      sha256Stable(JSON.parse(artifactStorage.readBytes(descriptor.ref))) === sha256Stable(receipt),
      'STORAGE_READBACK',
    );
    return {
      receipt,
      descriptor,
      evidence: {
        selection,
        before,
        after,
        rounds,
        synthesisSubmissionCount: 0,
        applicationWrites: 0,
        blockedWrites,
      },
    };
  } finally {
    await page.unroute('**/*', guard);
  }
}
