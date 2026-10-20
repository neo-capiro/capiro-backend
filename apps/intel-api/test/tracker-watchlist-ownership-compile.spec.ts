import { readHarness } from './fixtures/tracker-watchlist-ownership/read-io.js';
import {
  CLIENT,
  TENANT,
  namesWithoutScopes,
  replacePrivate,
} from './fixtures/tracker-watchlist-ownership/io.js';
import { surfaceRoutes } from './fixtures/tracker-watchlist-ownership/literals.js';

it('compiled view reads real scoped rows and preserves canonical ids, routes and recomputed weights', async () => {
  const h = readHarness();
  h.rows.topics = [
    { id: 'topic-signal', label: 'Signal', issueArea: null, position: 'monitor', priority: 'high' },
  ];
  h.rows.terms = [
    { id: 'rtx-id', topicId: 'topic-signal', termType: 'company', value: 'RTX', weight: 999 },
    {
      id: 'native-id',
      topicId: 'topic-signal',
      termType: 'native_type',
      value: 'hearing-only',
      weight: 999,
    },
    {
      id: 'grid-id',
      topicId: 'topic-signal',
      termType: 'keyword',
      value: 'grid load',
      weight: 999,
    },
  ];
  const compiled = await h.service.getCompiled(TENANT, CLIENT);
  expect(compiled).toEqual({
    issueAreas: ['Energy'],
    jurisdictions: ['CA'],
    termSurfaces: surfaceRoutes,
    billMatchSet: [
      {
        id: 'topic-signal',
        label: 'Signal',
        issueArea: null,
        position: 'monitor',
        priority: 'high',
        keywords: ['grid load', 'Signal'],
        synonyms: [],
        entities: [],
        riskPhrases: [],
        routableTerms: [
          {
            id: 'rtx-id',
            topicId: 'topic-signal',
            topicLabel: 'Signal',
            termType: 'company',
            value: 'RTX',
            topicPriority: 'high',
          },
          {
            id: 'grid-id',
            topicId: 'topic-signal',
            topicLabel: 'Signal',
            termType: 'keyword',
            value: 'grid load',
            topicPriority: 'high',
          },
          {
            id: null,
            topicId: 'topic-signal',
            topicLabel: 'Signal',
            termType: 'keyword',
            value: 'Signal',
            topicPriority: 'high',
          },
        ],
      },
    ],
    hearingTerms: [
      { value: 'RTX', weight: 6.25 },
      { value: 'hearing-only', weight: 1 },
      { value: 'grid load', weight: 2.5 },
    ],
    deepgramKeyterms: ['grid load', 'hearing-only', 'rtx'],
    truncatedTopics: [],
  });
  expect(namesWithoutScopes(h.tape)).toEqual(['read.head', 'read.topics', 'read.terms']);
});

it('compiler retains uppercase short identifiers while rejecting lowercase fragments', async () => {
  const h = readHarness();
  h.rows.topics = [
    { id: 'topic-id', label: 'Signals', issueArea: 'Energy', position: 'oppose', priority: 'low' },
  ];
  h.rows.terms = [
    { id: 'ai', topicId: 'topic-id', termType: 'keyword', value: 'AI' },
    { id: 'of', topicId: 'topic-id', termType: 'keyword', value: 'of' },
  ];
  const compiled = await h.service.getCompiled(TENANT, CLIENT);
  expect(compiled.hearingTerms).toEqual([{ value: 'AI', weight: 1.5 }]);
  expect(compiled.deepgramKeyterms).toEqual(['ai']);
  expect(compiled.billMatchSet[0]!.routableTerms.map((term) => term.value)).toEqual([
    'AI',
    'Signals',
  ]);
  expect(compiled.billMatchSet[0]!.routableTerms[0]!.id).toBe('ai');
});

it('compiler surfaces truncation on the current logger after awaited watchlist I/O', async () => {
  const h = readHarness();
  h.rows.topics = [
    { id: 'topic-id', label: 'Signal', issueArea: null, position: 'monitor', priority: 'high' },
  ];
  h.rows.terms = [
    { id: 'company', topicId: 'topic-id', termType: 'company', value: 'RTX' },
    ...Array.from({ length: 101 }, (_, index) => ({
      id: `term-${index}`,
      topicId: 'topic-id',
      termType: 'keyword',
      value: `term${String(index).padStart(3, '0')}`,
    })),
  ];
  const gate = h.tape.pause('read.terms');
  const request = h.service.getCompiled(TENANT, CLIENT);
  await gate.started.promise;
  const replacement = { warn: jest.fn() };
  replacePrivate(h.service, 'logger', replacement);
  gate.release.resolve();
  const compiled = await request;
  expect(compiled.truncatedTopics).toEqual([{ label: 'Signal', kept: 100, dropped: 3 }]);
  expect(compiled.billMatchSet[0]!.routableTerms).toHaveLength(100);
  expect(compiled.billMatchSet[0]!.routableTerms[0]).toMatchObject({ id: 'company', value: 'RTX' });
  expect(compiled.deepgramKeyterms).toHaveLength(100);
  expect(compiled.deepgramKeyterms).toContain('rtx');
  expect(replacement.warn).toHaveBeenCalledWith(
    `watchlist term cap hit: client=${CLIENT} topic="Signal" kept=100 dropped=3 — the dropped (lowest-weight) terms do not affect bill matching`,
  );
  expect(h.logger.warn).not.toHaveBeenCalled();
});

it('compiler does not swallow a current logger failure after canonical truncation', async () => {
  const h = readHarness();
  h.rows.topics = [
    { id: 'topic-id', label: 'Signal', issueArea: null, position: 'monitor', priority: 'med' },
  ];
  h.rows.terms = Array.from({ length: 101 }, (_, index) => ({
    id: `term-${index}`,
    topicId: 'topic-id',
    termType: 'keyword',
    value: `term${index}`,
  }));
  replacePrivate(h.service, 'logger', {
    warn: (): never => {
      throw new Error('logger unavailable');
    },
  });
  await expect(h.service.getCompiled(TENANT, CLIENT)).rejects.toThrow('logger unavailable');
});
