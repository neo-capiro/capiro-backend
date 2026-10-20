import { readHarness } from './fixtures/tracker-watchlist-ownership/read-io.js';
import {
  CLIENT,
  TENANT,
  USER,
  WATCHLIST,
  namesWithoutScopes,
} from './fixtures/tracker-watchlist-ownership/io.js';

it('watchlist read awaits head and both cold-client suggestions in their original order', async () => {
  const h = readHarness();
  h.rows.head = null;
  h.rows.facilities = [{ state: 'TX' }];
  const head = h.tape.pause('read.head');
  const sector = h.tape.pause('system.sector');
  const request = h.service.getWatchlist(TENANT, CLIENT);
  await head.started.promise;
  expect(namesWithoutScopes(h.tape)).toEqual(['read.head']);
  head.release.resolve();
  await sector.started.promise;
  expect(namesWithoutScopes(h.tape)).toEqual(['read.head', 'system.sector']);
  sector.release.resolve();
  expect(await request).toEqual({
    clientId: CLIENT,
    issueAreas: [],
    jurisdictions: [],
    topics: [],
    version: 0,
    updatedByName: null,
    updatedAt: null,
    suggestedIssueAreas: ['Defense'],
    suggestedJurisdictions: ['TX'],
  });
  expect(namesWithoutScopes(h.tape)).toEqual(['read.head', 'system.sector', 'system.facilities']);
});

it('configured read awaits topic and term I/O before facilities and user-option evaluation', async () => {
  const h = readHarness();
  h.rows.head!.jurisdictions = [];
  h.rows.facilities = [{ state: 'CA' }];
  const topics = h.tape.pause('read.topics');
  const terms = h.tape.pause('read.terms');
  const options = {
    get withUserNames() {
      h.tape.note('options.withUserNames');
      return true;
    },
  };
  const request = h.service.getWatchlist(TENANT, CLIENT, options);
  await topics.started.promise;
  expect(namesWithoutScopes(h.tape)).toEqual(['read.head', 'read.topics']);
  topics.release.resolve();
  await terms.started.promise;
  expect(namesWithoutScopes(h.tape)).toEqual(['read.head', 'read.topics', 'read.terms']);
  terms.release.resolve();
  expect(await request).toMatchObject({
    updatedByName: 'Ada Lovelace',
    updatedAt: '1970-01-01T00:00:00.000Z',
    suggestedJurisdictions: ['CA'],
  });
  expect(namesWithoutScopes(h.tape)).toEqual([
    'read.head',
    'read.topics',
    'read.terms',
    'system.facilities',
    'options.withUserNames',
    'system.names',
  ]);
});

it('reads late user options and current attribution method after all awaited row reads', async () => {
  const h = readHarness();
  const terms = h.tape.pause('read.terms');
  const options = { withUserNames: false };
  const request = h.service.getWatchlist(TENANT, CLIENT, options);
  await terms.started.promise;
  options.withUserNames = true;
  terms.release.resolve();
  expect((await request).updatedByName).toBe('Ada Lovelace');
  expect(namesWithoutScopes(h.tape)).toEqual([
    'read.head',
    'read.topics',
    'read.terms',
    'system.names',
  ]);
});

it('cold reads do not evaluate name options or perform attribution I/O', async () => {
  const h = readHarness();
  h.rows.head = null;
  const options = {
    get withUserNames(): never {
      throw new Error('cold option must stay unread');
    },
  };
  await h.service.getWatchlist(TENANT, CLIENT, options);
  expect(namesWithoutScopes(h.tape)).toEqual(['read.head', 'system.sector', 'system.facilities']);
});

it.each(['read.head', 'read.topics', 'read.terms'])(
  'read failure at %s stops subsequent reads',
  async (stage) => {
    const h = readHarness();
    h.tape.failures.set(stage, new Error(`failure:${stage}`));
    await expect(h.service.getWatchlist(TENANT, CLIENT, { withUserNames: true })).rejects.toThrow(
      `failure:${stage}`,
    );
    const operations = ['read.head', 'read.topics', 'read.terms'];
    expect(namesWithoutScopes(h.tape)).toEqual(operations.slice(0, operations.indexOf(stage) + 1));
  },
);

it('attribution failure is best effort and preserves the head epoch timestamp', async () => {
  const h = readHarness();
  h.tape.failures.set('system.names', new Error('name read unavailable'));
  expect(await h.service.getWatchlist(TENANT, CLIENT, { withUserNames: true })).toMatchObject({
    version: 7,
    updatedByName: null,
    updatedAt: '1970-01-01T00:00:00.000Z',
  });
  expect(h.logger.warn).toHaveBeenCalledWith('resolveUserName failed: name read unavailable');
});

it('configured null writer skips user I/O and null version/timestamp retain defaults', async () => {
  const h = readHarness();
  Object.assign(h.rows.head!, { updatedBy: null, updatedAt: null, version: null });
  expect(await h.service.getWatchlist(TENANT, CLIENT, { withUserNames: true })).toMatchObject({
    version: 0,
    updatedByName: null,
    updatedAt: null,
  });
  expect(namesWithoutScopes(h.tape)).toEqual(['read.head', 'read.topics', 'read.terms']);
});

it('facility suggestions preserve source order and case while dropping null/empty states', async () => {
  const h = readHarness();
  h.rows.facilities = [{ state: 'tx' }, { state: null }, { state: '' }, { state: 'CA' }];
  expect(await h.service.suggestedJurisdictions(TENANT, CLIENT)).toEqual(['tx', 'CA']);
  expect(h.tape.calls[0]!.args).toEqual({
    sql: 'SELECT DISTINCT state FROM client_facilities WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND state IS NOT NULL',
    bindings: [TENANT, CLIENT],
  });
  expect(await h.service.suggestedJurisdictions(TENANT, 'not-a-uuid')).toEqual([]);
  expect(h.tape.calls).toHaveLength(1);
});

it('read preserves scoped topic/term identities and flat fold append order', async () => {
  const h = readHarness();
  h.rows.topics = [
    {
      id: 'topic-hearing',
      label: 'HEARING TERMS',
      issueArea: null,
      position: 'support',
      priority: 'high',
    },
  ];
  h.rows.terms = [
    { id: 'term-topic', topicId: 'topic-hearing', termType: 'company', value: 'RTX' },
    { id: 'term-flat', topicId: null, termType: 'keyword', value: 'grid load' },
  ];
  expect((await h.service.getWatchlist(TENANT, CLIENT)).topics).toEqual([
    {
      id: 'topic-hearing',
      label: 'HEARING TERMS',
      issueArea: null,
      position: 'support',
      priority: 'high',
      terms: [
        { id: 'term-topic', termType: 'company', value: 'RTX' },
        { id: 'term-flat', termType: 'keyword', value: 'grid load' },
      ],
    },
  ]);
  expect(h.tape.calls.find((call) => call.name === 'read.terms')!.args).toEqual({
    where: {
      watchlistId: WATCHLIST,
      tenantId: TENANT,
      OR: [{ topicId: { in: ['topic-hearing'] } }, { topicId: null }],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, topicId: true, termType: true, value: true },
  });
});

it('revision read checks the client first and preserves raw writer, summary and epoch dates', async () => {
  const h = readHarness();
  const summary = { terms: 2, topics: 1 };
  h.rows.revisions = [{ version: 4, changedBy: USER, createdAt: new Date(0), summary }];
  expect(await h.service.getRevisions(TENANT, CLIENT)).toEqual([
    { version: 4, changedBy: USER, createdAt: '1970-01-01T00:00:00.000Z', summary },
  ]);
  expect(namesWithoutScopes(h.tape)).toEqual(['system.client', 'read.revisions']);
  expect(h.tape.calls.find((call) => call.name === 'read.revisions')!.args).toEqual({
    where: { tenantId: TENANT, clientId: CLIENT },
    orderBy: { version: 'desc' },
    take: 20,
    select: { version: true, changedBy: true, createdAt: true, summary: true },
  });
});
