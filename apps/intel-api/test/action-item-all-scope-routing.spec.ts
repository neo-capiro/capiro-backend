/**
 * LW-QA-019 — the '_all' work-state routes must exist AND must win the match.
 *
 * The defect was not a broken handler: it was a missing one. The web's default
 * "All clients" view posts to `/intel-api/clients/_all/alerts/…/work-state`,
 * only the `:clientId` form was declared, so '_all' bound as a literal client
 * id and 404'd on the UUID check before any write. Adding the explicit handlers
 * fixes it ONLY while they are declared first — Nest registers routes in
 * method-declaration order within a controller, and `:clientId/alerts/…` would
 * otherwise capture '_all' again.
 *
 * So this asserts the property that actually protects the fix — "the first
 * declared route that matches this URL is the tenant-wide one" — rather than a
 * line number. Reordering the class re-breaks the bug and fails this file.
 */
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ActionItemController } from '../src/feed/action-item.controller.js';

/** POST routes of the controller, in declaration order. */
function postRoutes(): string[] {
  const proto = ActionItemController.prototype as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => proto[name])
    .filter((fn): fn is object => typeof fn === 'function')
    .filter((fn) => Reflect.getMetadata(METHOD_METADATA, fn) === RequestMethod.POST)
    .map((fn) => Reflect.getMetadata(PATH_METADATA, fn) as string);
}

/** Express-style segment match: ':param' takes exactly one segment. */
function matches(pattern: string, url: string): boolean {
  const p = pattern.split('/');
  const u = url.split('/');
  if (p.length !== u.length) return false;
  return p.every((seg, i) => (seg.startsWith(':') ? u[i]!.length > 0 : seg === u[i]));
}

/** The handler a request would actually reach: first declared match wins. */
function resolve(url: string): string | undefined {
  return postRoutes().find((pattern) => matches(pattern, url));
}

describe('ActionItemController — tenant-wide work-state routing (LW-QA-019)', () => {
  it('declares both explicit _all work-state routes', () => {
    const routes = postRoutes();
    expect(routes).toContain('_all/alerts/:alertId/work-state');
    expect(routes).toContain('_all/alerts/work-state/bulk');
  });

  it('routes a single _all triage to the tenant-wide handler, not :clientId', () => {
    expect(resolve('_all/alerts/alert-123/work-state')).toBe('_all/alerts/:alertId/work-state');
  });

  it('routes an _all bulk triage to the tenant-wide bulk handler', () => {
    // Declared before `_all/alerts/:alertId/work-state` as well as before the
    // ':clientId' pair: 'work-state/bulk' would otherwise be read as an alert id.
    expect(resolve('_all/alerts/work-state/bulk')).toBe('_all/alerts/work-state/bulk');
  });

  it('leaves the client-scoped routes reachable for a real client id', () => {
    expect(resolve('11111111-2222-3333-4444-555555555555/alerts/a1/work-state')).toBe(
      ':clientId/alerts/:alertId/work-state',
    );
    expect(resolve('11111111-2222-3333-4444-555555555555/alerts/work-state/bulk')).toBe(
      ':clientId/alerts/work-state/bulk',
    );
  });

  it('declares every _all route before its :clientId twin', () => {
    const routes = postRoutes();
    const firstDynamic = routes.findIndex((r) => r.startsWith(':clientId'));
    for (const explicit of ['_all/alerts/work-state/bulk', '_all/alerts/:alertId/work-state']) {
      expect(routes.indexOf(explicit)).toBeGreaterThanOrEqual(0);
      expect(routes.indexOf(explicit)).toBeLessThan(firstDynamic);
    }
  });
});
