import { createHash } from 'node:crypto';
import { ALL_US_STATE_CODES } from '../external/legiscan/us-states.js';
import { inspectStateDiscovery, retainStateDiscovery } from './state-discovery-inventory.js';
import { parseDiscoveryArgs } from '../../scripts/import-state-discovery.js';
jest.mock('./state-bill-writer.js', () => ({
  withStateBillWriter: (db: any, states: string[], run: any) => {
    expect(states).toHaveLength(51);
    return run(db);
  },
}));
const source = () => ({
  scope: 'Parent history/progress event in [2025-10-01,2026-10-01); all listed versions retained',
  completeStates: 51,
  sourceCommit: 'a'.repeat(40),
  updatedAt: '2026-11-01T21:13:04.739123+00:00',
  states: ALL_US_STATE_CODES.map((state, i) => ({
    state,
    status: 'complete',
    sessions:
      i === 0
        ? [{ id: 1, archiveSha256: 'b'.repeat(64), bills: 25453, archiveBytes: 72977876 }]
        : [],
  })),
});
const encode = (value: any) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
};
it('pins every jurisdiction including explicit empty discovery and exact session/archive counts', () => {
  const { bytes, hash } = encode(source()),
    manifest = inspectStateDiscovery(bytes, hash);
  expect(manifest.states).toHaveLength(51);
  expect(manifest.states.filter((s) => s.sessions.length === 0)).toHaveLength(50);
  expect(manifest.states.flatMap((s) => s.sessions)).toEqual([
    { sessionId: 1, archiveHash: 'b'.repeat(64), expectedBills: 25453 },
  ]);
});
it('rejects missing/duplicate states, incomplete discovery, duplicate sessions, bad archive identity/counts and wrong bytes', () => {
  const mutations = [
    (s: any) => s.states.pop(),
    (s: any) => (s.states[1] = s.states[0]),
    (s: any) => (s.states[0].status = 'failed'),
    (s: any) => (s.states[1].sessions = s.states[0].sessions),
    (s: any) => (s.states[0].sessions[0].archiveSha256 = 'latest'),
    (s: any) => (s.states[0].sessions[0].bills = 50001),
    (s: any) => (s.scope = 'all historical bills'),
    (s: any) => (s.completeStates = 50),
  ];
  for (const mutate of mutations) {
    const s = source();
    mutate(s);
    const { bytes, hash } = encode(s);
    expect(() => inspectStateDiscovery(bytes, hash)).toThrow();
  }
  const { bytes } = encode(source());
  expect(() => inspectStateDiscovery(bytes, 'c'.repeat(64))).toThrow('HASH');
});
it('retains exact bytes and immutable receipt together without touching metadata', async () => {
  const { bytes, hash } = encode(source());
  const db: any = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(async (_sql: any, id: string) => [{ id }]),
  };
  db.$transaction = jest.fn((fn: any) => fn(db));
  expect(await retainStateDiscovery(db, bytes, hash)).toMatchObject({
    manifestSha256: hash,
    jurisdictions: 51,
    sessions: 1,
    providerCalls: 0,
  });
  expect(db.$executeRaw.mock.calls[0].slice(1)).toEqual([hash, bytes.toString('base64')]);
  expect(db.$executeRaw.mock.calls[1][0].join('')).toContain('fy26-state-discovery');
  db.$queryRaw.mockResolvedValue([]);
  await expect(retainStateDiscovery(db, bytes, hash)).rejects.toThrow('IMMUTABLE_RECEIPT_CONFLICT');
});
it('supports offline preview and rejects commit to a foreign database before writes', () => {
  const args = ['--manifest', 'synthetic.json', '--sha256', 'a'.repeat(64)];
  expect(parseDiscoveryArgs(args, {})).toMatchObject({ commit: false });
  expect(() =>
    parseDiscoveryArgs([...args, '--commit', '--expected-host', 'localhost'], {
      DATABASE_URL: 'postgresql://a:b@localhost/capiro',
    }),
  ).toThrow('DATABASE_MISMATCH');
  expect(() => parseDiscoveryArgs([...args, '--provider'], {})).toThrow('UNKNOWN');
});
