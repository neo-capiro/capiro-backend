import { ClientProfileFillCompletionService } from '../../src/clients/client-profile-fill-completion.service.js';

// Shared DB-free fixture for the unchanged service facade and canonical owners.
const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as never;
export const clientId = 'client-1';
export const runId = 'run-1';
export const base = 'https://api.regulations.gov/v4/comments';
export const apiKey = 'characterization-key';
export const now = new Date('2026-10-13T12:00:00.000Z');
const originalKey = process.env.REGULATIONS_GOV_API_KEY;
export let fetchMock: jest.SpyInstance;
export async function expectProgress(
  pending: Promise<unknown>,
  count: number,
  backfill: Record<string, unknown>,
) {
  expect(await pending).toMatchObject({ count, backfill });
}
export function detail(commentId: string) {
  return {
    commentId,
    docketId: 'DOD-2026-1',
    agencyId: 'DOD',
    commentText: 'Text '.repeat(110),
    firstName: 'Carl',
    lastName: 'McNair',
    organization: 'Acme & Partners',
    city: 'Arlington',
    stateProvince: 'VA',
    country: 'USA',
    postedDate: new Date('2026-01-02T00:00:00.000Z'),
    sourceUrl: `${base}/${encodeURIComponent(commentId)}`,
  };
}
export function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: jest.fn().mockResolvedValue(body) };
}
export function search(ids: string[], totalElements?: unknown) {
  fetchMock.mockResolvedValueOnce(
    response({ data: ids.map((id) => ({ id })), meta: { totalElements } }),
  );
}
export function harness(
  name: string | null = 'Acme & Partners',
  confirmed: string[] = [],
  inserted: number[] = [],
) {
  const tx = {
    client: { findFirst: jest.fn().mockResolvedValue({ id: clientId, name }) },
    clientIntelMapping: {
      findMany: jest.fn().mockResolvedValue(confirmed.map((externalId) => ({ externalId }))),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    $executeRawUnsafe: jest.fn(async (sql: string, ..._args: unknown[]) =>
      sql.includes('INSERT INTO client_profile_fill_finding') ? (inserted.shift() ?? 1) : 1,
    ),
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, fn: (value: typeof tx) => unknown) => fn(tx)),
    regulatoryComment: {
      findUnique: jest.fn(async ({ where }: { where: { commentId: string } }) =>
        detail(where.commentId),
      ),
      upsert: jest.fn().mockResolvedValue({ commentId: 'ignored-upsert-result' }),
    },
  };
  const service = new ClientProfileFillCompletionService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const warning = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
  const gather = (currentCount = 0, prior: Record<string, unknown> = {}) =>
    (service as any).gatherRegulatoryCommentAdvocacyCandidates(
      ctx,
      clientId,
      runId,
      currentCount,
      prior,
    );
  const cache = (id = 'comment/one') =>
    (service as any).fetchOrCacheRegulatoryCommentDetail(id, apiKey);
  const writes = () =>
    tx.$executeRawUnsafe.mock.calls.filter(([sql]) =>
      sql.includes('INSERT INTO client_profile_fill_finding'),
    );
  return { service, tx, prisma, warning, gather, cache, writes };
}

export function installCharacterizationHooks() {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    process.env.REGULATIONS_GOV_API_KEY = apiKey;
    // Every test installs this fail-closed stub, including early-return/cache tests.
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected HTTP request in characterization'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    if (originalKey === undefined) delete process.env.REGULATIONS_GOV_API_KEY;
    else process.env.REGULATIONS_GOV_API_KEY = originalKey;
  });
}
