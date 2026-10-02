import { inspectCase46ArtifactScope, inspectCase46ArtifactDownload, inspectCase46ArtifactReload, CASE46_EXPECTED } from './case46-artifact-evidence.mjs';
import { assertWindowsArtifactStorage } from './windows-artifact-storage.mjs';
import { stableJson } from './lib/stable.mjs';

const ORIGIN = 'https://os.capiro.ai';
const CLERK = 'https://clerk.app.capiro.ai';
const need = (ok, code) => { if (!ok) throw new Error(`CASE46_UI_${code}`); };

/** A bounded UI substep for an already generated, admitted proposal. The native
 * authenticated capture owner supplies page/readApi and owns session cleanup.
 * This does not send a prompt, create a proposal, confer write admission, install
 * a budget or turn caller objects into LIVE acceptance. */
export async function collectCase46ArtifactUi({ page, scope: input, readApi, artifactStorage }) {
  const scope = inspectCase46ArtifactScope(input);
  need(typeof readApi === 'function', 'AUTHENTICATED_READER_REQUIRED');
  assertWindowsArtifactStorage(artifactStorage, artifactStorage?.root);
  // Existing-file refusal prevents a second approval after any ambiguous run.
  artifactStorage.writeBytes('case46-ui-claim.json', Buffer.from(stableJson({ caseId: '46', scope, status: 'CLAIMED' })));
  const startedAt = Date.now(), deadline = startedAt + 120000;
  const approvalPath = `/api/clio/action-proposals/${scope.proposalId}/approve`;
  const proposalsPath = `/api/clio/action-proposals?conversationId=${scope.conversationId}`;
  let approvalRequests = 0, blockedWrites = 0, readRequests = 0;
  const bounded = () => need(Date.now() < deadline && readRequests <= 10, 'TIME_OR_READ_BOUND');
  const guard = async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && url.origin !== CLERK) {
      let body;
      try { body = request.postData() ? JSON.parse(request.postData()) : {}; } catch { body = null; }
      if (url.origin !== ORIGIN || url.pathname !== approvalPath || url.search || request.method() !== 'POST' ||
          !body || Object.keys(body).length || approvalRequests !== 0 || Date.now() >= deadline) {
        blockedWrites++;
        return route.abort();
      }
      approvalRequests++;
      artifactStorage.writeBytes('case46-approval-intent.json', Buffer.from(stableJson({ proposalId: scope.proposalId, at: Date.now() })));
    }
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() &&
        (url.origin !== ORIGIN || url.pathname !== `/meri/t/${scope.conversationId}`)) return route.abort();
    return route.fallback();
  };
  const get = async (path) => {
    bounded(); readRequests++;
    need(path === '/api/me' || path === proposalsPath || path === `/api/clio/conversations/${scope.conversationId}`, 'READ_ROUTE');
    const response = await readApi(path);
    need(response.status === 200 && response.releaseSha === scope.apiSha && response.bytes <= 262144, 'CURRENT_API');
    return response.value;
  };
  const currentPage = async () => {
    bounded();
    need(page.url() === `${ORIGIN}/meri/t/${scope.conversationId}`, 'CONVERSATION_ROUTE');
    const runtime = await page.evaluate(() => ({ sha: window.__CAPIRO_CONFIG__?.releaseSha, surface: window.__CAPIRO_CONFIG__?.webSurface }));
    need(runtime.sha === scope.webSha && runtime.surface === 'vnext', 'WEB_SOURCE');
    const me = await get('/api/me');
    need(me?.user?.id === scope.userId && me.user.clerkUserId === scope.clerkUserId && me?.tenant?.id === scope.tenantId &&
      me.tenant.slug === scope.tenantSlug && me.role === scope.role, 'CURRENT_ACTOR');
    const conversation = await get(`/api/clio/conversations/${scope.conversationId}`);
    need(conversation?.id === scope.conversationId && conversation.clientId === scope.clientId, 'CURRENT_CLIENT');
  };
  const ownProposal = async (expectedStatus) => {
    // This product GET may reconcile its own proposal lifecycle; it is not
    // represented as a database read-only guarantee or a provider-budget bypass.
    const proposals = await get(proposalsPath);
    need(Array.isArray(proposals) && proposals.length === 1, 'ONE_PROPOSAL_REQUIRED');
    const proposal = proposals[0];
    need(proposal.proposalId === scope.proposalId && proposal.status === expectedStatus && proposal.tool === 'create_word' &&
      proposal.preview?.client?.id === scope.clientId && proposal.preview.leavesFirm === false &&
      typeof proposal.preview.fields?.title === 'string' && proposal.preview.fields.title.length <= 160, 'PROPOSAL_SCOPE');
    return proposal;
  };
  const rounds = [];
  await page.route('**/*', guard);
  try {
    await currentPage();
    const proposed = await ownProposal('proposed');
    need(proposed.attemptCount === 0 && proposed.resultSummary === null, 'NEW_PROPOSAL_REQUIRED');
    await page.getByRole('button', { name: 'Approvals', exact: true }).click({ timeout: 15000 });
    const card = page.locator('.vnext-meri__pending-approval-card');
    await card.waitFor({ state: 'visible', timeout: 15000 });
    need(await card.count() === 1, 'ONE_VISIBLE_PROPOSAL_REQUIRED');
    artifactStorage.writeBytes('case46-proposed.png', await card.screenshot({ type: 'png', timeout: 15000 }));
    await card.getByRole('button', { name: 'Approve', exact: true }).click({ timeout: 15000 });
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 15000 });
    await dialog.getByRole('checkbox').check({ timeout: 15000 });
    const [approved] = await Promise.all([
      page.waitForResponse((response) => response.url() === ORIGIN + approvalPath && response.request().method() === 'POST', { timeout: 30000 }),
      dialog.getByRole('button', { name: 'Confirm & run', exact: true }).click({ timeout: 15000 }),
    ]);
    need(approvalRequests === 1 && approved.status() === 201 && (await approved.allHeaders())['x-capiro-release-sha'] === scope.apiSha, 'APPROVAL_RESPONSE');
    const decision = await approved.json();
    need(decision?.proposalId === scope.proposalId && decision.status === 'succeeded', 'APPROVAL_NOT_SUCCEEDED');
    for (const phase of ['initial', 'after-reload']) {
      bounded();
      if (phase === 'after-reload') {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await currentPage();
      }
      const proposal = await ownProposal('succeeded');
      need(proposal.resultSummary?.ok === true && proposal.resultSummary.filename === CASE46_EXPECTED.filename &&
        proposal.resultSummary.sha256 === CASE46_EXPECTED.byteSha256 && proposal.approvedBy === scope.userId, 'DURABLE_PROPOSAL');
      const artifactId = proposal.resultSummary.artifactId;
      need(/^[a-f0-9-]{36}$/u.test(artifactId ?? ''), 'ARTIFACT_ID');
      const openArtifact = page.getByRole('button', { name: `Open ${proposed.preview.fields.title}`, exact: true });
      await openArtifact.waitFor({ state: 'visible', timeout: 15000 });
      await openArtifact.click({ timeout: 15000 });
      const downloadPath = `/api/clio/artifacts/${artifactId}/download`;
      const [download, response] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        page.waitForResponse((res) => res.url() === ORIGIN + downloadPath && res.request().method() === 'GET', { timeout: 30000 }),
        page.getByRole('button', { name: 'Download .txt', exact: true }).click({ timeout: 15000 }),
      ]);
      need(response.status() === 200 && await download.failure() === null, 'DOWNLOAD_FAILED');
      const chunks = [], stream = await download.createReadStream();
      need(stream, 'DOWNLOAD_STREAM');
      let length = 0;
      for await (const chunk of stream) {
        length += chunk.length;
        need(length <= 1024, 'DOWNLOAD_BYTE_BOUND');
        chunks.push(chunk);
      }
      const downloadedBytes = Buffer.concat(chunks);
      const checked = inspectCase46ArtifactDownload({ scope, headers: await response.allHeaders(), responseBytes: await response.body(), downloadedBytes, suggestedFilename: download.suggestedFilename() });
      need(checked.artifactId === artifactId && checked.operationId === proposal.resultSummary.operationId, 'PROPOSAL_DOWNLOAD_JOIN');
      const bytes = artifactStorage.writeBytes(`case46-${phase}.txt`, downloadedBytes);
      const screenshot = artifactStorage.writeBytes(`case46-${phase}.png`, await page.locator('[data-meri-context-rail]').screenshot({ type: 'png', timeout: 15000 }));
      rounds.push({ phase, checked, bytes, screenshot });
    }
    inspectCase46ArtifactReload(rounds[0].checked, rounds[1].checked);
    need(approvalRequests === 1 && blockedWrites === 0, 'WRITE_BOUND');
    const evidence = { schemaVersion: 1, kind: 'meri-case46-artifact-ui-observation', caseId: '46', captureRunId: scope.captureRunId,
      scope, startedAt, completedAt: Date.now(), approvalRequests, blockedWrites, readRequests, rounds,
      liveAcceptance: 'NOT_RUN', fullFile01Acceptance: false, status: 'UI_SUBSTEP_ONLY' };
    const descriptor = artifactStorage.writeBytes('case46-artifact-ui.json', Buffer.from(stableJson(evidence)));
    return { evidence, descriptor };
  } catch (error) {
    artifactStorage.writeBytes('case46-ui-stopped.json', Buffer.from(stableJson({ status: 'RECONCILIATION_REQUIRED', approvalRequests, blockedWrites, completedDownloadRounds: rounds.length })));
    throw new Error(/^CASE46_[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'CASE46_UI_STOPPED_NO_RETRY');
  } finally {
    await page.unroute('**/*', guard);
  }
}
