import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURE = path.join(__dirname, '__fixtures__', 'engagement-route-manifest.v1.json');
const SCRIPT = path.join(REPO, 'apps', 'api', 'scripts', 'engagement-phase0-route-manifest.ts');
const TSX_CLI = require.resolve('tsx/cli');

function readFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
}

function generate() {
  const result = spawnSync(process.execPath, [TSX_CLI, SCRIPT], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30_000,
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`route manifest generator failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

describe('Engagement route manifest', () => {
  describe('fixture integrity', () => {
    it('exists and parses', () => {
      const manifest = readFixture();
      expect(manifest.schemaVersion).toBe(1);
      expect(Array.isArray(manifest.routes)).toBe(true);
      expect(manifest.routes.length).toBeGreaterThan(0);
    });
    it('global prefix is /api', () => {
      expect(readFixture().globalPrefix).toBe('/api');
    });
    it('generatedAt is null', () => {
      expect(readFixture().generatedAt).toBeNull();
    });
  });

  describe('route invariants', () => {
    let routes: any[];
    beforeAll(() => {
      routes = readFixture().routes;
    });

    it('has no duplicate method/path pairs', () => {
      const seen = new Map<string, string>();
      const duplicates: string[] = [];
      for (const route of routes) {
        const key = `${route.method} ${route.path}`;
        if (seen.has(key)) {
          duplicates.push(`${key}: ${seen.get(key)} vs ${route.controller}.${route.handler}`);
        }
        seen.set(key, `${route.controller}.${route.handler}`);
      }
      expect(duplicates).toEqual([]);
    });

    it('has nonempty controller and handler names', () => {
      for (const route of routes) {
        expect(route.controller).toBeTruthy();
        expect(route.handler).toBeTruthy();
      }
    });

    it('uses recognized classifications', () => {
      const valid = [
        'read',
        'write',
        'generation',
        'external_send',
        'oauth',
        'webhook',
        'internal_secret',
        'sync',
        'notetaker',
        'attachment',
      ];
      for (const route of routes) expect(valid).toContain(route.classification);
    });

    it('does not classify mutating routes as reads', () => {
      for (const route of routes) {
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)) {
          expect(route.classification).not.toBe('read');
        }
      }
    });

    it('keeps Recall outside the /api prefix', () => {
      const recall = routes.filter((route: any) => route.path.startsWith('/webhooks/recall'));
      expect(recall.length).toBeGreaterThan(0);
      for (const route of recall) expect(route.path).not.toMatch(/^\/api\/webhooks/);
    });

    it('contains OAuth callbacks', () => {
      expect(
        routes.filter(
          (route: any) => route.path.includes('callback') && route.controller.includes('OAuth'),
        ).length,
      ).toBeGreaterThan(0);
    });

    it('classifies internal AI credential routes as internal_secret', () => {
      const internal = routes.filter((route: any) =>
        route.path.includes('internal/ai-credentials'),
      );
      expect(internal.length).toBeGreaterThan(0);
      for (const route of internal) expect(route.classification).toBe('internal_secret');
    });

    it('is sorted deterministically by path and method', () => {
      for (let index = 1; index < routes.length; index += 1) {
        const previous = routes[index - 1];
        const current = routes[index];
        const pathOrder = current.path.localeCompare(previous.path);
        expect(pathOrder).toBeGreaterThanOrEqual(0);
        if (pathOrder === 0) {
          expect(current.method.localeCompare(previous.method)).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('represents every required controller', () => {
      const controllers = new Set(routes.map((route: any) => route.controller));
      for (const name of [
        'EngagementController',
        'MicrosoftOAuthController',
        'GoogleOAuthController',
        'OutcomeController',
        'InternalAiCredentialsController',
        'RecallWebhookController',
      ]) {
        expect(controllers.has(name)).toBe(true);
      }
    });
  });

  describe('snapshot comparison', () => {
    it('matches the current controller source exactly', () => {
      const committed = readFixture();
      const regenerated = generate();
      delete committed.generatedAt;
      delete regenerated.generatedAt;
      expect(regenerated).toEqual(committed);
    });
  });

  describe('negative controls', () => {
    it('detects a synthetic route change', () => {
      const committed = readFixture();
      const changed = JSON.parse(JSON.stringify(committed));
      changed.routes[0].path = '/api/engagement/NONEXISTENT';
      expect(changed).not.toEqual(committed);
    });
  });
});
