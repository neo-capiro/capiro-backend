#!/usr/bin/env node
/**
 * Outreach V3 preview probe manifest (schema version 1).
 *
 * Turns every entry in the accepted 2.2 UI/API capability manifest into
 * exactly one preview-acceptance probe classification, so the live harness in
 * apps/api/scripts/engagement-phase2-preview-parity.ts has a single source of
 * truth for what to call, what to expect, and what to assert instead.
 *
 * This module is pure JS with no NestJS dependency, because it needs none:
 * every fact it needs (capabilityClass, shadowExpectation, sensitiveScopes,
 * currentRouteRefs) is already in the committed 2.2 manifest. It reads two
 * JSON files and writes a third.
 *
 * Every probe resolves to one of six classes:
 *   safe_read_get_probe        - safe GET, compared against main
 *   safe_local_write_probe     - safe local write (none exist yet; schema-ready)
 *   shadow_denial_probe        - must return 503 ENGAGEMENT_EXTERNAL_ACTION_DISABLED
 *   not_called_assertion       - no route exists; assert nothing is called
 *   future_phase_assertion     - not implemented yet; assert nothing is called
 *   prototype_only_assertion   - prototype-only visual/scenario state
 *
 * Nothing here claims Outreach V3 is implemented. Nothing here renders or
 * ships the prototype from production web.
 *
 * Usage:
 *   node scripts/engagement-api-preview-ui-contract.mjs --write
 *   node scripts/engagement-api-preview-ui-contract.mjs --check <probe-manifest.json>
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'apps/api/src/engagement/__fixtures__');
const CAPABILITY_MANIFEST = path.join(FIXTURES, 'outreach-v3-ui-api-capability-manifest.v1.json');
const PROBE_MANIFEST = path.join(FIXTURES, 'outreach-v3-preview-probe-manifest.v1.json');

export class PreviewProbeError extends Error {}
function fail(message) {
  throw new PreviewProbeError(message);
}

const CAPABILITY_TO_PROBE_CLASS = {
  safe_read: 'safe_read_get_probe',
  safe_local_write: 'safe_local_write_probe',
  external_action_blocked_in_shadow: 'shadow_denial_probe',
  future_phase_not_implemented: 'future_phase_assertion',
  prototype_only: 'prototype_only_assertion',
  // No prototype state currently resolves here; the current UI (not the
  // preview route) serves it, so there is nothing for THIS harness to call.
  current_ui_only: 'not_called_assertion',
};

const PROBE_CLASSES = [...new Set(Object.values(CAPABILITY_TO_PROBE_CLASS))];

function parseRoute(ref) {
  const [method, ...rest] = ref.split(' ');
  return { method, path: rest.join(' ') };
}

/** Build one probe entry for one capability manifest entry. */
function buildProbe(entry) {
  const probeClass = CAPABILITY_TO_PROBE_CLASS[entry.capabilityClass];
  if (!probeClass) fail(`entry "${entry.stateId}" has unknown capabilityClass "${entry.capabilityClass}"`);

  const routeProbes = entry.currentRouteRefs.map((ref) => {
    const { method, path: routePath } = parseRoute(ref);
    if (probeClass === 'shadow_denial_probe') {
      return {
        method,
        path: routePath,
        expectedShadowStatus: 503,
        expectedShadowBody: 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED',
        expectedServiceHeader: 'engagement-api',
        authParityRequired: false,
        assertNoQueuedWork: true,
        assertNoProviderCall: true,
      };
    }
    if (probeClass === 'safe_read_get_probe' || probeClass === 'safe_local_write_probe') {
      return {
        method,
        path: routePath,
        expectedShadowStatus: null, // must equal whatever the main API returns
        expectedShadowBody: null,
        expectedServiceHeader: 'engagement-api',
        authParityRequired: true,
        assertNoQueuedWork: false,
        assertNoProviderCall: false,
      };
    }
    fail(`entry "${entry.stateId}" is ${probeClass} but declares a route (${ref})`);
    return null;
  });

  if (
    (probeClass === 'not_called_assertion' ||
      probeClass === 'future_phase_assertion' ||
      probeClass === 'prototype_only_assertion') &&
    routeProbes.length > 0
  ) {
    fail(`entry "${entry.stateId}" is ${probeClass} but has route probes`);
  }

  return {
    stateId: entry.stateId,
    stateLabel: entry.stateLabel,
    visibleStage: entry.visibleStage,
    probeClass,
    routeProbes,
    sensitiveScopes: [...entry.sensitiveScopes].sort(),
    futureOwner: entry.futureOwner,
    fixtureRequirements: entry.fixtureRequirements ?? [],
    gap: entry.gap ?? null,
  };
}

/** The aggregate report the plan requires: coverage, gaps, and ownership. */
function buildReport(probes) {
  const byClass = (cls) => probes.filter((p) => p.probeClass === cls).map((p) => p.stateId);

  const futurePhaseWork = {};
  for (const probe of probes) {
    if (probe.probeClass !== 'future_phase_assertion') continue;
    (futurePhaseWork[probe.futureOwner] ??= []).push(probe.stateId);
  }

  const fixtureRequirementsByState = Object.fromEntries(
    probes
      .filter((p) => (p.fixtureRequirements ?? []).length > 0)
      .map((p) => [p.stateId, p.fixtureRequirements]),
  );

  return {
    // Which of the 22 primary states (and the other 40) have current safe
    // backend support right now.
    safeBackendSupportedStates: [
      ...byClass('safe_read_get_probe'),
      ...byClass('safe_local_write_probe'),
    ].sort(),
    // Which are prototype-only — a visual/scenario contract with no backend
    // capability at all.
    prototypeOnlyStates: byClass('prototype_only_assertion').sort(),
    // Which future phase owns each not-yet-implemented state.
    futurePhaseWork,
    // Which actions are intentionally blocked in Phase 2.
    blockedActionStates: byClass('shadow_denial_probe').sort(),
    // Which fixture shapes Phase 3 must create (from the capability manifest,
    // carried through unchanged).
    fixtureRequirementsByState,
    // Which UI states cannot yet be rendered against a real backend: nothing
    // implemented and nothing servable through the preview route.
    cannotYetRenderStates: [
      ...byClass('future_phase_assertion'),
      ...byClass('prototype_only_assertion'),
      ...byClass('not_called_assertion'),
    ].sort(),
  };
}

export function buildProbeManifest(capabilityManifest) {
  const probes = capabilityManifest.entries.map(buildProbe);
  return {
    schemaVersion: 1,
    prototypeSha256: capabilityManifest.prototypeSha256,
    capabilityManifestSha256: sha256(JSON.stringify(capabilityManifest)),
    extractedAt: null,
    phase: 2,
    note:
      'Every Outreach V3 prototype state resolves to exactly one preview-acceptance ' +
      'probe classification. No probe here implies Outreach V3 is implemented in ' +
      'production, and no probe renders or ships the prototype from production web. ' +
      'Phase 3 owns rendering the exact current Engagement UI through preview; ' +
      'Phase 5-9 own Outreach V3 implementation.',
    probeClasses: PROBE_CLASSES,
    probes,
    report: buildReport(probes),
  };
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Verify the probe manifest. Returns every failure so a bad manifest is fixed
 * in one pass; fails closed on anything unexpected rather than skipping it.
 */
export function verifyProbeManifest(probeManifest, capabilityManifest) {
  const failures = [];
  const fail = (message) => failures.push(message);

  if (probeManifest.prototypeSha256 !== capabilityManifest.prototypeSha256) {
    fail('probe manifest prototypeSha256 does not match the capability manifest');
  }

  const byState = new Map(probeManifest.probes.map((p) => [p.stateId, p]));
  const capByState = new Map(capabilityManifest.entries.map((e) => [e.stateId, e]));

  // Every capability manifest entry receives a probe classification. No
  // unavailable route is silently skipped: absence itself must be a failure.
  for (const entry of capabilityManifest.entries) {
    const probe = byState.get(entry.stateId);
    if (!probe) {
      fail(`state "${entry.stateId}" has no probe — a state was skipped`);
      continue;
    }
    if (!probe.probeClass || !PROBE_CLASSES.includes(probe.probeClass)) {
      fail(`state "${entry.stateId}" has no valid probe classification`);
    }
  }
  for (const probe of probeManifest.probes) {
    if (!capByState.has(probe.stateId)) {
      fail(`probe "${probe.stateId}" does not match any capability manifest state`);
    }
  }
  if (probeManifest.probes.length !== capabilityManifest.entries.length) {
    fail(
      `probe count ${probeManifest.probes.length} does not match capability entry count ` +
        `${capabilityManifest.entries.length}`,
    );
  }

  for (const probe of probeManifest.probes) {
    const entry = capByState.get(probe.stateId);
    if (!entry) continue;
    const where = `probe "${probe.stateId}"`;

    // No generation or send action may be a safe probe.
    if (entry.capabilityClass === 'external_action_blocked_in_shadow') {
      if (probe.probeClass !== 'shadow_denial_probe') {
        fail(`${where} is an external action but is classified "${probe.probeClass}", not shadow_denial_probe`);
      }
      for (const route of probe.routeProbes) {
        if (route.expectedShadowStatus !== 503) fail(`${where} shadow probe does not expect 503`);
        if (route.expectedShadowBody !== 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED') {
          fail(`${where} shadow probe does not expect ENGAGEMENT_EXTERNAL_ACTION_DISABLED`);
        }
        if (route.expectedServiceHeader !== 'engagement-api') {
          fail(`${where} shadow probe does not expect the X-Capiro-Service header`);
        }
      }
    }
    if (
      (probe.probeClass === 'safe_read_get_probe' || probe.probeClass === 'safe_local_write_probe') &&
      entry.capabilityClass === 'external_action_blocked_in_shadow'
    ) {
      fail(`${where} classifies an external action as a safe probe`);
    }

    // Sensitive scopes must be carried through unchanged (dropping one, e.g.
    // 'target', would let a scoped probe run without its authorization check).
    const entryScopes = [...entry.sensitiveScopes].sort();
    const probeScopes = [...probe.sensitiveScopes].sort();
    for (const scope of entryScopes) {
      if (!probeScopes.includes(scope)) {
        fail(`${where} dropped sensitive scope "${scope}" from the capability manifest`);
      }
    }

    // A route-bearing probe must actually carry route probes, and a routeless
    // classification must not silently invent one.
    const shouldHaveRoutes = probe.probeClass === 'safe_read_get_probe' || probe.probeClass === 'safe_local_write_probe' || probe.probeClass === 'shadow_denial_probe';
    if (shouldHaveRoutes && probe.routeProbes.length === 0 && entry.currentRouteRefs.length > 0) {
      fail(`${where} has routes in the capability manifest but none in the probe`);
    }
    if (!shouldHaveRoutes && probe.routeProbes.length > 0) {
      fail(`${where} is ${probe.probeClass} but declares route probes`);
    }

    if (!probe.futureOwner && probe.probeClass !== 'safe_read_get_probe' && probe.probeClass !== 'safe_local_write_probe' && probe.probeClass !== 'shadow_denial_probe') {
      // future_phase_assertion, prototype_only_assertion, not_called_assertion
      // all still carry a future owner from the capability manifest.
      if (entry.futureOwner && !probe.futureOwner) fail(`${where} dropped its future owner`);
    }
  }

  // No sensitive value (bearer token, email) may appear anywhere in the
  // manifest. Static route definitions should never contain one; this guards
  // against a future edit that pastes a live value in by mistake.
  const serialized = JSON.stringify(probeManifest);
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(serialized)) {
    fail('probe manifest contains an email-shaped string');
  }
  if (/Bearer\s+[A-Za-z0-9._-]{10,}/.test(serialized)) {
    fail('probe manifest contains a bearer-token-shaped string');
  }

  return failures;
}

// ─────────────────────────────────────────────────────────────────── CLI

function main(argv) {
  const write = argv.includes('--write');
  const checkIndex = argv.indexOf('--check');
  const checkFile = checkIndex >= 0 ? argv[checkIndex + 1] : null;

  const capabilityManifest = JSON.parse(readFileSync(CAPABILITY_MANIFEST, 'utf8'));
  const manifest = buildProbeManifest(capabilityManifest);
  const failures = verifyProbeManifest(manifest, capabilityManifest);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL  ${failure}`);
    console.error(`\nENGAGEMENT_PREVIEW_PROBE_FAILED (${failures.length} failure(s))`);
    process.exit(1);
  }

  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (checkFile) {
    const current = readFileSync(checkFile, 'utf8');
    if (current !== serialized) {
      console.error('FAIL  preview probe manifest is stale; re-run with --write and review the diff');
      process.exit(1);
    }
    console.log(`OK  ${checkFile} matches the current capability manifest`);
    return;
  }
  if (write) {
    writeFileSync(PROBE_MANIFEST, serialized);
    console.log(`Wrote ${path.relative(ROOT, PROBE_MANIFEST)}`);
  } else {
    process.stdout.write(serialized);
  }

  const counts = manifest.probes.reduce((acc, p) => {
    acc[p.probeClass] = (acc[p.probeClass] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\nProbes: ${manifest.probes.length}`);
  for (const key of Object.keys(counts).sort()) console.log(`  ${key}: ${counts[key]}`);
  console.log('\nENGAGEMENT_PREVIEW_PROBE_VERIFIED');
}

const isEntrypoint = process.argv[1]?.endsWith('engagement-api-preview-ui-contract.mjs');
if (isEntrypoint) main(process.argv.slice(2));
