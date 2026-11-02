import { parseCacheArgs } from './import-state-dataset-cache.js';
const host = 'capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com';
const args = [
  '--state',
  'NY',
  '--session',
  '2188',
  '--expected-bills',
  '25453',
  '--archive',
  'synthetic.zip',
  '--sha256',
  'a'.repeat(64),
];
it('allows offline preview without a database or API key and bounded inventory-only staging', () => {
  expect(parseCacheArgs(args, {})).toMatchObject({
    commit: false,
    expectedBills: 25453,
    limit: 100,
  });
  expect(
    parseCacheArgs([...args, '--commit', '--inventory-only', '--expected-host', host], {
      DATABASE_URL: `postgresql://a:b@${host}/capiro`,
    }),
  ).toMatchObject({ inventoryOnly: true, commit: true });
});
it('rejects ambiguous byte sources, wrong clone/schema, unbounded limits and unknown arguments', () => {
  for (const extra of [
    ['--archive-hash', 'a'.repeat(64)],
    ['--limit', '1001'],
    ['--provider'],
    ['--commit', '--expected-host', 'wrong'],
  ])
    expect(() =>
      parseCacheArgs([...args, ...extra], { DATABASE_URL: `postgresql://a:b@${host}/capiro` }),
    ).toThrow();
  for (const url of [`postgresql://a:b@localhost/capiro`, `postgresql://a:b@${host}/wrong`])
    expect(() =>
      parseCacheArgs([...args, '--commit', '--expected-host', host], { DATABASE_URL: url }),
    ).toThrow('DATABASE_MISMATCH');
});
it('allows a bounded format-only phase without metadata reimport and rejects conflicting phases', () => {
  expect(parseCacheArgs([...args, '--formats-only', '--limit', '1'], {})).toMatchObject({
    formatsOnly: true,
    inventoryOnly: false,
    limit: 1,
  });
  expect(() => parseCacheArgs([...args, '--formats-only', '--inventory-only'], {})).toThrow(
    'INVALID_CACHE_SCOPE',
  );
});
