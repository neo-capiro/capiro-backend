/**
 * Outreach V3 UI-to-API capability matrix — invariants and negative controls.
 *
 * The committed manifest is the artifact under test. Every invariant the Phase 2
 * plan requires is asserted here, and each negative control mutates a deep copy
 * to prove the verifier rejects it rather than passing vacuously.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildCapabilityManifest,
  verifyCapabilityManifest,
  type CapabilityManifest,
  type PrototypeManifest,
  type RouteManifest,
  type UiCapabilityEntry,
} from './outreach-v3-ui-api-capability.js';

const FIXTURES = path.join(__dirname, '__fixtures__');
const read = (file: string) => JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8'));

const prototype: PrototypeManifest = read('outreach-v3-prototype-state-manifest.v1.json');
const routeManifest: RouteManifest = read('engagement-route-manifest.v1.json');
const committed: CapabilityManifest = read('outreach-v3-ui-api-capability-manifest.v1.json');

const clone = (manifest: CapabilityManifest): CapabilityManifest =>
  JSON.parse(JSON.stringify(manifest));

const entryFor = (manifest: CapabilityManifest, stateId: string): UiCapabilityEntry => {
  const entry = manifest.entries.find((candidate) => candidate.stateId === stateId);
  if (!entry) throw new Error(`fixture is missing the "${stateId}" entry`);
  return entry;
};

const STATE_BUCKETS = [
  'primaryFlowStates',
  'edgeStates',
  'loadingStates',
  'errorStates',
  'emptyStates',
  'systemStates',
] as const;

const prototypeStates = STATE_BUCKETS.flatMap(
  (bucket) => (prototype[bucket] as Array<{ id: string; label: string }>) ?? [],
);

describe('Outreach V3 UI-to-API capability matrix', () => {
  it('the committed manifest is exactly what the matrix generates', () => {
    const generated = buildCapabilityManifest(prototype, routeManifest);
    expect(generated).toEqual(committed);
  });

  it('the committed manifest passes every invariant', () => {
    expect(verifyCapabilityManifest(committed, prototype, routeManifest)).toEqual([]);
  });

  it('every prototype state has exactly one matrix entry', () => {
    expect(committed.entries).toHaveLength(prototypeStates.length);
    expect(prototypeStates).toHaveLength(62);
    for (const state of prototypeStates) {
      const matches = committed.entries.filter((entry) => entry.stateId === state.id);
      expect(matches).toHaveLength(1);
    }
  });

  it('every referenced route exists in the Phase 0 route manifest', () => {
    const known = new Set(routeManifest.routes.map((route) => `${route.method} ${route.path}`));
    for (const entry of committed.entries) {
      for (const ref of entry.currentRouteRefs) expect(known.has(ref)).toBe(true);
    }
  });

  it('no send or generation route is classified as a safe read', () => {
    const generationOrSend = /generate|send|talking-points|preview/;
    for (const entry of committed.entries) {
      if (entry.capabilityClass !== 'safe_read' && entry.capabilityClass !== 'safe_local_write') {
        continue;
      }
      for (const ref of entry.currentRouteRefs) {
        // A read of a send record is fine; invoking generation or delivery is not.
        const isMutatingCall = generationOrSend.test(ref) && !ref.startsWith('GET ');
        expect(isMutatingCall).toBe(false);
      }
    }
  });

  it('the generation and send states are shadow-blocked, never safe', () => {
    for (const stateId of [
      'representative-samples',
      'generating-samples',
      'generating-remaining-drafts',
      'sending-the-campaign',
      'preflight-partial-send-ready',
    ]) {
      const entry = entryFor(committed, stateId);
      expect(entry.capabilityClass).toBe('external_action_blocked_in_shadow');
      expect(entry.shadowExpectation).toBe('503_external_action_disabled');
    }
  });

  it('every state declares exactly one future owner', () => {
    for (const entry of committed.entries) {
      expect(entry.futureOwner).toMatch(/^phase_(3|5|6|7|8|9|11)$/);
    }
  });

  it('no entry claims V3 functionality is implemented', () => {
    for (const entry of committed.entries) {
      if (entry.currentRouteRefs.length === 0) expect(entry.gap).toBeTruthy();
      expect(entry.capabilityClass).not.toBe('current_ui_only');
    }
  });

  it('states with no current route are recorded as gaps, not invented routes', () => {
    const gapped = committed.entries.filter((entry) => entry.currentRouteRefs.length === 0);
    expect(gapped.length).toBeGreaterThan(0);
    for (const entry of gapped) {
      expect(entry.shadowExpectation === 'not_implemented' || entry.shadowExpectation === 'not_called').toBe(true);
    }
  });

  it('the Directory gap is recorded rather than mapped to an Engagement route', () => {
    for (const stateId of ['directory-search', 'expanded-office-with-staff', 'target-profile']) {
      const entry = entryFor(committed, stateId);
      expect(entry.currentRouteRefs).toEqual([]);
      expect(entry.gap).toContain('Directory');
    }
  });

  describe('negative controls', () => {
    it('NC-2.2-A rejects Send classified as a safe local write', () => {
      const mutated = clone(committed);
      const entry = entryFor(mutated, 'preflight-partial-send-ready');
      entry.capabilityClass = 'safe_local_write';
      entry.shadowExpectation = 'same_as_main';

      const failures = verifyCapabilityManifest(mutated, prototype, routeManifest);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.join('\n')).toMatch(/external action/i);
    });

    it('NC-2.2-B rejects Target profile with target scope removed', () => {
      const mutated = clone(committed);
      const entry = entryFor(mutated, 'target-profile');
      entry.sensitiveScopes = entry.sensitiveScopes.filter((scope) => scope !== 'target');

      const failures = verifyCapabilityManifest(mutated, prototype, routeManifest);
      expect(failures).toContain('entry "target-profile" is target-specific but does not declare target scope');
    });

    it('NC-2.2-C rejects a reference to a nonexistent route', () => {
      const mutated = clone(committed);
      entryFor(mutated, 'saved-audiences').currentRouteRefs = [
        'GET /api/engagement/outreach/does-not-exist',
      ];

      const failures = verifyCapabilityManifest(mutated, prototype, routeManifest);
      expect(failures).toContain(
        'entry "saved-audiences" references unknown route "GET /api/engagement/outreach/does-not-exist"',
      );
    });

    it('NC-2.2-D rejects a shadow-blocked route with no Phase 1 runtime-action metadata', () => {
      const mutated = clone(committed);
      // A real, safe read route — but it carries no external-action metadata,
      // so claiming it is shadow-denied must fail.
      entryFor(mutated, 'representative-samples').currentRouteRefs = [
        'GET /api/engagement/meetings',
      ];

      const failures = verifyCapabilityManifest(mutated, prototype, routeManifest);
      expect(failures.join('\n')).toMatch(/no Phase 1 runtime-action metadata/);
    });

    it('NC-2.2-E rejects a dropped prototype state', () => {
      const mutated = clone(committed);
      mutated.entries = mutated.entries.filter((entry) => entry.stateId !== 'target-profile');

      const failures = verifyCapabilityManifest(mutated, prototype, routeManifest);
      expect(failures).toContain('state "target-profile" has no capability entry');
    });

    it('NC-2.2-F rejects a prototype checksum that drifted from the contract', () => {
      const mutated = clone(committed);
      mutated.prototypeSha256 = '0'.repeat(64);

      const failures = verifyCapabilityManifest(mutated, prototype, routeManifest);
      expect(failures.join('\n')).toMatch(/prototype SHA-256 does not match/);
    });
  });
});
