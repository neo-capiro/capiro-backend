#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isEngagementRequest,
  requestHasExactPreviewHeader,
  responseHasServiceIdentity,
  validateNetworkRecords,
} from './engagement-phase3-network-recorder.mjs';
import {
  compareNormalizedDom,
  normalizeDomSnapshot,
  normalizeVisibleText,
} from './engagement-phase3-dom-normalizer.mjs';

test('Engagement path matching is scoped to the API owner', () => {
  assert.equal(isEngagementRequest('http://127.0.0.1:4600/api/engagement/meetings'), true);
  assert.equal(isEngagementRequest('http://127.0.0.1:4600/api/engagement'), true);
  assert.equal(isEngagementRequest('http://127.0.0.1:4600/api/engagement-something'), false);
  assert.equal(isEngagementRequest('http://127.0.0.1:4600/api/capiro-admin/tenants'), false);
});

test('preview header and service identity are exact', () => {
  assert.equal(requestHasExactPreviewHeader({ headers: { 'X-Capiro-Engagement-Preview': 'v3' } }), true);
  assert.equal(requestHasExactPreviewHeader({ headers: { 'X-Capiro-Engagement-Preview': 'V3' } }), false);
  assert.equal(responseHasServiceIdentity({ responseHeaders: { 'x-capiro-service': 'engagement-api' } }), true);
  assert.equal(responseHasServiceIdentity({ responseHeaders: { 'x-capiro-service': 'api' } }), false);
});

test('network validator accepts the intended main/preview split', () => {
  const issues = validateNetworkRecords([
    {
      mode: 'main',
      method: 'GET',
      url: 'http://127.0.0.1:4600/api/engagement/meetings',
      headers: {},
      responseHeaders: {},
      status: 200,
    },
    {
      mode: 'preview',
      method: 'GET',
      url: 'http://127.0.0.1:4600/api/engagement/meetings',
      headers: { 'X-Capiro-Engagement-Preview': 'v3' },
      responseHeaders: { 'X-Capiro-Service': 'engagement-api' },
      status: 200,
    },
    {
      mode: 'preview',
      method: 'GET',
      url: 'http://127.0.0.1:4600/api/me',
      headers: {},
      responseHeaders: {},
      status: 200,
    },
  ]);
  assert.deepEqual(issues, []);
});

test('negative control: header leak to non-Engagement owner fails', () => {
  const issues = validateNetworkRecords([
    {
      mode: 'preview',
      method: 'GET',
      url: 'http://127.0.0.1:4600/api/me',
      headers: { 'X-Capiro-Engagement-Preview': 'v3' },
      responseHeaders: {},
      status: 200,
    },
  ]);
  assert.equal(issues.some((issue) => issue.includes('leaked')), true);
});

test('negative control: missing preview header fails', () => {
  const issues = validateNetworkRecords([
    {
      mode: 'preview',
      method: 'GET',
      url: 'http://127.0.0.1:4600/api/engagement/meetings',
      headers: {},
      responseHeaders: { 'X-Capiro-Service': 'engagement-api' },
      status: 200,
    },
  ]);
  assert.equal(issues.some((issue) => issue.includes('missed header')), true);
});

test('negative control: main service identity in preview fails on errors too', () => {
  const issues = validateNetworkRecords([
    {
      mode: 'preview',
      method: 'POST',
      url: 'http://127.0.0.1:4600/api/engagement/outreach/generate-batch',
      headers: { 'X-Capiro-Engagement-Preview': 'v3' },
      responseHeaders: { 'X-Capiro-Service': 'api' },
      status: 503,
    },
  ]);
  assert.equal(issues.some((issue) => issue.includes('service identity')), true);
});

test('DOM normalization removes only permitted dynamic identity', () => {
  const input = `
    <main><h1>Meetings 4</h1><p>2026-08-07T10:30:00.000Z</p>
    <aside class="engagement-preview-indicator">Engagement API preview — External actions are disabled<button>Turn off preview</button></aside>
    <div>Ready</div></main>`;
  const normalized = normalizeDomSnapshot(input);
  assert.match(normalized, /Meetings 4/);
  assert.match(normalized, /Ready/);
  assert.doesNotMatch(normalized, /Turn off preview/);
  assert.doesNotMatch(normalized, /Engagement API preview/);
  assert.match(normalized, /<ISO_INSTANT>/);
});

test('main and preview snapshots compare equal after indicator normalization', () => {
  const main = '<main><h1>Reports</h1><span>3 meetings</span></main>';
  const preview = '<main><h1>Reports</h1><span>3 meetings</span><aside class="engagement-preview-indicator">Engagement API preview — External actions are disabled<button>Turn off preview</button></aside></main>';
  assert.equal(compareNormalizedDom(main, preview).equal, true);
});

test('meaningful UI differences are not normalized away', () => {
  const result = compareNormalizedDom('<main>3 meetings</main>', '<main>4 meetings</main>');
  assert.equal(result.equal, false);
});

test('visible-text normalizer masks UUIDs but retains labels', () => {
  const text = normalizeVisibleText('Meeting e3000000-0000-4000-8000-000000080001 Ready');
  assert.equal(text.includes('Ready'), true);
  assert.equal(text.includes('<UUID>'), true);
});
