// Diagnostic only. No capture authority, grading, model turn, or application write.
import https from 'node:https';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { inspectCase17Scope } from 'file:///C:/dev/cap-meri-outcomes-validation/evals/meri/live-v1/case17-live-capture.mjs';
import { readCase17BuildAuthority } from 'file:///C:/dev/cap-meri-outcomes-validation/evals/meri/live-v1/case17-build-authority.mjs';
import { inspectPendingUiPage } from 'file:///C:/dev/cap-meri-outcomes-validation/evals/meri/live-v1/case17-memory-ui.mjs';
import { buildFixtureManifest } from 'file:///C:/dev/cap-meri-outcomes-validation/evals/meri/live-v1/fixture-provisioning/manifest.mjs';
import { selectPendingMemoryFixturePlan } from 'file:///C:/dev/cap-meri-outcomes-validation/evals/meri/live-v1/fixture-provisioning/memory-pending-fixture-plan.mjs';
import { sha256Stable } from 'file:///C:/dev/cap-meri-outcomes-validation/evals/meri/live-v1/lib/stable.mjs';

const ORIGIN = 'https://os.capiro.ai', CLERK = 'https://clerk.app.capiro.ai';
const ROOT = 'C:/dev/cap-meri-foundation-evidence/oct02-case17-card-diagnostic';
const hash = value => createHash('sha256').update(value).digest('hex');
const need = (ok, code) => { if (!ok) throw new Error(`CASE17_DIAG_${code}`); };
const safeError = error => ({
  class: ['Error', 'TypeError', 'TimeoutError', 'AssertionError'].includes(error?.name) ? error.name : 'OtherError',
  category: /^CASE17_[A-Z_]+$/u.test(error?.message ?? '') ? error.message
    : /strict mode violation/iu.test(error?.message ?? '') ? 'PLAYWRIGHT_STRICT_MODE'
    : /timeout|timed out/iu.test(error?.message ?? '') ? 'TIMEOUT'
    : /closed/iu.test(error?.message ?? '') ? 'BROWSER_OR_TARGET_CLOSED'
    : 'UNCLASSIFIED_EXCEPTION',
});
export { safeError };

export function routeDisposition({ method, origin, path, navigation, mainFrame }) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && origin !== CLERK) return 'BLOCK_WRITE';
  if (navigation && (mainFrame ? origin !== ORIGIN || !['/sign-in', '/meri'].some(p => path === p || path.startsWith(p + '/'))
    : ![ORIGIN, CLERK].includes(origin))) return 'BLOCK_NAVIGATION';
  return 'ALLOW';
}

async function selectors(page) {
  const result = {};
  for (const name of ['Expand panel', 'Open Context and Memory', 'Memory']) {
    const locator = page.getByRole('button', { name, exact: true });
    result[name] = { count: await locator.count(), visible: [] };
    for (let index = 0; index < Math.min(result[name].count, 5); index++)
      result[name].visible.push(await locator.nth(index).isVisible());
  }
  const section = page.locator('section').filter({ has: page.getByText(/^YOUR PROPOSALS ·/u) });
  result.proposalsSections = await section.count();
  result.proposalArticleCount = await section.locator('article').count();
  return result;
}


export async function observeOwnedProposalCards(page, rows) {
  const section = page.locator('section').filter({ has: page.getByText(/^YOUR PROPOSALS ·/u) });
  const cards = [];
  for (const row of rows) {
    const card = section.locator('article').filter({ has: page.getByText(row.key, { exact: true }) });
    const count = await card.count();
    cards.push({ logicalSourceId: row.logicalSourceId, count,
      exactTextCount: await card.getByText(row.text, { exact: true }).count(),
      withdrawButtonCount: await card.getByRole('button', { name: 'Withdraw', exact: true }).count(),
      visible: count === 1 ? await card.isVisible() : null,
      pendingLabelCount: await card.getByText(/PENDING/u).count(),
      sourceLabelCount: await card.getByText('Source: model extraction', {exact:true}).count() });
  }
  return { sectionCount: await section.count(), articleCount: await section.locator('article').count(),
    loadingVisible: await section.getByText('Loading your proposals…', {exact:true}).isVisible(),
    errorVisible: await section.getByText('Your proposal history could not be loaded.', {exact:true}).isVisible(),
    emptyVisible: await section.getByText('You have not proposed an institutional memory change.', {exact:true}).isVisible(),
    loadMoreCount: await section.getByRole('button', {name:'Load more proposals',exact:true}).count(), cards };
}
export async function diagnoseOwnedProposalCards(page, rows, stage) {
  await stage('cards_at_first_section_visibility', () => observeOwnedProposalCards(page, rows));
  await stage('wait_proposal_query_settlement', () => page.waitForFunction(() => {
    const section = [...document.querySelectorAll('section')].find(node => node.textContent.includes('YOUR PROPOSALS ·'));
    return !!section && !section.textContent.includes('Loading your proposals…') &&
      (section.querySelectorAll('article').length > 0 || section.textContent.includes('Your proposal history could not be loaded.') || section.textContent.includes('You have not proposed an institutional memory change.'));
  }, null, {timeout:15000}).then(() => undefined));
  await stage('cards_after_query_settlement', () => observeOwnedProposalCards(page, rows));
}

/** Mirrors the current production collector's exact control choices. A duplicate
 * match fails at its original step; the diagnostic never guesses another button. */
export async function openMemoryPanel(page, stage) {
  await stage('wait_context_rail', () => page.locator('[data-meri-context-rail]').waitFor({state:'visible',timeout:15000}));
  await stage('selectors_before_panel', () => selectors(page));
  await stage('optional_expand_panel', async () => {
    const locator = page.getByRole('button', { name: 'Expand panel', exact: true });
    if (await locator.isVisible()) await locator.click({ timeout: 15000 });
  });
  await stage('selectors_after_expand', () => selectors(page));
  await stage('optional_open_context', async () => {
    const locator = page.getByRole('button', { name: 'Open Context and Memory', exact: true });
    if (await locator.isVisible()) await locator.click({ timeout: 15000 });
  });
  await stage('selectors_before_memory', () => selectors(page));
  await stage('click_memory', () => page.getByRole('button', { name: 'Memory', exact: true }).click({ timeout: 15000 }));
  await stage('wait_proposals_section', async () => {
    const section = page.locator('section').filter({ has: page.getByText(/^YOUR PROPOSALS ·/u) });
    await section.waitFor({ state: 'visible', timeout: 15000 });
    return selectors(page);
  });
}

export async function diagnoseCase17Ui({ config: input, createSignInTicket, onSessionCreated, onProgress }) {
  const config = inspectCase17Scope(input);
  const result = { kind: 'meri-case17-readonly-ui-diagnostic', caseId: '17', captureRunId: config.captureRunId,
    apiSha: config.deployment.apiSha, webSha: config.deployment.webSha, startedAt: new Date().toISOString(),
    stages: [], reads: [], browserApiReads: [], blockedWrites: 0, blockedNavigations: 0,
    pageErrorCategories: [], applicationWrites: 0, modelTurns: 0, acceptance: 'NOT_RUN' };
  const progress = async () => { await onProgress(structuredClone(result)); };
  const stage = async (name, fn) => {
    result.currentStage = name; const row = { name, startedAt: new Date().toISOString(), status: 'STARTED' };
    result.stages.push(row); await progress();
    try { const value = await fn(); row.status = 'PASS'; if (value !== undefined) row.observation = value; await progress(); return value; }
    catch (error) { row.status = 'FAIL'; row.error = safeError(error); await progress(); throw error; }
  };
  let browser, page, sessionId, timer, rows, screenshotAllowed = false;
  let readCount = 0;
  const deadline = Date.now() + 240000;
  const read = async (path, bearer) => {
    need(Date.now() < deadline && ++readCount <= 4 && ['/api/me', '/api/memory/proposals?limit=50'].includes(path), 'READ_BOUND');
    return new Promise((resolve, reject) => {
      const req = https.request(new URL(path, ORIGIN), { method: 'GET', rejectUnauthorized: true,
        timeout: Math.min(15000, deadline - Date.now()), headers: {
          'User-Agent': 'Capiro-Meri-Authorized-QA/1.0', Authorization: `Bearer ${bearer}`,
          'x-capiro-tenant': config.recipe.ctx.tenantSlug,
        } }, res => {
        const chunks = []; let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 262144) req.destroy(new Error('CASE17_DIAG_RESPONSE_BOUND')); else chunks.push(chunk); });
        res.on('error', () => reject(new Error('CASE17_DIAG_READ_FAILED')));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks); let value; try { value = JSON.parse(body.toString('utf8')); } catch {}
            const observed = { path, status: res.statusCode, bytes, sha256: hash(body), json: !!value,
              releaseSha: /^[a-f0-9]{40}$/u.test(res.headers['x-capiro-release-sha'] ?? '') ? res.headers['x-capiro-release-sha'] : null,
              candidateCount: Array.isArray(value?.candidates) ? value.candidates.length : null,
              hasFixtureEvidence: !!value?.fixtureEvidence };
            result.reads.push(observed);
            need(res.statusCode === 200 && observed.releaseSha === config.deployment.apiSha && value && !body.includes(Buffer.from(bearer)), 'AUTHENTICATED_READ');
            resolve(value);
          } catch (error) { reject(error); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('CASE17_DIAG_READ_TIMEOUT')));
      req.on('error', () => reject(new Error('CASE17_DIAG_READ_FAILED'))); req.end();
    });
  };
  try {
    await stage('current_builds', async () => { const proof = await readCase17BuildAuthority(config.deployment); return { observedAt: proof.observedAt, services: proof.services }; });
    await stage('launch_browser', async () => {
      const require = createRequire('C:/dev/cap-meri-outcomes-validation/apps/api/package.json');
      browser = await require('playwright').chromium.launch({ headless: true });
      timer = setTimeout(() => { void browser.close().catch(() => {}); }, 240000);
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
      page = await context.newPage();
      page.on('pageerror', error => { if (result.pageErrorCategories.length < 12) result.pageErrorCategories.push(safeError(error)); });
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.origin === ORIGIN && ['/api/me', '/api/memory/proposals'].includes(url.pathname) && result.browserApiReads.length < 24)
          result.browserApiReads.push({ path: url.pathname, method: response.request().method(), status: response.status() });
      });
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        const disposition = routeDisposition({ method: request.method(), origin: url.origin, path: url.pathname,
          navigation: request.isNavigationRequest(), mainFrame: request.isNavigationRequest() && request.frame() === page.mainFrame() });
        if (disposition === 'BLOCK_WRITE') { result.blockedWrites++; return route.abort(); }
        if (disposition === 'BLOCK_NAVIGATION') { result.blockedNavigations++; return route.abort(); }
        return route.continue();
      });
    });
    await stage('sign_in_page', () => page.goto(ORIGIN + '/sign-in', { waitUntil: 'domcontentloaded', timeout: 30000 }).then(() => undefined));
    await stage('clerk_loaded', () => page.waitForFunction(() => window.Clerk?.loaded, null, { timeout: 45000 }).then(() => undefined));
    await stage('web_identity', async () => {
      const actual = await page.evaluate(() => {
        const c = window.__CAPIRO_CONFIG__; let clerkHost;
        const m = /^pk_(?:live|test)_([A-Za-z0-9_-]+)$/u.exec(c?.clerkPublishableKey ?? '');
        if (m) try { clerkHost = atob(m[1].replace(/-/g, '+').replace(/_/g, '/')).replace(/\$$/u, ''); } catch {}
        return { releaseSha: c?.releaseSha, surface: c?.webSurface, clerkHost };
      });
      need(actual.releaseSha === config.deployment.webSha && actual.surface === 'vnext' && actual.clerkHost === 'clerk.app.capiro.ai', 'WEB_SOURCE'); return actual;
    });
    await stage('create_owned_session', async () => {
      const ticket = await createSignInTicket(config.recipe.clerkUserId);
      need(typeof ticket === 'string' && ticket.length > 10 && ticket.length < 16384, 'TICKET');
      const signed = await page.evaluate(async token => { const a = await window.Clerk.client.signIn.create({ strategy: 'ticket', ticket: token }); return { complete: a.status === 'complete', sessionId: a.createdSessionId }; }, ticket);
      sessionId = signed.sessionId; if (sessionId) await onSessionCreated(sessionId);
      need(signed.complete && typeof sessionId === 'string', 'SIGN_IN'); return { complete: true };
    });
    await stage('set_active_organization', () => page.evaluate(value => window.Clerk.setActive(value), { session: sessionId, organization: config.clerkOrganizationId }).then(() => undefined));
    await stage('wait_active_identity', () => page.waitForFunction(({ userId, orgId }) => window.Clerk?.user?.id === userId && window.Clerk?.organization?.id === orgId,
      { userId: config.recipe.clerkUserId, orgId: config.clerkOrganizationId }, { timeout: 15000 }).then(() => undefined));
    let bearer;
    await stage('read_ephemeral_token', async () => { bearer = await page.evaluate(() => window.Clerk.session.getToken({ template: 'capiro' })); need(typeof bearer === 'string' && bearer.length > 10, 'TOKEN'); });
    await stage('native_current_actor', async () => {
      const me = await read('/api/me', bearer);
      need(me.user?.id === config.recipe.ctx.userId && me.user.clerkUserId === config.recipe.clerkUserId && me.tenant?.id === config.recipe.ctx.tenantId && me.tenant.slug === config.recipe.ctx.tenantSlug && me.role === config.recipe.ctx.role, 'ACTOR');
      return { exactActor: true, exactTenant: true, exactRole: true };
    });
    await stage('native_current_proposals', async () => {
      const value = await read('/api/memory/proposals?limit=50', bearer);
      const owner = value.fixtureEvidence;
      need(owner?.recipeSha256 === sha256Stable(config.recipe) && owner.ctx?.userId === config.recipe.ctx.userId && owner.ctx.tenantId === config.recipe.ctx.tenantId, 'OWNER');
      const manifest = await buildFixtureManifest({ fixtureInstanceId: config.recipe.fixtureInstanceId, actors: config.recipe.actors, clients: config.recipe.clients });
      rows = inspectPendingUiPage({ selection: selectPendingMemoryFixturePlan(manifest, '17'), owner, pages: [value] });
      return { currentOwnedRows: rows.length, ownerSha256: sha256Stable(owner) };
    });
    await stage('navigate_meri', async () => {
      await page.goto(ORIGIN + '/meri', { waitUntil: 'domcontentloaded', timeout: 30000 });
      const url = new URL(page.url()); need(url.origin === ORIGIN && url.pathname === '/meri', 'APPLICATION_ORIGIN');
      const source = await page.evaluate(() => ({ sha: window.__CAPIRO_CONFIG__?.releaseSha, surface: window.__CAPIRO_CONFIG__?.webSurface }));
      need(source.sha === config.deployment.webSha && source.surface === 'vnext', 'WEB_SOURCE'); screenshotAllowed = true;
    });
    await openMemoryPanel(page, stage);
    await diagnoseOwnedProposalCards(page, rows, stage);
    result.status = 'READ_ONLY_DIAGNOSTIC_COMPLETE';
  } catch (error) {
    result.status = 'READ_ONLY_DIAGNOSTIC_FAILED'; result.error = safeError(error);
  } finally {
    if (screenshotAllowed && page && !page.isClosed()) {
      try {
        result.finalSelectors = await selectors(page);
        const section = page.locator('section').filter({ has: page.getByText(/^YOUR PROPOSALS ·/u) });
        const observation = await observeOwnedProposalCards(page, rows ?? []);
        need(observation.articleCount === 0 || (observation.articleCount === 6 && observation.cards.length === 6 && observation.cards.every(card => card.count === 1)), 'SCREENSHOT_UNKNOWN_CARDS');
        const bytes = await section.screenshot({ timeout: 10000 });
        const file = ROOT + '/case17-card-diagnostic-v1.png'; writeFileSync(file, bytes, { flag: 'wx' });
        result.screenshot = { path: file, bytes: bytes.length, sha256: hash(bytes), scope: 'OWNED_SYNTHETIC_ACTOR_AND_SIX_PROPOSALS_VERIFIED' };
      } catch (error) { result.screenshotError = safeError(error); }
    }
    if (sessionId && page && !page.isClosed()) {
      try { await page.evaluate(id => window.Clerk.signOut({ sessionId: id }), sessionId); result.browserSignOutAttempted = true; }
      catch { result.browserSignOutAttempted = false; }
    }
    if (timer) clearTimeout(timer);
    await browser?.close().catch(() => {});
    result.completedAt = new Date().toISOString(); await progress();
  }
  return result;
}
