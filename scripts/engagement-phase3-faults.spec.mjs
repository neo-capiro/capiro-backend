#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPhase3FaultController,
  faultMatchesRequest,
  phase3FaultJsonBody,
} from './engagement-phase3-faults.mjs';

test('fault matching is exact by owner, method, and pathname', () => {
  const fault = {
    id: 'preview-503',
    action: 'respond',
    owner: 'engagement-api',
    method: 'GET',
    pathname: '/api/engagement/meetings',
    status: 503,
  };
  assert.equal(
    faultMatchesRequest(fault, {
      owner: 'engagement-api',
      method: 'GET',
      url: '/api/engagement/meetings?clientId=x',
    }),
    true,
  );
  assert.equal(
    faultMatchesRequest(fault, {
      owner: 'main-api',
      method: 'GET',
      url: '/api/engagement/meetings',
    }),
    false,
  );
  assert.equal(
    faultMatchesRequest(fault, {
      owner: 'engagement-api',
      method: 'POST',
      url: '/api/engagement/meetings',
    }),
    false,
  );
  assert.equal(
    faultMatchesRequest(fault, {
      owner: 'engagement-api',
      method: 'GET',
      url: '/api/engagement/meetings/library',
    }),
    false,
  );
});

test('one-shot faults are consumed and every hit is recorded', () => {
  const controller = createPhase3FaultController();
  controller.arm({
    id: 'once',
    action: 'respond',
    owner: 'main-api',
    method: 'GET',
    pathname: '/api/engagement/meetings',
    status: 500,
  });
  const request = {
    owner: 'main-api',
    method: 'GET',
    url: '/api/engagement/meetings',
  };
  assert.equal(controller.match(request)?.id, 'once');
  assert.equal(controller.match(request), null);
  assert.deepEqual(controller.snapshot(), {
    armed: [],
    hits: [
      {
        id: 'once',
        owner: 'main-api',
        method: 'GET',
        pathname: '/api/engagement/meetings',
      },
    ],
  });
});

test('negative controls reject duplicate ids and invalid fault contracts', () => {
  const controller = createPhase3FaultController([
    { id: 'stable', action: 'reset', pathname: '/api/engagement/meetings' },
  ]);
  assert.throws(
    () => controller.arm({ id: 'stable', action: 'respond', status: 500 }),
    /already armed/,
  );
  assert.throws(() => controller.arm({ id: 'bad', action: 'unknown' }), /Unsupported/);
  assert.throws(
    () => controller.arm({ id: 'bad-status', action: 'respond', status: 99 }),
    /HTTP status/,
  );
  assert.throws(
    () => controller.arm({ id: 'bad-path', action: 'reset', pathname: 'relative' }),
    /absolute/,
  );
});

test('generated fault bodies are deterministic and never contain auth material', () => {
  const body = phase3FaultJsonBody({ id: 'ordinary-503', status: 503, body: null });
  assert.deepEqual(JSON.parse(body), {
    statusCode: 503,
    code: 'ENGAGEMENT_PHASE3_FAULT_ORDINARY_503',
    message: 'Phase 3 injected fault: ordinary-503',
  });
  assert.doesNotMatch(body, /Bearer|cookie|token/i);
});
