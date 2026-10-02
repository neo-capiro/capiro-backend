import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { collectCase46ArtifactUi } from '../case46-artifact-ui.mjs';
import { createWindowsArtifactStorage } from '../windows-artifact-storage.mjs';
import { fixture } from './case46-artifact-evidence.test.mjs';

const enabled = process.platform === 'win32' && Boolean(process.env.MERI_WINDOWS_ARTIFACT_TEST_ROOT && process.env.MERI_WINDOWS_ARTIFACT_PYTHON);
const ORIGIN = 'https://os.capiro.ai';

function harness({ ambiguous = false, foreignApproval = false, wrongSource = false } = {}) {
  const f = fixture(), scope = f.input.scope;
  const artifactStorage = createWindowsArtifactStorage(join(process.env.MERI_WINDOWS_ARTIFACT_TEST_ROOT, `case46-${randomUUID()}`), { pythonExecutable: process.env.MERI_WINDOWS_ARTIFACT_PYTHON });
  artifactStorage.init(Buffer.from('{"kind":"UNIT_FIXTURE","caseId":"46"}'), Buffer.from('UNIT_FIXTURE'));
  let guard, writes = 0, downloads = 0, reloads = 0;
  const waiting = [], events = [];
  const approval = `${ORIGIN}/api/clio/action-proposals/${scope.proposalId}/approve`;
  const request = (url, method) => ({ url: () => url, method: () => method, postData: () => '{}', isNavigationRequest: () => false });
  const response = (url, method, status, value, headers = {}) => ({ url: () => url, request: () => request(url, method), status: () => status,
    allHeaders: async () => ({ 'x-capiro-release-sha': scope.apiSha, ...headers }), json: async () => value, body: async () => f.input.responseBytes });
  const emit = (res) => { for (const wait of waiting.splice(0)) { assert.equal(wait.predicate(res), true); wait.resolve(res); } };
  const currentProposal = () => ({ proposalId: scope.proposalId, tool: 'create_word', status: writes ? 'succeeded' : 'proposed', attemptCount: writes ? 1 : 0,
    approvedBy: writes ? scope.userId : null, preview: { client: { id: scope.clientId }, leavesFirm: false, fields: { title: 'Aster Synthetic Briefing' } },
    resultSummary: writes ? { ok: true, filename: f.receipt.filename, sha256: f.receipt.sha256, artifactId: f.receipt.artifactId, operationId: f.receipt.operationId } : null });
  const locator = (name) => ({
    waitFor: async () => {}, count: async () => 1, screenshot: async () => Buffer.from('unit-png'), check: async () => {},
    getByRole: (_role, options) => locator(options?.name),
    click: async () => {
      if (name === 'Confirm & run') {
        let allowed = false;
        await guard({ request: () => request(foreignApproval ? approval.replace('https:', 'http:') : approval, 'POST'), abort: () => {}, fallback: () => { allowed = true; } });
        if (!allowed) throw new Error('Request blocked');
        writes++;
        if (ambiguous) throw new Error('Connection ended after request');
        emit(response(approval, 'POST', 201, currentProposal()));
      }
      if (name === 'Download .txt') {
        // Verifies both waits were armed before clicking.
        assert.equal(waiting.length, 1); assert.equal(events.length, 1);
        downloads++;
        emit(response(`${ORIGIN}/api/clio/artifacts/${f.receipt.artifactId}/download`, 'GET', 200, null, f.input.headers));
        events.shift()({ failure: async () => null, createReadStream: async () => Readable.from([f.input.downloadedBytes]), suggestedFilename: () => f.input.suggestedFilename });
      }
    },
  });
  const page = { route: async (_pattern, handler) => { guard = handler; }, unroute: async () => { guard = null; },
    url: () => `${ORIGIN}/meri/t/${scope.conversationId}`, evaluate: async () => ({ sha: scope.webSha, surface: 'vnext' }),
    getByRole: (_role, options) => locator(options?.name), locator, reload: async () => { reloads++; },
    waitForResponse: (predicate) => new Promise((resolve) => waiting.push({ predicate, resolve })),
    waitForEvent: (name) => { assert.equal(name, 'download'); return new Promise((resolve) => events.push(resolve)); },
  };
  const readApi = async (path) => ({ status: 200, releaseSha: wrongSource ? 'c'.repeat(40) : scope.apiSha, bytes: 100,
    value: path === '/api/me' ? { user: { id: scope.userId, clerkUserId: scope.clerkUserId }, tenant: { id: scope.tenantId, slug: scope.tenantSlug }, role: scope.role }
      : path.includes('/action-proposals?') ? [currentProposal()] : { id: scope.conversationId, clientId: scope.clientId } });
  return { input: { page, scope, readApi, artifactStorage }, counts: () => ({ writes, downloads, reloads }) };
}

test('actual native saved-byte collector waits before click, approves once, downloads before/after reload and never grants LIVE', { skip: !enabled }, async () => {
  const h = harness(), outcome = await collectCase46ArtifactUi(h.input);
  assert.deepEqual(h.counts(), { writes: 1, downloads: 2, reloads: 1 });
  assert.equal(outcome.evidence.status, 'UI_SUBSTEP_ONLY');
  assert.equal(outcome.evidence.liveAcceptance, 'NOT_RUN');
  assert.equal(outcome.evidence.rounds.length, 2);
  assert.equal(h.input.artifactStorage.readBytes('case46-initial.txt').toString(), 'Synthetic Aster briefing v1\n');
  await assert.rejects(collectCase46ArtifactUi(h.input));
  assert.equal(h.counts().writes, 1);
});

test('ambiguous approval preserves the one-shot claim and cannot resend', { skip: !enabled }, async () => {
  const h = harness({ ambiguous: true });
  await assert.rejects(collectCase46ArtifactUi(h.input), /STOPPED_NO_RETRY/u);
  const stopped = JSON.parse(h.input.artifactStorage.readBytes('case46-ui-stopped.json'));
  assert.equal(stopped.approvalRequests, 1);
  assert.equal(stopped.status, 'RECONCILIATION_REQUIRED');
  await assert.rejects(collectCase46ArtifactUi(h.input));
  assert.equal(h.counts().writes, 1);
});

test('HTTP scope and current source failures stop before any approval', { skip: !enabled }, async () => {
  for (const option of [{ foreignApproval: true }, { wrongSource: true }]) {
    const h = harness(option);
    await assert.rejects(collectCase46ArtifactUi(h.input));
    assert.equal(h.counts().writes, 0);
  }
});
