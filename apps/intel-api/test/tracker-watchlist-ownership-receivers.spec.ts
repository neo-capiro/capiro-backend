import 'reflect-metadata';
import { INJECTABLE_WATERMARK } from '@nestjs/common/constants.js';
import {
  TrackerWatchlistService,
  type WatchlistView,
} from '../src/tracker/tracker-watchlist.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { readHarness } from './fixtures/tracker-watchlist-ownership/read-io.js';
import { writeHarness } from './fixtures/tracker-watchlist-ownership/write-io.js';
import { preferenceHarness } from './fixtures/tracker-watchlist-ownership/prefs-io.js';
import {
  CLIENT,
  TENANT,
  USER,
  namesWithoutScopes,
  replacePrivate,
} from './fixtures/tracker-watchlist-ownership/io.js';
import { methodArities, surfaceRoutes } from './fixtures/tracker-watchlist-ownership/literals.js';

const MODULE = '../src/tracker/tracker-watchlist.service.js';

it('watchlist class keeps its one DI identity, own fields and all fifteen original method arities', () => {
  expect(TrackerWatchlistService.length).toBe(1);
  expect(Reflect.getMetadata('design:paramtypes', TrackerWatchlistService)).toEqual([
    PrismaService,
  ]);
  expect(Reflect.getMetadata(INJECTABLE_WATERMARK, TrackerWatchlistService)).toBe(true);
  const h = readHarness();
  expect(Object.getOwnPropertyNames(h.service).sort()).toEqual(['logger', 'prisma']);
  const methods = Object.getOwnPropertyNames(TrackerWatchlistService.prototype).filter(
    (name) => name !== 'constructor',
  );
  expect(methods.sort()).toEqual(Object.keys(methodArities).sort());
  for (const name of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(TrackerWatchlistService.prototype, name)!;
    expect(descriptor.value.length).toBe(methodArities[name]);
    expect(descriptor).toMatchObject({ writable: true, configurable: true, enumerable: false });
  }
});

it('watchlist uses a replaced Prisma dependency after construction', async () => {
  const first = readHarness();
  const second = readHarness();
  second.rows.head!.issueAreas = ['Defense'];
  replacePrivate(first.service, 'prisma', second.prisma);
  expect((await first.service.getWatchlist(TENANT, CLIENT)).issueAreas).toEqual(['Defense']);
  expect(first.tape.calls).toEqual([]);
  expect(namesWithoutScopes(second.tape)).toEqual(['read.head', 'read.topics', 'read.terms']);
});

it('watchlist looks up the current Prisma again after an awaited head read', async () => {
  const first = readHarness();
  const second = readHarness();
  second.rows.topics = [
    {
      id: 'late-topic',
      label: 'Late topic',
      issueArea: null,
      position: 'monitor',
      priority: 'med',
    },
  ];
  const gate = first.tape.pause('read.head');
  const request = first.service.getWatchlist(TENANT, CLIENT);
  await gate.started.promise;
  replacePrivate(first.service, 'prisma', second.prisma);
  gate.release.resolve();
  expect((await request).topics).toEqual([
    {
      id: 'late-topic',
      label: 'Late topic',
      issueArea: null,
      position: 'monitor',
      priority: 'med',
      terms: [],
    },
  ]);
  expect(namesWithoutScopes(first.tape)).toEqual(['read.head']);
  expect(namesWithoutScopes(second.tape)).toEqual(['read.topics', 'read.terms']);
});

it('watchlist borrowed methods run on the invocation receiver', async () => {
  const first = readHarness();
  const second = readHarness();
  second.rows.head!.version = 23;
  const borrowed = first.service.getWatchlist;
  expect((await borrowed.call(second.service, TENANT, CLIENT)).version).toBe(23);
  expect(first.tape.calls).toEqual([]);
});

it('watchlist inherited receivers can override their own dependency without changing the parent', async () => {
  const first = readHarness();
  const second = readHarness();
  second.rows.head!.version = 31;
  const inherited: TrackerWatchlistService = Object.create(first.service);
  replacePrivate(inherited, 'prisma', second.prisma);
  expect((await inherited.getWatchlist(TENANT, CLIENT)).version).toBe(31);
  expect((await first.service.getWatchlist(TENANT, CLIENT)).version).toBe(7);
});

it('watchlist prototype-only receiver remains usable with its documented DI fields', async () => {
  const h = readHarness();
  const receiver: TrackerWatchlistService = Object.create(TrackerWatchlistService.prototype);
  replacePrivate(receiver, 'prisma', h.prisma);
  replacePrivate(receiver, 'logger', h.logger);
  expect((await receiver.getCompiled(TENANT, CLIENT)).issueAreas).toEqual(['Energy']);
});

it('cold read honors late private and public suggestion overrides on the same receiver', async () => {
  const h = readHarness();
  h.rows.head = null;
  const gate = h.tape.pause('read.head');
  const request = h.service.getWatchlist(TENANT, CLIENT);
  await gate.started.promise;
  const sector = jest.fn(async () => ['Custom area']);
  const states = jest.fn(async () => ['ZZ']);
  replacePrivate(h.service, 'getSectorSuggestion', sector);
  replacePrivate(h.service, 'suggestedJurisdictions', states);
  gate.release.resolve();
  expect(await request).toMatchObject({
    suggestedIssueAreas: ['Custom area'],
    suggestedJurisdictions: ['ZZ'],
  });
  expect(sector).toHaveBeenCalledWith(TENANT, CLIENT);
  expect(states).toHaveBeenCalledWith(TENANT, CLIENT);
  expect(namesWithoutScopes(h.tape)).toEqual(['read.head']);
});

it('configured read honors a late private attribution override', async () => {
  const h = readHarness();
  const gate = h.tape.pause('read.terms');
  const request = h.service.getWatchlist(TENANT, CLIENT, { withUserNames: true });
  await gate.started.promise;
  const attribution = jest.fn(async () => 'Current writer');
  replacePrivate(h.service, 'resolveUserName', attribution);
  gate.release.resolve();
  expect((await request).updatedByName).toBe('Current writer');
  expect(attribution).toHaveBeenCalledWith(USER);
  expect(namesWithoutScopes(h.tape)).toEqual(['read.head', 'read.topics', 'read.terms']);
});

it('compiled method calls the current read method with its original omitted options', async () => {
  const h = readHarness();
  const view: WatchlistView = {
    clientId: CLIENT,
    issueAreas: [],
    jurisdictions: ['TX'],
    topics: [],
    version: 4,
    updatedByName: null,
    updatedAt: null,
  };
  const read = jest.fn(async () => view);
  replacePrivate(h.service, 'getWatchlist', read);
  expect(await h.service.getCompiled(TENANT, CLIENT)).toEqual({
    issueAreas: [],
    jurisdictions: ['TX'],
    billMatchSet: [],
    hearingTerms: [],
    deepgramKeyterms: [],
    truncatedTopics: [],
    termSurfaces: surfaceRoutes,
  });
  expect(read).toHaveBeenCalledWith(TENANT, CLIENT);
  expect(h.tape.calls).toEqual([]);
});

it('in-place public trigger mutations remain visible to all three default consumers', async () => {
  const module =
    jest.requireActual<typeof import('../src/tracker/tracker-watchlist.service.js')>(MODULE);
  const triggers = module.DEFAULT_TRIGGERS;
  const oldLength = triggers.length;
  Reflect.apply(Array.prototype.push, triggers, ['temporary-owner-trigger']);
  try {
    const h = preferenceHarness();
    expect((await h.service.getAlertPrefs(TENANT, CLIENT, USER)).triggers.at(-1)).toBe(
      'temporary-owner-trigger',
    );
    await h.service.putAlertPrefs(TENANT, CLIENT, USER, {});
    await h.service.markPhoneVerified(TENANT, CLIENT, USER, '+12025550100');
    for (const call of h.tape.calls.filter((entry) => entry.name === 'pref.upsert'))
      expect(call.args).toMatchObject({
        create: { triggers: expect.arrayContaining(['temporary-owner-trigger']) },
      });
  } finally {
    Reflect.set(triggers, 'length', oldLength);
  }
});

it('CommonJS replacement of the public trigger binding remains visible without module reload', async () => {
  const module =
    jest.requireActual<typeof import('../src/tracker/tracker-watchlist.service.js')>(MODULE);
  const descriptor = Object.getOwnPropertyDescriptor(module, 'DEFAULT_TRIGGERS')!;
  Object.defineProperty(module, 'DEFAULT_TRIGGERS', {
    ...descriptor,
    value: ['replacement-trigger'],
  });
  try {
    const h = preferenceHarness();
    expect((await h.service.getAlertPrefs(TENANT, CLIENT, USER)).triggers).toEqual([
      'replacement-trigger',
    ]);
    await h.service.putAlertPrefs(TENANT, CLIENT, USER, {});
    await h.service.markPhoneVerified(TENANT, CLIENT, USER, '+12025550100');
    for (const call of h.tape.calls.filter((entry) => entry.name === 'pref.upsert'))
      expect(call.args).toMatchObject({ create: { triggers: ['replacement-trigger'] } });
  } finally {
    Object.defineProperty(module, 'DEFAULT_TRIGGERS', descriptor);
  }
});

it('CommonJS replacement of the public hearing label reaches the helper and synthetic fold', async () => {
  const module =
    jest.requireActual<typeof import('../src/tracker/tracker-watchlist.service.js')>(MODULE);
  const descriptor = Object.getOwnPropertyDescriptor(module, 'HEARING_TERMS_TOPIC_LABEL')!;
  Object.defineProperty(module, 'HEARING_TERMS_TOPIC_LABEL', {
    ...descriptor,
    value: 'Replacement hearing',
  });
  try {
    const h = readHarness();
    h.rows.terms = [{ id: 'flat', topicId: null, termType: 'keyword', value: 'grid load' }];
    expect(module.isReservedTopicLabel(' REPLACEMENT HEARING ')).toBe(true);
    expect((await h.service.getWatchlist(TENANT, CLIENT)).topics[0]!.label).toBe(
      'Replacement hearing',
    );
  } finally {
    Object.defineProperty(module, 'HEARING_TERMS_TOPIC_LABEL', descriptor);
  }
});

it('replacing an exported helper property does not replace the original private lexical predicate', async () => {
  const module =
    jest.requireActual<typeof import('../src/tracker/tracker-watchlist.service.js')>(MODULE);
  const spy = jest.spyOn(module, 'isReservedTopicLabel').mockReturnValue(false);
  try {
    const h = writeHarness();
    const view = await h.service.putWatchlist(TENANT, CLIENT, USER, {
      expectedVersion: 7,
      topics: [{ label: 'Hearing terms' }],
    });
    expect(view.rejected).toEqual({
      topics: [{ index: 0, label: 'Hearing terms', reason: '"Hearing terms" is a reserved name.' }],
      terms: [],
    });
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
