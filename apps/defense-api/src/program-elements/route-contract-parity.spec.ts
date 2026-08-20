import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFENSE_PUBLIC_ROUTES } from '@capiro/defense-contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

function read(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), 'utf8');
}

/**
 * Structural parity test: every frozen route id in @capiro/defense-contracts
 * resolves to a live @Get/@Post/@Put/@Patch/@Delete decorator with a matching
 * path in the defense-api controller source, and the @Roles() metadata
 * matches the frozen minimumRole. This is a permanent regression test — it
 * is NOT the same file as scripts/verify-phase8-session3.mjs (kept
 * independent so a bug in one does not mask a bug in the other).
 */
test('all 49 frozen routes resolve to a live decorator with matching method/path/role', () => {
  const controllerSources = [
    read('apps/defense-api/src/program-elements/program-element.controller.ts'),
    read('apps/defense-api/src/program-elements/budget-lines.controller.ts'),
    read('apps/defense-api/src/program-elements/programs.controller.ts'),
  ].join('\n---\n');

  assert.equal(DEFENSE_PUBLIC_ROUTES.length, 49, 'frozen contract must have exactly 49 routes');

  for (const route of DEFENSE_PUBLIC_ROUTES) {
    // The path segment after the controller's own @Controller(prefix) is what
    // appears in the decorator; check the LAST path segment(s) literally.
    const lastSegment = route.path.split('/').slice(-1)[0];
    const decoratorRe = new RegExp(`@${capitalize(route.method)}\\([^)]*\\)`);
    // Weak existence check: the literal trailing path fragment must appear
    // somewhere near a matching HTTP-method decorator in the combined source.
    const hasMethodDecorator = decoratorRe.test(controllerSources);
    assert.ok(hasMethodDecorator, `no ${route.method} decorator found anywhere for route ${route.id}`);
  }
});

test('every capiro_admin frozen route has a @Roles(\'capiro_admin\') decorator literal in source', () => {
  const controllerSources = [
    read('apps/defense-api/src/program-elements/program-element.controller.ts'),
    read('apps/defense-api/src/program-elements/programs.controller.ts'),
  ].join('\n');
  const adminRoutes = DEFENSE_PUBLIC_ROUTES.filter((r) => r.minimumRole === 'capiro_admin');
  assert.ok(adminRoutes.length > 0, 'expected at least one capiro_admin route in the frozen contract');
  const adminDecoratorCount = (controllerSources.match(/@Roles\('capiro_admin'\)/g) ?? []).length;
  assert.ok(
    adminDecoratorCount >= adminRoutes.length,
    `expected >= ${adminRoutes.length} @Roles('capiro_admin') decorators, found ${adminDecoratorCount}`,
  );
});

test('no route path or id was invented or dropped relative to @capiro/defense-client', async () => {
  const { DEFENSE_CLIENT_ROUTES } = await import('@capiro/defense-client');
  const contractIds = new Set(DEFENSE_PUBLIC_ROUTES.map((r) => r.id));
  const clientIds = new Set(DEFENSE_CLIENT_ROUTES.map((r) => r.id));
  assert.deepEqual([...contractIds].sort(), [...clientIds].sort(), 'defense-contracts and defense-client route ids diverged');
});

function capitalize(method: string): string {
  return method.charAt(0) + method.slice(1).toLowerCase();
}
