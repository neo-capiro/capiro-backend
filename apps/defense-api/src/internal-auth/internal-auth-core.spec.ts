import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalInternalAuthPayload,
  sha256Hex,
  signInternalRequest,
  verifyInternalRequest,
} from './internal-auth-core.ts';

const secret = '0123456789abcdef0123456789abcdef';
const claims = {
  caller: 'meri-orchestrator',
  timestamp: '2026-08-17T16:00:00.000Z',
  nonce: 'nonce-123',
  method: 'post',
  pathWithQuery: '/api/internal/defense/program-elements?limit=2',
  contentSha256: sha256Hex('{"q":"robotics"}'),
};

test('canonical payload is stable and newline-delimited', () => {
  assert.equal(
    canonicalInternalAuthPayload(claims),
    [
      'capiro-internal-v1',
      'meri-orchestrator',
      '2026-08-17T16:00:00.000Z',
      'nonce-123',
      'POST',
      '/api/internal/defense/program-elements?limit=2',
      claims.contentSha256,
    ].join('\n'),
  );
});

test('valid signature verifies', () => {
  const signature = signInternalRequest(claims, secret);
  assert.deepEqual(
    verifyInternalRequest({
      ...claims,
      signature,
      secret,
      maxSkewSeconds: 60,
      nowMs: Date.parse(claims.timestamp) + 30_000,
    }),
    {
      ok: true,
      signedPayload: canonicalInternalAuthPayload(claims),
    },
  );
});

test('tamper and stale timestamp fail closed', () => {
  const signature = signInternalRequest(claims, secret);
  const tampered = verifyInternalRequest({
    ...claims,
    method: 'GET',
    signature,
    secret,
    maxSkewSeconds: 60,
    nowMs: Date.parse(claims.timestamp),
  });
  assert.deepEqual(tampered, { ok: false, reason: 'signature_mismatch' });

  const stale = verifyInternalRequest({
    ...claims,
    signature,
    secret,
    maxSkewSeconds: 60,
    nowMs: Date.parse(claims.timestamp) + 61_000,
  });
  assert.deepEqual(stale, { ok: false, reason: 'timestamp_outside_window' });
});
