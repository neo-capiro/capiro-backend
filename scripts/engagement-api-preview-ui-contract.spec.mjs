#!/usr/bin/env node
/**
 * Tests for the Outreach V3 preview probe manifest.
 *
 * The committed fixture is the artifact under test, checked against the
 * committed capability manifest it was built from. Negative controls mutate a
 * deep copy so the verifier is proven to reject them, not merely to exist.
 *
 * Run: node scripts/engagement-api-preview-ui-contract.spec.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProbeManifest, verifyProbeManifest } from './engagement-api-preview-ui-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'apps/api/src/engagement/__fixtures__');
const CAPABILITY_MANIFEST_PATH = path.join(FIXTURES, 'outreach-v3-ui-api-capability-manifest.v1.json');
const PROBE_MANIFEST_PATH = path.join(FIXTURES, 'outreach-v3-preview-probe-manifest.v1.json');

const capabilityManifest = JSON.parse(readFileSync(CAPABILITY_MANIFEST_PATH, 'utf8'));
const probeManifest = JSON.parse(readFileSync(PROBE_MANIFEST_PATH, 'utf8'));

const clone = (value) => JSON.parse(JSON.stringify(value));
const probeFor = (manifest, stateId) => {
  const probe = manifest.probes.find((p) => p.stateId === stateId);
  if (!probe) throw new Error(`fixture is missing the "${stateId}" probe`);
  return probe;
};

// ───────────────────────────────────────────────────────────── committed fixture

test('the committed probe manifest is exactly what the builder generates', () => {
  const generated = buildProbeManifest(capabilityManifest);
  assert.deepEqual(generated, probeManifest);
});

test('the committed probe manifest passes every invariant', () => {
  assert.deepEqual(verifyProbeManifest(probeManifest, capabilityManifest), []);
});

// ─────────────────────────────────────── required test: every entry classified

test('every capability manifest entry receives a probe classification', () => {
  assert.equal(probeManifest.probes.length, capabilityManifest.entries.length);
  assert.equal(probeManifest.probes.length, 62);
  for (const entry of capabilityManifest.entries) {
    const probe = probeFor(probeManifest, entry.stateId);
    assert.ok(probeManifest.probeClasses.includes(probe.probeClass));
  }
});

// ──────────────────────────────────────────────── required test: no unsafe send

test('no generation or send action is ever a safe probe', () => {
  const externalActions = capabilityManifest.entries.filter(
    (e) => e.capabilityClass === 'external_action_blocked_in_shadow',
  );
  assert.ok(externalActions.length > 0, 'fixture drift: no external action states to check');
  for (const entry of externalActions) {
    const probe = probeFor(probeManifest, entry.stateId);
    assert.equal(probe.probeClass, 'shadow_denial_probe');
    assert.notEqual(probe.probeClass, 'safe_read_get_probe');
    assert.notEqual(probe.probeClass, 'safe_local_write_probe');
  }
});

test('the GET route that actually generates is a shadow denial, not a safe read', () => {
  const probe = probeFor(probeManifest, 'representative-samples');
  const previewRoute = probe.routeProbes.find((r) => r.path.includes('ai-templates'));
  assert.ok(previewRoute, 'the generating GET route is missing from the probe');
  assert.equal(previewRoute.method, 'GET');
  assert.equal(previewRoute.expectedShadowStatus, 503);
  assert.equal(previewRoute.expectedShadowBody, 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED');
});

test('every shadow denial probe expects 503, the exact body, and the service header', () => {
  const denials = probeManifest.probes.filter((p) => p.probeClass === 'shadow_denial_probe');
  assert.equal(denials.length, 5);
  for (const probe of denials) {
    assert.ok(probe.routeProbes.length > 0);
    for (const route of probe.routeProbes) {
      assert.equal(route.expectedShadowStatus, 503);
      assert.equal(route.expectedShadowBody, 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED');
      assert.equal(route.expectedServiceHeader, 'engagement-api');
      assert.equal(route.assertNoQueuedWork, true);
      assert.equal(route.assertNoProviderCall, true);
    }
  }
});

// ────────────────────────────────────────── required test: nothing silently skipped

test('no unavailable route is silently skipped — every gapped state carries a non-probing classification', () => {
  const gapped = capabilityManifest.entries.filter((e) => e.currentRouteRefs.length === 0);
  assert.ok(gapped.length > 0);
  for (const entry of gapped) {
    const probe = probeFor(probeManifest, entry.stateId);
    assert.equal(probe.routeProbes.length, 0);
    assert.ok(
      ['future_phase_assertion', 'prototype_only_assertion', 'not_called_assertion'].includes(
        probe.probeClass,
      ),
      `${entry.stateId} has no route but was classified ${probe.probeClass}`,
    );
  }
});

test('every safe-read state keeps every one of its routes as a probe', () => {
  const safeReads = capabilityManifest.entries.filter((e) => e.capabilityClass === 'safe_read');
  for (const entry of safeReads) {
    const probe = probeFor(probeManifest, entry.stateId);
    assert.equal(probe.routeProbes.length, entry.currentRouteRefs.length);
  }
});

// ──────────────────────────────────────────────── required test: redaction

test('sensitive values are redacted — no email or bearer token anywhere in the manifest', () => {
  const serialized = JSON.stringify(probeManifest);
  assert.doesNotMatch(serialized, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  assert.doesNotMatch(serialized, /Bearer\s+[A-Za-z0-9._-]{10,}/);
});

// ────────────────────────────────────── required test: checksums appear in results

test('the prototype checksum and capability manifest checksum both appear in the manifest', () => {
  assert.match(probeManifest.prototypeSha256, /^[0-9a-f]{64}$/);
  assert.equal(probeManifest.prototypeSha256, capabilityManifest.prototypeSha256);
  assert.match(probeManifest.capabilityManifestSha256, /^[0-9a-f]{64}$/);
});

// ──────────────────────────────────── required test: auth parity is required by design

test('every safe-read route probe requires main/preview auth and tenant parity', () => {
  const safeProbes = probeManifest.probes.filter((p) => p.probeClass === 'safe_read_get_probe');
  assert.ok(safeProbes.length > 0);
  for (const probe of safeProbes) {
    for (const route of probe.routeProbes) {
      assert.equal(route.authParityRequired, true, `${probe.stateId} route ${route.path} skips auth parity`);
    }
  }
});

// ───────────────────────────────────── required test: current web sends no header

test('the current web sends no preview header — regression guard', () => {
  const webSrc = path.join(ROOT, 'apps', 'web', 'src');
  const scan = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (scan(full)) return true;
      } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) {
        if (readFileSync(full, 'utf8').includes('X-Capiro-Engagement-Preview')) return true;
      }
    }
    return false;
  };
  assert.equal(scan(webSrc), false);
});

// ──────────────────────────────────────────────── the required prototype report

test('the report distinguishes safe backend support, prototype-only, and future-phase work', () => {
  const { report } = probeManifest;
  assert.ok(report.safeBackendSupportedStates.length > 0);
  assert.ok(report.prototypeOnlyStates.length > 0);
  assert.ok(Object.keys(report.futurePhaseWork).length > 0);
  assert.ok(report.blockedActionStates.length > 0);
  assert.ok(report.cannotYetRenderStates.length > 0);

  // No state appears as both currently supported and unrenderable.
  const supported = new Set(report.safeBackendSupportedStates);
  for (const stateId of report.cannotYetRenderStates) {
    assert.ok(!supported.has(stateId), `${stateId} is both supported and unrenderable`);
  }
});

test('every future-phase-work entry is attributed to a real phase owner', () => {
  for (const [phase, states] of Object.entries(probeManifest.report.futurePhaseWork)) {
    assert.match(phase, /^phase_(3|5|6|7|8|9|11)$/);
    assert.ok(states.length > 0);
  }
});

test('fixture requirements are carried through from the capability manifest', () => {
  const withFixtures = capabilityManifest.entries.filter((e) => (e.fixtureRequirements ?? []).length > 0);
  assert.ok(withFixtures.length > 0);
  for (const entry of withFixtures) {
    assert.deepEqual(
      probeManifest.report.fixtureRequirementsByState[entry.stateId],
      entry.fixtureRequirements,
    );
  }
});

// ──────────────────────────────────────────────────────── the required boundary

test('no report field claims a state is implemented rather than merely probed', () => {
  const serialized = JSON.stringify(probeManifest).toLowerCase();
  assert.doesNotMatch(serialized, /"implemented":\s*true/);
  assert.match(probeManifest.note, /no probe here implies outreach v3 is implemented/i);
  assert.match(probeManifest.note, /no probe renders or ships the prototype/i);
});

// ─────────────────────────────────────────────────────────── negative controls

test('NC-2.12-A classifying a shadow-denied state as a safe probe is rejected', () => {
  const mutated = clone(probeManifest);
  const probe = mutated.probes.find((p) => p.stateId === 'sending-the-campaign');
  probe.probeClass = 'safe_read_get_probe';
  for (const route of probe.routeProbes) {
    route.expectedShadowStatus = null;
    route.expectedShadowBody = null;
  }

  const failures = verifyProbeManifest(mutated, capabilityManifest);
  assert.ok(failures.length > 0);
  assert.ok(failures.some((f) => /is an external action but is classified "safe_read_get_probe"/.test(f)));
});

test('NC-2.12-B skipping a prototype state is rejected', () => {
  const mutated = clone(probeManifest);
  mutated.probes = mutated.probes.filter((p) => p.stateId !== 'target-profile');

  const failures = verifyProbeManifest(mutated, capabilityManifest);
  assert.ok(failures.some((f) => /"target-profile" has no probe — a state was skipped/.test(f)));
});

test('NC-2.12-C a target-specific probe with target scope removed is rejected', () => {
  const mutated = clone(probeManifest);
  const probe = mutated.probes.find((p) => p.stateId === 'target-profile');
  probe.sensitiveScopes = probe.sensitiveScopes.filter((s) => s !== 'target');

  const failures = verifyProbeManifest(mutated, capabilityManifest);
  assert.ok(
    failures.some((f) => /"target-profile" dropped sensitive scope "target"/.test(f)),
    failures.join('\n'),
  );
});

test('a drifted prototype checksum is rejected', () => {
  const mutated = clone(probeManifest);
  mutated.prototypeSha256 = '0'.repeat(64);
  const failures = verifyProbeManifest(mutated, capabilityManifest);
  assert.ok(failures.some((f) => /prototypeSha256 does not match/.test(f)));
});

test('an injected bearer-token-shaped value is rejected', () => {
  const mutated = clone(probeManifest);
  mutated.probes[0].debugToken = 'Bearer eyJhbGciOiJIUzI1NiJ9.fake.signature';
  const failures = verifyProbeManifest(mutated, capabilityManifest);
  assert.ok(failures.some((f) => /bearer-token-shaped/.test(f)));
});
