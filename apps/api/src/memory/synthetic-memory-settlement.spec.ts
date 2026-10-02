import { MemoryCandidateService } from './memory-candidate.service.js';
import { ImmutableMemoryVersionService } from './immutable-memory-version.service.js';
import { embedAndUpsert } from '../embeddings/embedder.js';

jest.mock('../embeddings/embedder.js', () => ({ embedAndUpsert: jest.fn() }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const ctx = { tenantId: 'tenant', userId: 'reviewer', role: 'standard_user' } as any;
const oldLifecycle = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
const oldCenter = process.env.MEMORY_GOVERNANCE_CENTER;
const oldEnforce = process.env.MEMORY_GOVERNANCE_ENFORCE;
const oldTenants = process.env.MEMORY_GOVERNANCE_TENANTS;
beforeEach(() => {
  process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
  process.env.MEMORY_GOVERNANCE_CENTER = 'enforce';
  process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
  process.env.MEMORY_GOVERNANCE_TENANTS = 'all';
  jest.clearAllMocks();
});
afterAll(() => {
  if (oldLifecycle === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  else process.env.MEMORY_GOVERNANCE_LIFECYCLE = oldLifecycle;
  if (oldCenter === undefined) delete process.env.MEMORY_GOVERNANCE_CENTER;
  else process.env.MEMORY_GOVERNANCE_CENTER = oldCenter;
  if (oldEnforce === undefined) delete process.env.MEMORY_GOVERNANCE_ENFORCE;
  else process.env.MEMORY_GOVERNANCE_ENFORCE = oldEnforce;
  if (oldTenants === undefined) delete process.env.MEMORY_GOVERNANCE_TENANTS;
  else process.env.MEMORY_GOVERNANCE_TENANTS = oldTenants;
});

/** These tests isolate post-commit ordering. Real SQL/guard authorization is
 * covered by the canonical owned PostgreSQL suites, not asserted by these mocks. */
function candidate() {
  const legacy = deferred(),
    projection = deferred();
  const prisma = {
    withTenantUser: jest.fn(async () => ({
      memoryId: 'clio',
      record: { key: 'key', value: 'value' },
    })),
  };
  const outbox = { markIndexedOnFastPath: jest.fn(async () => undefined) };
  const service = new MemoryCandidateService(
    prisma as any,
    { projectClioMemory: jest.fn(() => projection.promise) } as any,
    { get: () => undefined } as any,
    {} as any,
    outbox as any,
    {} as any,
  );
  (service as any).embedMemory = jest.fn(() => legacy.promise);
  return { service, legacy, projection, outbox };
}

it('guarded synthetic approval waits for both actual branches and final outbox callback', async () => {
  const { service, legacy, projection, outbox } = candidate();
  let settled = false;
  const result = service
    .approveSyntheticFixture('tenant', 'candidate', 'reviewer', ctx, {} as any)
    .then((row) => {
      settled = true;
      return row;
    });
  await tick();
  assertPending();
  projection.resolve();
  await tick();
  assertPending();
  legacy.resolve();
  await expect(result).resolves.toEqual({ memoryId: 'clio' });
  expect(outbox.markIndexedOnFastPath).toHaveBeenCalledTimes(1);
  function assertPending() {
    expect(settled).toBe(false);
    expect(outbox.markIndexedOnFastPath).not.toHaveBeenCalled();
  }
});

it('synthetic branch failure waits for remaining branch and fails honestly without marking indexed', async () => {
  const { service, legacy, projection, outbox } = candidate();
  let settled = false;
  const result = service
    .approveSyntheticFixture('tenant', 'candidate', 'reviewer', ctx, {} as any)
    .then(
      () => 'unexpected',
      (error: Error) => {
        settled = true;
        return error.message;
      },
    );
  projection.reject(new Error('private provider response'));
  await tick();
  expect(settled).toBe(false);
  legacy.resolve();
  expect(await result).toBe('Synthetic memory projection did not settle after approval');
  expect(outbox.markIndexedOnFastPath).not.toHaveBeenCalled();
});

it('ordinary approval preserves existing asynchronous behavior', async () => {
  const { service, legacy, projection } = candidate();
  await expect(service.approve('tenant', 'candidate', 'reviewer', ctx)).resolves.toEqual({
    memoryId: 'clio',
  });
  legacy.resolve();
  projection.resolve();
  await tick();
});

it('synthetic legacy embedding has an abort deadline without claiming optional vector authority', async () => {
  const abort = new AbortController();
  const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(abort.signal);
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    expect(options?.signal).toBe(abort.signal);
    return new Promise((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  const service = new MemoryCandidateService(
    {} as any,
    {} as any,
    { get: () => 'synthetic-noncredential-test-value' } as any,
  );
  try {
    const result = (service as any).embedMemory('tenant', 'item', 'key', 'value', true);
    const assertion = expect(result).rejects.toThrow('aborted');
    expect(timeout).toHaveBeenCalledWith(20_000);
    abort.abort();
    await assertion;
  } finally {
    fetch.mockRestore();
    timeout.mockRestore();
  }
});

function versions() {
  const embedding = deferred();
  jest.mocked(embedAndUpsert).mockImplementation(() => embedding.promise as any);
  const outcome = {
    result: { candidateId: 'candidate', outcome: 'activated' },
    embed: { tenantId: 'tenant', memoryItemId: 'item', title: 'title', body: 'body' },
  };
  const service = new ImmutableMemoryVersionService(
    { withTenantUser: jest.fn(async () => outcome) } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { service, embedding, outcome };
}

it('guarded synthetic correction waits for real embedding completion', async () => {
  const { service, embedding, outcome } = versions();
  let settled = false;
  const result = service.approveSyntheticCorrection(ctx, 'candidate', {} as any).then((row) => {
    settled = true;
    return row;
  });
  await tick();
  expect(settled).toBe(false);
  embedding.resolve();
  await expect(result).resolves.toEqual(outcome.result);
  expect(embedAndUpsert).toHaveBeenCalledTimes(1);
});

it('guarded synthetic correction propagates sanitized post-commit embedding failure', async () => {
  const { service, embedding } = versions();
  const result = service.approveSyntheticCorrection(ctx, 'candidate', {} as any);
  const assertion = expect(result).rejects.toThrow(
    'Synthetic memory correction embedding did not settle after approval',
  );
  embedding.reject(new Error('private provider response'));
  await assertion;
});

it('ordinary correction approval keeps its asynchronous embedding behavior', async () => {
  const { service, embedding, outcome } = versions();
  await expect(service.approveCandidate(ctx, 'candidate')).resolves.toEqual(outcome.result);
  embedding.resolve();
  await tick();
});
