import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  approvedPreviewMaintenance,
  previewTable,
  previewGenerator,
  routeManifest,
} from './outreach-phase6-approved-preview-maintenance.mjs';
const manifest = (line) =>
  JSON.stringify({
    schemaVersion: 1,
    routes: [
      {
        method: 'GET',
        path: '/api/engagement/clients/:id/notetaker',
        sourceLine: line,
        guards: ['AuthGuard'],
      },
    ],
  }) + '\n';
const hash = (s) => createHash('sha256').update(s).digest('hex');
const rows = Array.from(
  { length: 154 },
  (_, n) => `^/api/engagement/path-${String(n).padStart(3, '0')}$`,
);
const approved = '^/api/engagement/clients/[^/]+/notetaker$';
const module = (patterns, m) =>
  `/**\n *   apps/api/src/fixture.json\n */\nexport const ENGAGEMENT_ROUTE_MANIFEST_SHA256 =\n  '${hash(m)}';\nexport const ENGAGEMENT_PREVIEW_ROUTE_COUNT = ${patterns.length};\nexport const ENGAGEMENT_PREVIEW_ROUTE_PATTERNS: readonly string[] = [\n${patterns
    .sort()
    .map((p) => `  '${p}',`)
    .join('\n')}\n];\n`;
function fixture() {
  const old = {
    [routeManifest]: manifest(1),
    [previewTable]: module([...rows], manifest(1)),
    [previewGenerator]: 'map((manifestPath) => path.relative(ROOT, manifestPath))',
  };
  const next = {
    [routeManifest]: manifest(2),
    [previewTable]: module([...rows, approved], manifest(2)),
    [previewGenerator]:
      "map((manifestPath) => path.relative(ROOT, manifestPath).split(path.sep).join('/'))",
  };
  return { old, next, changed: [previewTable, previewGenerator, routeManifest] };
}
function check(f) {
  return approvedPreviewMaintenance({
    changed: f.changed,
    before: (p) => f.old[p],
    after: (p) => f.next[p],
  });
}
test('accepts exactly the approved additive path and source-line/comment portability maintenance', () =>
  assert.equal(check(fixture()), true));
for (const path of [
  'apps/web/src/pages/engagement/outreach/v3/OutreachWizardRouter.tsx',
  'apps/web/src/pages/engagement/OutreachView.tsx',
  'apps/web/src/lib/engagement-api-preview.ts',
  'apps/web/src/lib/api-client.ts',
  'apps/api/src/outreach-v3/session.ts',
  'apps/api/src/capabilities/targets/target.ts',
  'apps/api/src/capabilities/context/context.ts',
  'docs/plans/outreach-v3/revised-phase-6-any.md',
])
  test(`product change retains original verifier: ${path}`, () => {
    const f = fixture();
    f.changed.push(path);
    assert.equal(check(f), false);
  });
for (const [name, mutate] of [
  [
    'other route',
    (f) => {
      f.next[previewTable] = module([...rows, '^/another$'], manifest(2));
    },
  ],
  [
    'route removed',
    (f) => {
      f.next[previewTable] = module([...rows.slice(1), approved], manifest(2));
    },
  ],
  [
    'extra route',
    (f) => {
      f.next[previewTable] = module([...rows, approved, '^/another$'], manifest(2));
    },
  ],
  [
    'guard changed',
    (f) => {
      f.next[routeManifest] = manifest(2).replace('AuthGuard', 'OtherGuard');
    },
  ],
  [
    'path changed',
    (f) => {
      f.next[routeManifest] = manifest(2).replace('/notetaker', '/other');
    },
  ],
  [
    'untrusted checksum',
    (f) => {
      f.next[previewTable] = f.next[previewTable].replace(hash(manifest(2)), '0'.repeat(64));
    },
  ],
  [
    'generator logic',
    (f) => {
      f.next[previewGenerator] += '; enablePreview()';
    },
  ],
  [
    'generated export',
    (f) => {
      f.next[previewTable] += 'export const activation = true;\n';
    },
  ],
  [
    'malformed input',
    (f) => {
      f.next[routeManifest] = '{';
    },
  ],
  [
    'unselected table',
    (f) => {
      f.changed = f.changed.filter((p) => p !== previewTable);
    },
  ],
])
  test(`fails closed for ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.equal(check(f), false);
  });
