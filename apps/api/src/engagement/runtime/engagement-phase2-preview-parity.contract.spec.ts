import { describe, expect, it } from '@jest/globals';
import {
  normalizeResponseBody,
  type ProbeManifestContract,
  type ResponseSnapshot,
  validateMissingAuthSnapshots,
  validateProbeManifestContract,
  validateSafeReadSnapshots,
  validateShadowDenialSnapshot,
} from './engagement-phase2-preview-parity.contract.js';

const SHA = 'a'.repeat(40);

function response(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): ResponseSnapshot {
  return { status, bodyText, headers };
}

function previewHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'x-capiro-service': 'engagement-api',
    'x-capiro-release-sha': SHA,
    ...extra,
  };
}

describe('Phase 2 preview parity contract', () => {
  it.each([401, 404, 500])('rejects matching %s/%s safe-read responses', (status) => {
    const result = validateSafeReadSnapshots({
      main: response(status, '{}'),
      preview: response(status, '{}', previewHeaders()),
      expectedServiceHeader: 'engagement-api',
      expectedReleaseSha: SHA,
      tenantAssertionText: 'tenant-marker',
    });
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures.join(' ')).toContain('expected 2xx');
  });

  it('accepts byte-equivalent JSON with different object-key order', () => {
    const result = validateSafeReadSnapshots({
      main: response(200, '{"tenant":"tenant-marker","nested":{"b":2,"a":1}}'),
      preview: response(
        200,
        '{"nested":{"a":1,"b":2},"tenant":"tenant-marker"}',
        previewHeaders(),
      ),
      expectedServiceHeader: 'engagement-api',
      expectedReleaseSha: SHA,
      tenantAssertionText: 'tenant-marker',
    });
    expect(result.failures).toEqual([]);
    expect(result.mainBodyHash).toBe(result.previewBodyHash);
    expect(result.tenantAssertionMatched).toBe(true);
  });

  it('rejects different authenticated response bodies', () => {
    const result = validateSafeReadSnapshots({
      main: response(200, '{"value":1,"tenant":"tenant-marker"}'),
      preview: response(200, '{"value":2,"tenant":"tenant-marker"}', previewHeaders()),
      expectedServiceHeader: 'engagement-api',
      expectedReleaseSha: SHA,
      tenantAssertionText: 'tenant-marker',
    });
    expect(result.failures).toContain('normalized authenticated response bodies differ');
  });

  it('rejects a missing or drifted release SHA', () => {
    for (const release of [undefined, 'b'.repeat(40)]) {
      const result = validateSafeReadSnapshots({
        main: response(200, '{"tenant":"tenant-marker"}'),
        preview: response(200, '{"tenant":"tenant-marker"}', {
          'x-capiro-service': 'engagement-api',
          ...(release ? { 'x-capiro-release-sha': release } : {}),
        }),
        expectedServiceHeader: 'engagement-api',
        expectedReleaseSha: SHA,
        tenantAssertionText: 'tenant-marker',
      });
      expect(result.failures.join(' ')).toContain('X-Capiro-Release-Sha');
    }
  });

  it('requires missing-auth parity to be a real 401/403 denial', () => {
    expect(
      validateMissingAuthSnapshots({
        main: response(404, '{}'),
        preview: response(404, '{}', previewHeaders()),
        expectedServiceHeader: 'engagement-api',
        expectedReleaseSha: SHA,
      }).failures.length,
    ).toBeGreaterThan(0);

    expect(
      validateMissingAuthSnapshots({
        main: response(401, '{}'),
        preview: response(401, '{}', previewHeaders()),
        expectedServiceHeader: 'engagement-api',
        expectedReleaseSha: SHA,
      }).failures,
    ).toEqual([]);
  });

  it('requires the route-guard boundary before claiming no work/provider call', () => {
    const route = {
      method: 'POST',
      path: '/api/engagement/outreach/send-batch',
      expectedShadowStatus: 503,
      expectedShadowBody: 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED',
      expectedServiceHeader: 'engagement-api',
      authParityRequired: false,
      assertNoQueuedWork: true,
      assertNoProviderCall: true,
    };

    const missingBoundary = validateShadowDenialSnapshot({
      preview: response(503, '{"code":"ENGAGEMENT_EXTERNAL_ACTION_DISABLED"}', previewHeaders()),
      route,
      expectedServiceHeader: 'engagement-api',
      expectedReleaseSha: SHA,
    });
    expect(missingBoundary.failures.join(' ')).toContain('denial boundary');
    expect(missingBoundary.noQueuedWorkProven).toBe(false);
    expect(missingBoundary.noProviderCallProven).toBe(false);

    const proven = validateShadowDenialSnapshot({
      preview: response(
        503,
        '{"code":"ENGAGEMENT_EXTERNAL_ACTION_DISABLED"}',
        previewHeaders({ 'x-capiro-engagement-denial-boundary': 'route-guard' }),
      ),
      route,
      expectedServiceHeader: 'engagement-api',
      expectedReleaseSha: SHA,
    });
    expect(proven.failures).toEqual([]);
    expect(proven.noQueuedWorkProven).toBe(true);
    expect(proven.noProviderCallProven).toBe(true);
  });

  it('rejects a shadow-denial manifest entry that does not assert both invariants', () => {
    const manifest: ProbeManifestContract = {
      schemaVersion: 1,
      prototypeSha256: 'b'.repeat(64),
      probeClasses: ['shadow_denial_probe'],
      probes: Array.from({ length: 62 }, (_, index) => ({
        stateId: `state-${index}`,
        probeClass: 'shadow_denial_probe',
        routeProbes: [
          {
            method: 'POST',
            path: `/route-${index}`,
            expectedShadowStatus: 503,
            expectedShadowBody: 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED',
            expectedServiceHeader: 'engagement-api',
            authParityRequired: false,
            assertNoQueuedWork: index !== 0,
            assertNoProviderCall: index !== 1,
          },
        ],
      })),
    };
    const result = validateProbeManifestContract(manifest);
    expect(result.failures.some((failure) => failure.includes('does not assert no queued work'))).toBe(
      true,
    );
    expect(result.failures.some((failure) => failure.includes('does not assert no provider call'))).toBe(
      true,
    );
  });

  it('normalizes JSON recursively without rewriting array order', () => {
    expect(normalizeResponseBody('{"b":2,"a":[{"d":4,"c":3},1]}')).toBe(
      '{"a":[{"c":3,"d":4},1],"b":2}',
    );
  });
});
