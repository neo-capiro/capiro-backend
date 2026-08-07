#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePhase3ProxyTarget, exactPreviewHeader, isEngagementProxyPath } from './engagement-phase3-local-proxy.mjs';

test('only Engagement paths are eligible for preview routing', () => {
  assert.equal(isEngagementProxyPath('/api/engagement/meetings'), true);
  assert.equal(isEngagementProxyPath('/api/engagement/meetings?from=x'), true);
  assert.equal(isEngagementProxyPath('/api/engagement'), true);
  assert.equal(isEngagementProxyPath('/api/engagement-something'), false);
  assert.equal(isEngagementProxyPath('/api/capiro-admin/tenants'), false);
});

test('preview header must be exact and case-sensitive in value', () => {
  assert.equal(exactPreviewHeader({ 'x-capiro-engagement-preview': 'v3' }), true);
  assert.equal(exactPreviewHeader({ 'x-capiro-engagement-preview': 'V3' }), false);
  assert.equal(exactPreviewHeader({ 'x-capiro-engagement-preview': 'v2' }), false);
  assert.equal(exactPreviewHeader({ 'x-capiro-engagement-preview': 'v3, v2' }), false);
  assert.equal(exactPreviewHeader({}), false);
});

test('exact preview Engagement request routes to engagement-api', () => {
  assert.deepEqual(
    choosePhase3ProxyTarget({
      url: '/api/engagement/meetings',
      headers: { 'x-capiro-engagement-preview': 'v3' },
    }),
    { owner: 'engagement-api', port: 4500 },
  );
});

test('normal Engagement request stays on main', () => {
  assert.deepEqual(
    choosePhase3ProxyTarget({ url: '/api/engagement/meetings', headers: {} }),
    { owner: 'main-api', port: 4000 },
  );
});

test('negative control: preview header on non-Engagement owner stays on main', () => {
  assert.deepEqual(
    choosePhase3ProxyTarget({
      url: '/api/capiro-admin/tenants',
      headers: { 'x-capiro-engagement-preview': 'v3' },
    }),
    { owner: 'main-api', port: 4000 },
  );
});

test('negative control: conflicting duplicate value fails closed to main', () => {
  assert.deepEqual(
    choosePhase3ProxyTarget({
      url: '/api/engagement/meetings',
      headers: { 'x-capiro-engagement-preview': 'v3, v2' },
    }),
    { owner: 'main-api', port: 4000 },
  );
});
