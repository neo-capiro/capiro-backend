import { writeHarness } from './fixtures/tracker-watchlist-ownership/write-io.js';
import {
  fullWriteHarness,
  fullWriteInput,
  writeOperations,
} from './fixtures/tracker-watchlist-ownership/write-case.js';
import {
  CLIENT,
  TENANT,
  USER,
  WATCHLIST,
  namesWithoutScopes,
} from './fixtures/tracker-watchlist-ownership/io.js';
import type { PutWatchlistInput } from '../src/tracker/tracker-watchlist.service.js';

it('targeting guards complete before payload getters and the atomic reconcile', async () => {
  const h = writeHarness();
  const client = h.tape.pause('system.client');
  const admin = h.tape.pause('system.admin');
  const input: PutWatchlistInput = {
    expectedVersion: 7,
    get topics() {
      h.tape.note('input.topics');
      return [];
    },
  };
  const request = h.service.putWatchlist(TENANT, CLIENT, USER, input);
  await client.started.promise;
  expect(namesWithoutScopes(h.tape)).toEqual(['system.client']);
  client.release.resolve();
  await admin.started.promise;
  expect(namesWithoutScopes(h.tape)).toEqual(['system.client', 'system.admin']);
  admin.release.resolve();
  await request;
  const names = namesWithoutScopes(h.tape);
  expect(names.slice(0, 5)).toEqual([
    'system.client',
    'system.admin',
    'input.topics',
    'input.topics',
    'write.head',
  ]);
});

it('write preserves rename, per-topic replacement, delete, flat clear, revision and post-commit read order', async () => {
  const h = fullWriteHarness();
  const revision = h.tape.pause('write.revision');
  const request = h.service.putWatchlist(TENANT, CLIENT, USER, fullWriteInput);
  await revision.started.promise;
  expect(namesWithoutScopes(h.tape)).toEqual(writeOperations);
  expect(h.tape.calls.some((call) => call.name === 'tenant.commit')).toBe(false);
  expect(
    h.tape.calls.filter((call) => call.name.startsWith('write.')).every((call) => call.scope === 1),
  ).toBe(true);
  revision.release.resolve();
  expect(await request).toMatchObject({
    version: 8,
    updatedByName: 'Ada Lovelace',
    jurisdictions: ['TX'],
    rejected: { topics: [], terms: [] },
  });
  expect(namesWithoutScopes(h.tape)).toEqual([
    ...writeOperations,
    'view.head',
    'view.topics',
    'view.terms',
    'system.name',
  ]);
  const commit = h.tape.calls.findIndex((call) => call.name === 'tenant.commit');
  expect(commit).toBeGreaterThan(h.tape.calls.findIndex((call) => call.name === 'write.revision'));
  expect(commit).toBeLessThan(h.tape.calls.findIndex((call) => call.name === 'view.head'));
  expect(h.tape.calls.find((call) => call.name === 'write.rename')!.args).toEqual({
    where: { id: 'topic-kept' },
    data: { label: 'Renamed' },
  });
  expect(h.tape.calls.find((call) => call.name === 'write.topics.delete')!.args).toEqual({
    where: { id: { in: ['topic-gone'] }, watchlistId: WATCHLIST, tenantId: TENANT },
  });
});

it('writes literal priority weights and a revision summary without term values', async () => {
  const h = fullWriteHarness();
  await h.service.putWatchlist(TENANT, CLIENT, USER, fullWriteInput);
  expect(h.tape.calls.find((call) => call.name === 'write.terms.create')!.args).toEqual({
    data: [
      {
        watchlistId: WATCHLIST,
        tenantId: TENANT,
        topicId: 'topic-kept',
        termType: 'company',
        value: 'RTX',
        weight: 6.25,
      },
      {
        watchlistId: WATCHLIST,
        tenantId: TENANT,
        topicId: 'topic-kept',
        termType: 'keyword',
        value: 'grid load',
        weight: 2.5,
      },
    ],
  });
  expect(h.tape.calls.find((call) => call.name === 'write.revision')!.args).toEqual({
    data: {
      tenantId: TENANT,
      clientId: CLIENT,
      watchlistId: WATCHLIST,
      version: 8,
      changedBy: USER,
      summary: {
        topics: 1,
        terms: 2,
        issueAreas: 1,
        jurisdictions: 1,
        renamed: [{ from: 'Old', to: 'Renamed' }],
        deleted: ['Remove'],
        rejected: 0,
      },
    },
  });
});

it('reads mutable topic priority after the admin guard and rewrites only changed terms', async () => {
  const h = writeHarness();
  h.rows.topics = [{ id: 'topic-kept', label: 'Signal' }];
  h.rows.terms = [{ topicId: 'topic-kept', termType: 'company', value: 'RTX', weight: 5 }];
  const topic = {
    label: 'Signal',
    priority: 'med',
    terms: [{ termType: 'company', value: 'RTX' }],
  };
  const admin = h.tape.pause('system.admin');
  const request = h.service.putWatchlist(TENANT, CLIENT, USER, {
    expectedVersion: 7,
    topics: [topic],
  });
  await admin.started.promise;
  topic.priority = 'high';
  admin.release.resolve();
  await request;
  expect(h.tape.calls.find((call) => call.name === 'write.terms.create')!.args).toMatchObject({
    data: [{ value: 'RTX', weight: 6.25 }],
  });
});

it('unchanged weighted terms skip both per-topic deletion and creation', async () => {
  const h = writeHarness();
  h.rows.topics = [{ id: 'topic-kept', label: 'Signal' }];
  h.rows.terms = [{ topicId: 'topic-kept', termType: 'company', value: 'RTX', weight: 6.25 }];
  await h.service.putWatchlist(TENANT, CLIENT, USER, {
    expectedVersion: 7,
    topics: [{ label: 'Signal', priority: 'high', terms: [{ termType: 'company', value: 'RTX' }] }],
  });
  expect(namesWithoutScopes(h.tape)).not.toContain('write.terms.delete');
  expect(namesWithoutScopes(h.tape)).not.toContain('write.terms.create');
  expect(namesWithoutScopes(h.tape)).toContain('write.flat.clear');
});

it('rejected colliding rename protects both labels while unrelated removed labels are deleted', async () => {
  const h = writeHarness();
  h.rows.topics = [
    { id: 'source-id', label: 'Source' },
    { id: 'dest-id', label: 'Destination' },
    { id: 'gone-id', label: 'Gone' },
  ];
  const view = await h.service.putWatchlist(TENANT, CLIENT, USER, {
    expectedVersion: 7,
    topics: [
      {
        label: 'Destination',
        renameFrom: 'Source',
        terms: [{ termType: 'company', value: 'RTX' }],
      },
    ],
  });
  expect(view.rejected).toEqual({
    topics: [{ index: 0, label: 'Destination', reason: 'Duplicate tag name.' }],
    terms: [],
  });
  expect(namesWithoutScopes(h.tape)).not.toContain('write.rename');
  expect(namesWithoutScopes(h.tape)).not.toContain('write.topic.upsert');
  expect(h.tape.calls.find((call) => call.name === 'write.topics.delete')!.args).toEqual({
    where: { id: { in: ['gone-id'] }, watchlistId: WATCHLIST, tenantId: TENANT },
  });
  expect(h.tape.calls.find((call) => call.name === 'write.revision')!.args).toMatchObject({
    data: { summary: { topics: 0, terms: 0, renamed: [], deleted: ['Gone'], rejected: 1 } },
  });
});

it('legitimate reserved fold keeps one native term, its original case and inline rejection evidence', async () => {
  const h = writeHarness();
  h.rows.terms = [{ topicId: null, termType: 'native_type', value: 'Legacy signal', weight: 1 }];
  const view = await h.service.putWatchlist(TENANT, CLIENT, USER, {
    expectedVersion: 7,
    topics: [
      {
        label: ' Hearing terms ',
        priority: 'high',
        terms: [
          { termType: 'native_type', value: 'Legacy signal' },
          { termType: 'native_type', value: ' legacy SIGNAL ' },
          { termType: 'keyword', value: 'of' },
        ],
      },
    ],
  });
  expect(h.tape.calls.find((call) => call.name === 'write.terms.create')!.args).toEqual({
    data: [
      {
        watchlistId: WATCHLIST,
        tenantId: TENANT,
        topicId: 'topic-kept',
        termType: 'native_type',
        value: 'Legacy signal',
        weight: 1,
      },
    ],
  });
  expect(view.rejected).toEqual({
    topics: [],
    terms: [
      {
        topicLabel: 'Hearing terms',
        termType: 'keyword',
        value: 'of',
        reason:
          '"of" is too short to match safely. Short terms are allowed only when they are an all-caps acronym (AI, VA), contain a digit (5G, F-35), or contain identifier punctuation (H.R., A-10).',
      },
    ],
  });
  const names = namesWithoutScopes(h.tape);
  expect(names.indexOf('write.terms.create')).toBeLessThan(names.indexOf('write.flat.clear'));
  expect(h.tape.calls.find((call) => call.name === 'write.revision')!.args).toMatchObject({
    data: { summary: { topics: 1, terms: 1, rejected: 1 } },
  });
});

it.each([
  { instant: '2026-08-09T23:59:59.999Z', accepted: true },
  { instant: '2026-08-10T00:00:00.000Z', accepted: false },
])('version grace at $instant has accepted=$accepted', async ({ instant, accepted }) => {
  jest.useFakeTimers().setSystemTime(new Date(instant));
  try {
    const h = writeHarness();
    const request = h.service.putWatchlist(TENANT, CLIENT, USER, {});
    if (accepted) {
      await request;
      expect(h.logger.warn).toHaveBeenCalledWith(
        `putWatchlist without expectedVersion (unversioned client, grace window until 2026-08-10T00:00:00.000Z) client=${CLIENT} version=7`,
      );
    } else {
      await expect(request).rejects.toMatchObject({
        status: 428,
        response: { code: 'WATCHLIST_VERSION_REQUIRED', currentVersion: 7 },
      });
      expect(namesWithoutScopes(h.tape)).toEqual(['system.client', 'system.admin', 'write.head']);
    }
  } finally {
    jest.useRealTimers();
  }
});

it('stale CAS rejects inside the transaction before any write or explicit watchlist lock', async () => {
  const h = writeHarness();
  await expect(
    h.service.putWatchlist(TENANT, CLIENT, USER, { expectedVersion: 6 }),
  ).rejects.toMatchObject({
    status: 409,
    response: { code: 'WATCHLIST_VERSION_CONFLICT', currentVersion: 7 },
  });
  expect(namesWithoutScopes(h.tape)).toEqual(['system.client', 'system.admin', 'write.head']);
  expect(h.tape.calls.at(-1)!.name).toBe('tenant.rollback');
});
