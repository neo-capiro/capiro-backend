import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  parseWorkspaceBlueprintList as list,
  parseWorkspaceBlueprintDetail as detail,
  parseWorkspaceBlueprintVersion as version,
  parseWorkspaceBlueprintCompare as compare,
  type WorkspaceBlueprintReadResult,
} from './workspace-template-studio.js';

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const time = '2026-10-26T09:00:00.000Z';
const expected = { blueprintId: id(1) };
// Actual serialized Prisma/service fields. Definition is open stored JSON, never a read-view type.
const rawVersion = (number = 1) => ({
  id: id(number + 10),
  tenantId: id(2),
  blueprintId: id(1),
  version: number,
  status: number === 1 ? 'published' : 'draft',
  definition: { schemaVersion: 1, sections: [{ instructions: 'Stored content' }] },
  definitionHash: String(number).repeat(64),
  createdById: 'synthetic_author',
  createdAt: time,
  publishedAt: number === 1 ? time : null,
  retiredAt: null,
});
const blueprint = () => ({
  id: id(1),
  tenantId: id(2),
  scope: 'firm',
  slug: 'synthetic',
  name: 'Synthetic blueprint',
  product: 'Brief',
  description: null,
  ownerId: null,
  createdAt: time,
  updatedAt: time,
  versions: [rawVersion(1), rawVersion(2)],
});
const catalog = () => [{ ...blueprint(), pinnedDocCount: 3, versions: [rawVersion(2)] }];
const comparison = () => ({
  blueprintId: id(1),
  versions: [1, 2, 3].map((number) => ({
    versionId: id(number + 10),
    version: number,
    status: number === 1 ? 'published' : 'draft',
    definitionHash: String(number).repeat(64),
    createdAt: time,
    publishedAt: number === 1 ? time : null,
  })),
  diffs: [
    { fromVersionId: id(11), toVersionId: id(12), changedKeys: ['sections'] },
    { fromVersionId: id(12), toVersionId: id(13), changedKeys: [] },
  ],
});
function accepted<T>(result: WorkspaceBlueprintReadResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('Expected accepted fixture');
  return result.value;
}
function refused<T>(result: WorkspaceBlueprintReadResult<T>, code?: string): void {
  assert.equal(result.ok, false);
  if (!result.ok && code) assert.equal(result.error.code, code);
}

test('projects unchanged producer metadata and distinguishes latest draft from older published', () => {
  const items = accepted(list(catalog()));
  assert.equal(items[0]!.pinnedDocCount, 3);
  assert.deepEqual(
    items[0]!.versions.map((v) => [v.version, v.status]),
    [[2, 'draft']],
  );
  const source = blueprint();
  const value = accepted(detail(source, expected));
  assert.deepEqual(
    value.versions.map((v) => [v.version, v.status]),
    [
      [1, 'published'],
      [2, 'draft'],
    ],
  );
  assert.equal(value.versions[0]!.definitionHash, '1'.repeat(64));
  assert.equal(value.versions[0]!.publishedAt, time);
  assert.equal(value.description, null);
  assert.equal(value.ownerId, null);
  assert.equal('definition' in value.versions[0]!, false);
  assert.equal('pinnedDocCount' in value, false);
  source.versions[0]!.definition.sections[0]!.instructions = 'Changed';
  source.name = 'Changed';
  assert.equal(value.name, 'Synthetic blueprint');
});

test('preserves global null facts and legitimate empty collections without inventing a published version', () => {
  const source = { ...blueprint(), tenantId: null, scope: 'capiro', versions: [] };
  assert.deepEqual(accepted(detail(source, expected)), source);
  assert.deepEqual(accepted(list([])), []);
  assert.equal(accepted(list([{ ...source, pinnedDocCount: 0 }]))[0]!.versions.length, 0);
  assert.deepEqual(accepted(compare({ blueprintId: id(1), versions: [], diffs: [] }, expected)), {
    blueprintId: id(1),
    versions: [],
    diffs: [],
  });
});

test('detail and comparison bind the captured requested blueprint identity', () => {
  refused(
    detail(
      {
        ...blueprint(),
        id: id(9),
        blueprintId: id(1),
        versions: [{ ...rawVersion(), blueprintId: id(9) }],
      },
      expected,
    ),
    'identity_mismatch',
  );
  refused(
    compare({ ...comparison(), blueprintId: id(9), id: id(1) }, expected),
    'identity_mismatch',
  );
  const uppercase = { blueprintId: id(1).toUpperCase() };
  assert.equal(accepted(detail(blueprint(), uppercase)).id, id(1));
  for (const missing of [undefined, null, {}, { blueprintId: 'campaign_1' }]) {
    refused(detail(blueprint(), missing as never));
    refused(compare(comparison(), missing as never));
  }
});

test('version reads bind both requested IDs and nested versions remain on the requested blueprint', () => {
  const value = accepted(version(rawVersion(2), { ...expected, versionId: id(12) }));
  assert.equal(value.status, 'draft');
  assert.equal('definition' in value, false);
  refused(version(rawVersion(2), { ...expected, versionId: id(11) }), 'identity_mismatch');
  refused(version(rawVersion(2), { blueprintId: id(9), versionId: id(12) }), 'identity_mismatch');
  refused(version(rawVersion(2), expected as never));
  const foreign = { ...rawVersion(2), blueprintId: id(9) };
  refused(detail({ ...blueprint(), versions: [foreign] }, expected), 'identity_mismatch');
  refused(list([{ ...catalog()[0], versions: [foreign] }]), 'identity_mismatch');
});

test('compares exact adjacent pairs and projects only the producer summary', () => {
  const source = comparison();
  assert.deepEqual(accepted(compare(source, expected)), source);
  const extra = { ...source, arbitraryPair: { from: id(11), to: id(13) } };
  assert.equal('arbitraryPair' in accepted(compare(extra, expected)), false);
  refused(compare({ ...source, diffs: [source.diffs[0]] }, expected));
  refused(
    compare(
      { ...source, diffs: [{ ...source.diffs[0], toVersionId: id(13) }, source.diffs[1]] },
      expected,
    ),
    'identity_mismatch',
  );
  refused(
    compare(
      { ...source, diffs: [{ ...source.diffs[0], fromVersionId: id(9) }, source.diffs[1]] },
      expected,
    ),
    'identity_mismatch',
  );
  refused(compare({ ...source, versions: [...source.versions].reverse() }, expected));
});

test('refuses duplicate or out-of-order versions and catalog rows claiming multiple latest versions', () => {
  refused(detail({ ...blueprint(), versions: [rawVersion(2), rawVersion(1)] }, expected));
  refused(detail({ ...blueprint(), versions: [rawVersion(1), rawVersion(1)] }, expected));
  refused(list([{ ...blueprint(), pinnedDocCount: 0 }]));
});

test('null, missing required metadata and error envelopes are explicit refusals', () => {
  for (const input of [null, undefined, {}, { message: 'Unavailable', statusCode: 503 }]) {
    refused(list(input));
    refused(detail(input, expected));
    refused(compare(input, expected));
  }
  for (const key of Object.keys(blueprint())) {
    const input: Record<string, unknown> = blueprint();
    delete input[key];
    refused(detail(input, expected));
  }
  for (const key of Object.keys(rawVersion()).filter((key) => key !== 'definition')) {
    const input: Record<string, unknown> = rawVersion();
    delete input[key];
    refused(version(input, { ...expected, versionId: id(11) }));
  }
  const { pinnedDocCount: omitted, ...input } = catalog()[0]!;
  assert.equal(omitted, 3);
  refused(list([input]));
});

test('refuses invalid scalars without coercing status, hashes, UUIDs, counts or instants', () => {
  for (const patch of [
    { version: 0 },
    { version: 1.5 },
    { version: '1' },
    { status: 'latest' },
    { id: 'campaign_1' },
    { definitionHash: 'bad' },
    { createdAt: '2026-02-30T00:00:00.000Z' },
    { publishedAt: '2026-10-26' },
    { retiredAt: false },
    { tenantId: '' },
  ])
    refused(version({ ...rawVersion(), ...patch }, { ...expected, versionId: id(11) }));
  for (const pinnedDocCount of [-1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1])
    refused(list([{ ...catalog()[0], pinnedDocCount }]));
  refused(detail({ ...blueprint(), scope: null }, expected));
});

test('does not run accessors even in omitted definition content or captured expectation', () => {
  let calls = 0;
  const accessor = {
    get hidden() {
      calls++;
      return 'must not run';
    },
  };
  refused(
    detail({ ...blueprint(), versions: [{ ...rawVersion(), definition: accessor }] }, expected),
    'invalid_json',
  );
  refused(
    detail(blueprint(), {
      get blueprintId() {
        calls++;
        return id(1);
      },
    }),
    'invalid_json',
  );
  assert.equal(calls, 0);
});

test('refuses hostile and non-JSON values without leaking exceptions', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse = new Array(1);
  const hidden = Object.defineProperty({}, 'secret', { value: 1 });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('hostile');
      },
    },
  );
  const bad = [
    undefined,
    () => 1,
    1n,
    Symbol('x'),
    NaN,
    Infinity,
    new Date(),
    new Map(),
    cycle,
    sparse,
    hidden,
    proxy,
  ];
  for (const value of bad)
    refused(
      detail({ ...blueprint(), versions: [{ ...rawVersion(), definition: value }] }, expected),
      'invalid_json',
    );
  const symbolic = { [Symbol('x')]: 1 };
  refused(detail({ ...blueprint(), extra: symbolic }, expected), 'invalid_json');
});

test('accepts other-realm JSON and inert own __proto__ data while enforcing existing depth budget', () => {
  const input = runInNewContext(`(${JSON.stringify(blueprint())})`);
  assert.equal(accepted(detail(input, expected)).id, id(1));
  const own = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.equal(accepted(detail({ ...blueprint(), extra: own }, expected)).id, id(1));
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  let deep: unknown = null;
  for (let i = 0; i < 65; i++) deep = { next: deep };
  refused(detail({ ...blueprint(), extra: deep }, expected), 'limit_exceeded');
});
