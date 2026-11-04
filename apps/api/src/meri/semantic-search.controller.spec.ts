import { EventEmitter } from 'node:events';
import type { TenantContext } from '@capiro/shared';
import { SemanticSearchController } from './semantic-search.controller.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'standard_user',
} as TenantContext;

function request(verified = true) {
  const req = Object.assign(new EventEmitter(), {
    headers: { 'x-internal-service-secret': 'synthetic-service' },
  });
  if (verified)
    new ToolServiceSecretGuard({
      get: (key: string) =>
        key === 'INTERNAL_SERVICE_SECRET' ? 'synthetic-service' : key === 'NODE_ENV' ? 'test' : false,
    } as never).verifyRequest(req as never);
  return req;
}

const routes = [
  ['bills', 'semantic_search_bills'],
  ['grants', 'semantic_search_grants'],
  ['contractOpportunities', 'semantic_search_contract_opportunities'],
  ['dibbsSolicitations', 'semantic_search_dibbs_solicitations'],
  ['sbirTopics', 'semantic_search_sbir_topics'],
] as const;

test('the fixed semantic receivers require actual service proof, not a header alone', async () => {
  const owner = { read: jest.fn(async () => ({ tool: 'x', results: [] })) };
  const controller = new SemanticSearchController(owner as never);
  for (const [method] of routes)
    expect(() => controller[method](ctx, { query: 'water' }, request(false) as never)).toThrow(
      'Internal service required',
    );
  expect(owner.read).not.toHaveBeenCalled();
  for (const [method, operation] of routes) {
    await controller[method](ctx, { query: 'water' }, request() as never);
    expect(owner.read).toHaveBeenLastCalledWith(ctx, operation, { query: 'water' });
  }
});

test('deployment allowlist still refuses an unallocated semantic read', () => {
  const previous = process.env.MERI_TOOL_ALLOWLIST;
  process.env.MERI_TOOL_ALLOWLIST = 'semantic_search_bills';
  try {
    const owner = { read: jest.fn(async () => ({})) };
    const controller = new SemanticSearchController(owner as never);
    expect(() => controller.grants(ctx, { query: 'water' }, request() as never)).toThrow();
    expect(() => controller.dibbsSolicitations(ctx, { query: 'water' }, request() as never)).toThrow();
    expect(() => controller.sbirTopics(ctx, { query: 'water' }, request() as never)).toThrow();
    expect(owner.read).not.toHaveBeenCalled();
    expect(() => controller.bills(ctx, { query: 'water' }, request() as never)).not.toThrow();
  } finally {
    if (previous === undefined) delete process.env.MERI_TOOL_ALLOWLIST;
    else process.env.MERI_TOOL_ALLOWLIST = previous;
  }
});

test('the owner result is returned unchanged under the request deadline', async () => {
  const owner = { read: jest.fn(async () => ({ tool: 'semantic_search_bills', total: 0, results: [] })) };
  const controller = new SemanticSearchController(owner as never);
  const req = Object.assign(request(), { res: { writableEnded: false, destroyed: false, once: () => undefined, removeListener: () => undefined } });
  await expect(controller.bills(ctx, { query: 'water' }, req as never)).resolves.toEqual({
    tool: 'semantic_search_bills', total: 0, results: [],
  });
});
