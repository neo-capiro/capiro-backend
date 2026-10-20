import { harness, installHooks, args } from './fixtures/tracker-board-ownership/harness.js';
import {
  clientId,
  otherClientId,
  tenantId,
  watchlist,
  topic,
  term,
  deferred,
} from './fixtures/tracker-board-ownership/rows.js';

installHooks();

it('returns an empty batch map without tenant or source queries for no client IDs', async () => {
  const h = harness();
  const result = await h.subject.compileTopicsForClients(tenantId, []);
  expect([...result]).toEqual([]);
  expect(h.calls).toEqual([]);
});

it('launches batch watchlists/topics together then binds known topic IDs plus flat terms in a separate transaction', async () => {
  const topics = deferred<ReturnType<typeof topic>[]>();
  const h = harness({ results: { 'watchlistTopic.findMany': topics.promise } });
  const pending = h.subject.compileTopicsForClients(tenantId, [clientId, otherClientId]);
  await h.started('watchlistTopic.findMany');
  expect(h.callsOf('watchlist.findMany')).toHaveLength(1);
  expect(h.callsOf('watchlistTerm.findMany')).toHaveLength(0);
  expect(args(h.callsOf('watchlist.findMany')[0]!)).toEqual({
    where: { tenantId, clientId: { in: [clientId, otherClientId] } },
    select: { clientId: true, issueAreas: true },
  });
  expect(h.callsOf('watchlist.findMany')[0]!.transaction).toBe(
    h.callsOf('watchlistTopic.findMany')[0]!.transaction,
  );
  topics.resolve([topic()]);
  await pending;
  expect(args(h.callsOf('watchlistTerm.findMany')[0]!).where).toEqual({
    tenantId,
    watchlistId: { in: [`wl:${clientId}`, `wl:${otherClientId}`] },
    OR: [{ topicId: { in: ['topic-grid'] } }, { topicId: null }],
  });
  expect(h.callsOf('watchlistTerm.findMany')[0]!.transaction).not.toBe(
    h.callsOf('watchlistTopic.findMany')[0]!.transaction,
  );
});

it('groups topics and terms by real client/watchlist while preserving raw issue-area array authority', async () => {
  const a = watchlist({ issueAreas: ['Energy', 'Energy'] });
  const b = watchlist({
    clientId: otherClientId,
    id: `wl:${otherClientId}`,
    issueAreas: ['Housing'],
  });
  const h = harness({
    results: {
      'watchlist.findMany': [a, b],
      'watchlistTopic.findMany': [
        topic(),
        topic({
          id: 'topic-house',
          watchlistId: `wl:${otherClientId}`,
          label: 'Housing',
          position: 'oppose',
          priority: 'low',
        }),
      ],
      'watchlistTerm.findMany': [
        term(),
        term({
          id: 'term-house',
          watchlistId: `wl:${otherClientId}`,
          topicId: 'topic-house',
          value: 'density',
        }),
        term({ id: 'orphan', topicId: 'unknown', value: 'unrelated' }),
      ],
    },
  });
  const result = await h.subject.compileTopicsForClients(tenantId, [clientId, otherClientId]);
  expect(result.get(clientId)!.issueAreas).toBe(a.issueAreas);
  expect(result.get(otherClientId)!.issueAreas).toBe(b.issueAreas);
  expect(result.get(clientId)!.topics[0]).toMatchObject({
    id: 'topic-grid',
    label: 'Grid',
    keywords: ['Grid'],
    position: 'support',
  });
  expect(result.get(otherClientId)!.topics[0]).toMatchObject({
    id: 'topic-house',
    label: 'Housing',
    keywords: ['density', 'Housing'],
    position: 'oppose',
  });
  expect(result.get(otherClientId)!.topics[0]!.routableTerms!.map((row) => row.id)).toContain(
    'term-house',
  );
  expect(result.get(clientId)!.topics[0]!.routableTerms!.some((row) => row.id === 'orphan')).toBe(
    false,
  );
});

it('folds flat hearing terms into an existing case-insensitive reserved host without changing its ID or stance', async () => {
  const h = harness({
    results: {
      'watchlistTopic.findMany': [
        topic({ label: 'hEaRiNg TeRmS', priority: 'low', position: 'oppose' }),
      ],
      'watchlistTerm.findMany': [
        term({ value: 'housing' }),
        term({ id: 'flat', topicId: null, value: 'density' }),
      ],
    },
  });
  const result = await h.subject.compileTopicsForClients(tenantId, [clientId]);
  expect(result.get(clientId)!.topics).toHaveLength(1);
  expect(result.get(clientId)!.topics[0]).toMatchObject({
    id: 'topic-grid',
    label: 'hEaRiNg TeRmS',
    priority: 'low',
    position: 'oppose',
    keywords: ['density', 'hEaRiNg TeRmS', 'housing'],
  });
  expect(
    result.get(clientId)!.topics[0]!.routableTerms!.find((row) => row.id === 'flat'),
  ).toMatchObject({ topicId: 'topic-grid', topicPriority: 'low' });
});

it('synthesizes a hearing host only for the flat-term owner and still returns missing clients in input order', async () => {
  const h = harness({
    results: {
      'watchlist.findMany': [],
      'watchlistTopic.findMany': [],
      'watchlistTerm.findMany': [term({ topicId: null, value: 'density' })],
    },
  });
  const result = await h.subject.compileTopicsForClients(tenantId, [otherClientId, clientId]);
  expect([...result.keys()]).toEqual([otherClientId, clientId]);
  expect(result.get(otherClientId)).toEqual({ topics: [], issueAreas: [] });
  expect(result.get(clientId)!.topics[0]).toMatchObject({
    id: null,
    label: 'Hearing terms',
    position: 'monitor',
    priority: 'med',
    keywords: ['density', 'Hearing terms'],
  });
  expect(args(h.callsOf('watchlistTerm.findMany')[0]!).where).toMatchObject({
    OR: [{ topicId: null }],
  });
});

it('deduplicates single-client term buckets in their source order while using the real compiler and watchlist reads', async () => {
  const h = harness({
    results: {
      'watchlist.findFirst': watchlist({ issueAreas: ['Energy', 'energy'] }),
      'watchlistTerm.findMany': [
        term(),
        term({ id: 'syn', termType: 'synonym', value: 'Transmission' }),
        term({ id: 'entity', termType: 'entity', value: 'Acme' }),
        term({ id: 'risk', termType: 'risk', value: 'Outage' }),
      ],
    },
  });
  const result = await h.subject.compiledTopics(tenantId, clientId);
  expect(result.terms).toEqual(['Grid', 'Transmission', 'Acme', 'Outage', 'Energy', 'energy']);
  expect(result.issueAreas).toEqual(['Energy', 'energy']);
  expect(result.jurisdictions).toEqual(['US']);
  expect(result.topics[0]!.routableTerms!.some((row) => row.id === 'entity')).toBe(true);
  expect(h.callsOf('watchlist.findFirst')[0]!.transaction).not.toBe(
    h.callsOf('watchlistTopic.findMany')[0]!.transaction,
  );
  expect(h.callsOf('watchlistTopic.findMany')[0]!.transaction).not.toBe(
    h.callsOf('watchlistTerm.findMany')[0]!.transaction,
  );
});

it.each(['watchlist.findMany', 'watchlistTopic.findMany', 'watchlistTerm.findMany'])(
  'keeps %s batch failures fatal',
  async (operation) => {
    const failure = new Error(operation);
    const h = harness({ results: { [operation]: failure } });
    await expect(h.subject.compileTopicsForClients(tenantId, [clientId])).rejects.toBe(failure);
  },
);
