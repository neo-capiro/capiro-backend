import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  createCase14ApprovalWriteGuard,
  inspectCase14WriteEvidence,
} from '../case14-approval-write-guard.mjs';
const origin = 'https://os.capiro.ai',
  preference = '/api/clio/vnext/preferences';
const candidate = '11111111-1111-4111-8111-111111111111';
const approval = `/api/memory/review/candidates/${candidate}/approve`;
const request = (method, path, body = '{}') => ({
  method: () => method,
  url: () => (path.startsWith('http') ? path : origin + path),
  postData: () => body,
});
const guard = () => {
  const value = createCase14ApprovalWriteGuard(candidate);
  value.panelPhase('initial');
  return value;
};

test('bounded preferences stay denied and one exact approval passes', () => {
  const g = guard();
  for (let n = 0; n < 3; n++) assert.equal(g.decide(request('PUT', preference)), 'abort');
  g.assertBeforeIntent();
  g.arm();
  assert.equal(g.decide(request('POST', approval)), 'continue');
  g.panelPhase('afterReload');
  for (let n = 0; n < 3; n++) assert.equal(g.decide(request('PUT', preference)), 'abort');
  assert.equal(inspectCase14WriteEvidence({ ...g.snapshot(), synthesisSubmissionCount: 0 }), true);
  assert.equal(g.decide(request('POST', approval)), 'abort');
  assert.equal(g.snapshot().applicationApprovalSubmissions, 1);
  assert.throws(() => g.arm());
});

test('unexpected writes reject before intent and after arming before dispatch', () => {
  for (const armFirst of [false, true]) {
    const g = guard();
    if (armFirst) g.arm();
    assert.equal(g.decide(request('POST', '/api/other')), 'abort');
    assert.throws(() => g.assertBeforeIntent());
    assert.equal(g.decide(request('POST', approval)), 'abort');
    assert.equal(g.snapshot().applicationApprovalSubmissions, 0);
  }
});

test('foreign, query, hash, method, outside-panel and excess preference writes reject', () => {
  for (const r of [
    request('PUT', 'https://foreign.invalid' + preference),
    request('PUT', preference + '?x=1'),
    request('PUT', preference + '#x'),
    request('POST', preference),
  ]) {
    const g = guard();
    assert.equal(g.decide(r), 'abort');
    assert.throws(() => g.arm());
  }
  for (const phase of ['outsidePanel', 'initial']) {
    const g = guard();
    g.panelPhase(phase);
    for (let n = 0; n < (phase === 'initial' ? 4 : 1); n++) g.decide(request('PUT', preference));
    assert.throws(() => g.assertBeforeIntent());
  }
});

test('wrong candidate, query and altered body cannot use the armed approval', () => {
  for (const r of [
    request('POST', approval + '?retry=1'),
    request('POST', approval, '{"extra":true}'),
    request('POST', approval.replace(candidate, '22222222-2222-4222-8222-222222222222')),
  ]) {
    const g = guard();
    g.arm();
    assert.equal(g.decide(r), 'abort');
    assert.equal(g.decide(request('POST', approval)), 'abort');
    assert.equal(g.snapshot().applicationApprovalSubmissions, 0);
  }
});

test('legacy zero accounting is strict; partial and malformed new accounting reject', () => {
  const e = { applicationApprovalSubmissions: 1, synthesisSubmissionCount: 0, blockedWrites: 0 };
  assert.equal(inspectCase14WriteEvidence(e), true);
  for (const change of [
    { blockedWrites: 1 },
    { blockedWrites: false },
    { blockedPreferenceWrites: 0 },
    { blockedWriteRequests: [] },
    { blockedPreferenceWrites: 1, blockedWriteRequests: [] },
  ])
    assert.throws(() => inspectCase14WriteEvidence({ ...e, ...change }));
});

test(
  'real Chromium route denies preferences and prevents approval after an unexpected write',
  { timeout: 20000 },
  async () => {
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      for (const unexpected of [false, true]) {
        const context = await browser.newContext({ serviceWorkers: 'block' }),
          page = await context.newPage(),
          g = guard();
        let approved = 0;
        await context.route('**/*', async (route) => {
          const r = route.request();
          if (g.decide(r) === 'abort') return route.abort();
          if (r.method() === 'POST') {
            approved++;
            return route.fulfill({ status: 200, body: '{}' });
          }
          return route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<button>Approve</button>',
          });
        });
        await page.goto(origin + '/meri/new');
        await page.evaluate(
          async ({ preference, unexpected }) => {
            await fetch(preference, { method: 'PUT', body: '{}' }).catch(() => {});
            if (unexpected)
              await fetch('/api/other', { method: 'POST', body: '{}' }).catch(() => {});
          },
          { preference, unexpected },
        );
        if (unexpected) assert.throws(() => g.arm());
        else g.arm();
        await page.evaluate(async (approval) => {
          await fetch(approval, { method: 'POST', body: '{}' }).catch(() => {});
        }, approval);
        assert.equal(approved, unexpected ? 0 : 1);
        assert.equal(g.snapshot().applicationApprovalSubmissions, unexpected ? 0 : 1);
        assert.equal(g.snapshot().blockedPreferenceWrites, 1);
        await context.close();
      }
    } finally {
      await browser.close();
    }
  },
);
