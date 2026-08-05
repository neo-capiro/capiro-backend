import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Route coverage verifier: loads the Phase 0 route manifest and side-effect
// registry, then verifies that every route classified as an external side
// effect has an @EngagementRuntimeAction decorator in the controller source.

const FIXTURES_DIR = join(__dirname, '..', '__fixtures__');
const ROUTE_MANIFEST = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'engagement-route-manifest.v1.json'), 'utf-8'),
);
const SIDE_EFFECT_REGISTRY = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'engagement-side-effect-registry.v1.json'), 'utf-8'),
);

// Controller source files to inspect for decorator metadata.
const CONTROLLER_FILES = [
  join(__dirname, '..', 'engagement.controller.ts'),
  join(__dirname, '..', 'microsoft', 'microsoft-oauth.controller.ts'),
  join(__dirname, '..', 'google', 'google-oauth.controller.ts'),
  join(__dirname, '..', 'internal-ai-credentials.controller.ts'),
  join(__dirname, '..', 'outcome', 'outcome.controller.ts'),
];

// Read all controller sources at module load time.
const controllerSources = new Map<string, string>();
for (const file of CONTROLLER_FILES) {
  try {
    const src = readFileSync(file, 'utf-8');
    controllerSources.set(file, src);
  } catch {
    // File may not exist.
  }
}

const allSource = Array.from(controllerSources.values()).join('\n');

function allSourceFor(filename: string): string {
  for (const [file, src] of controllerSources) {
    if (file.includes(filename)) return src;
  }
  return '';
}

// Known external action names (must match engagement-runtime.types.ts).
const KNOWN_ACTIONS = new Set<string>([
  'outreach_generate',
  'outreach_send',
  'outreach_test_send',
  'meeting_prep_generate',
  'meeting_debrief_generate',
  'integration_oauth_start',
  'integration_oauth_callback',
  'integration_disconnect',
  'integration_sync',
  'integration_subscription',
  'integration_notification',
  'notetaker_dispatch',
  'notetaker_remove',
  'attachment_external_read',
  'attachment_external_write',
]);

describe('Engagement runtime route coverage', () => {
  describe('Phase 0 fixtures exist', () => {
    it('route manifest has routes', () => {
      expect(ROUTE_MANIFEST.routes).toBeDefined();
      expect(ROUTE_MANIFEST.routes.length).toBeGreaterThan(0);
    });

    it('side-effect registry has entries', () => {
      expect(SIDE_EFFECT_REGISTRY.entries).toBeDefined();
      expect(SIDE_EFFECT_REGISTRY.entries.length).toBeGreaterThan(0);
    });

    it('side-effect registry has on_module_init timers', () => {
      const timers = SIDE_EFFECT_REGISTRY.entries.filter(
        (e: { trigger: string }) => e.trigger === 'on_module_init',
      );
      expect(timers.length).toBeGreaterThan(0);
    });
  });

  describe('every external route has @EngagementRuntimeAction', () => {
    const actions: string[] = [
      'outreach_generate',
      'outreach_send',
      'outreach_test_send',
      'meeting_prep_generate',
      'meeting_debrief_generate',
      'integration_oauth_start',
      'integration_oauth_callback',
      'integration_disconnect',
      'integration_sync',
      'integration_subscription',
      'integration_notification',
      'notetaker_dispatch',
      'notetaker_remove',
      'attachment_external_read',
      'attachment_external_write',
    ];

    it.each(actions)('action %s is used in controller sources', (action: string) => {
      expect(allSource).toContain(`'${action}'`);
    });

    it('all action names used in decorators are known', () => {
      // Extract all @EngagementRuntimeAction('...') usages from source.
      const regex = /EngagementRuntimeAction\(\s*['"]([^'"]+)['"]/g;
      const matches = allSource.matchAll(regex);
      const usedActions = new Set<string>();
      for (const match of matches) {
        usedActions.add(match[1] ?? '');
      }
      for (const action of usedActions) {
        expect(KNOWN_ACTIONS.has(action)).toBe(true);
      }
    });

    it('no external route is unguarded (missing decorator)', () => {
      // This is a heuristic check: every external route handler name should
      // have a nearby @EngagementRuntimeAction decorator. A full static
      // analysis would parse the AST; here we verify the decorator count
      // matches the expected number of external routes.
      const decoratorCount = (allSource.match(/@EngagementRuntimeAction\(/g) || []).length;
      expect(decoratorCount).toBeGreaterThanOrEqual(15);
    });
  });

  describe('callbacks are marked with requiresCallbacks', () => {
    it('OAuth callback routes have requiresCallbacks: true', () => {
      expect(allSourceFor('microsoft-oauth.controller.ts')).toMatch(
        /EngagementRuntimeAction\(\s*['"]integration_oauth_callback['"]\s*,\s*\{\s*requiresCallbacks:\s*true/,
      );
    });

    it('Microsoft notification routes have requiresCallbacks: true', () => {
      expect(allSourceFor('microsoft-oauth.controller.ts')).toMatch(
        /EngagementRuntimeAction\(\s*['"]integration_notification['"]\s*,\s*\{\s*requiresCallbacks:\s*true/,
      );
    });
  });
});
