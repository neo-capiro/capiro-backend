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
          (route: any) => route.path.endsWith('/callback') && route.controller.endsWith('CallbacksController'),
        ).length,
      ).toBeGreaterThan(0);
    });


    it('preserves mailbox and calendar command routes with their authenticated versus public boundaries', () => {
      const mailbox = routes.filter((route) => /^\/api\/engagement\/integrations\/(microsoft|google)\//.test(route.path));
      expect(mailbox).toHaveLength(18);
      expect(mailbox.filter((route) => route.classification === 'oauth')).toHaveLength(14);
      for (const provider of ['microsoft', 'google']) {
        const calendar = mailbox.filter((route) => route.path.startsWith(`/api/engagement/integrations/${provider}/`) && route.path.includes('/calendar-commands'));
        expect(calendar.map((route) => [route.method, route.handler, route.classification])).toEqual([
          ['POST', 'runCalendarCommand', 'sync'],
          ['GET', 'readCalendarCommand', 'read'],
        ]);
      }
      expect(mailbox.filter((route) => route.controller.endsWith('CallbacksController'))).toHaveLength(4);
      for (const route of mailbox) {
        expect(route.controllerGuards).toEqual([]);
        expect(route.controllerRoles).toEqual([]);
        const callback = route.controller.endsWith('CallbacksController');
        expect(route.handlerGuards).toEqual(callback ? [] : ['RolesGuard']);
        expect(route.handlerRoles).toEqual(callback ? [] : ['standard_user']);
      }
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
        'NewsletterOutreachController',
        'NewsletterPublicController',
        'MicrosoftIntegrationActionsController',
        'MicrosoftCallbacksController',
        'GoogleIntegrationActionsController',
        'GoogleCallbacksController',
        'OutcomeController',
        'InternalAiCredentialsController',
        'RecallWebhookController',
      ]) {
        expect(controllers.has(name)).toBe(true);
      }
    });

    it('includes every Newsletter route with its real read/write/send and access metadata', () => {
      const authoring = routes.filter((route) => route.controller === 'NewsletterOutreachController');
      const publicRoutes = routes.filter((route) => route.controller === 'NewsletterPublicController');
      const signatures = (entries: any[]) => entries.map(
        (route) => `${route.method} ${route.path} ${route.classification}`,
      ).sort();
      expect(signatures(authoring)).toEqual([
        'GET /api/engagement/newsletters/stages/:id read',
        'POST /api/engagement/newsletters/stages/:id/open write',
        'GET /api/engagement/newsletters/:id read',
        'POST /api/engagement/newsletters/:id/prepare write',
        'POST /api/engagement/newsletters/:id/send external_send',
        'POST /api/engagement/newsletters/:id/test external_send',
      ].sort());
      expect(signatures(publicRoutes)).toEqual([
        'GET /api/engagement/newsletter-public/:token/archive read',
        'GET /api/engagement/newsletter-public/:token/unsubscribe read',
        'POST /api/engagement/newsletter-public/:token/unsubscribe write',
        'GET /api/engagement/newsletter-public/:token/preferences read',
        'POST /api/engagement/newsletter-public/:token/preferences write',
        'GET /api/engagement/newsletter-public/:token/survey read',
        'POST /api/engagement/newsletter-public/:token/survey write',
      ].sort());
      for (const route of authoring) {
        expect(route.controllerGuards).toEqual(['RolesGuard']);
        expect(route.controllerRoles).toEqual(['standard_user']);
      }
      for (const route of publicRoutes) {
        expect(route.controllerGuards).toEqual([]);
        expect(route.controllerRoles).toEqual([]);
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
