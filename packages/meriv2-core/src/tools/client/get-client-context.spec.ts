import {
  createGetClientContextTool,
  type ClientContextRepo,
  type ClientContextResult,
  type GetClientContextInput,
} from './get-client-context';
import { InMemoryToolRegistry } from '../../registry/tool-registry';
import { ToolInputValidationError, type MeriContext } from '../../registry/types';
import { ScopingError } from '../../scoping/scoping-wrapper';

const ctx: MeriContext = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  clerkUserId: 'clerk_1',
  role: 'standard_user',
};

const VALID_CLIENT_ID = '11111111-1111-4111-8111-111111111111';

function fakeRepo() {
  const seen: {
    ctx: MeriContext;
    clientId: string;
    options?: Omit<GetClientContextInput, 'clientId'>;
  }[] = [];
  const repo: ClientContextRepo = {
    async loadClientContext(c, clientId, options) {
      seen.push({ ctx: c, clientId, options });
      const result: ClientContextResult = { client: { id: clientId, name: 'Acme' } };
      return result;
    },
  };
  return { repo, seen };
}

describe('get_client_context tool', () => {
  it('registers and invokes, forwarding the scoped context to the repo', async () => {
    const { repo, seen } = fakeRepo();
    const registry = new InMemoryToolRegistry();
    registry.register(createGetClientContextTool(repo));

    expect(registry.list()).toContain('get_client_context');

    const out = await registry.invoke<ClientContextResult>(
      'get_client_context',
      { clientId: VALID_CLIENT_ID },
      ctx,
    );

    expect(out.client.id).toBe(VALID_CLIENT_ID);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.ctx.tenantId).toBe('tenant-1');
    expect(seen[0]?.ctx.userId).toBe('user-1');
    expect(seen[0]?.clientId).toBe(VALID_CLIENT_ID);
  });

  it('rejects a non-uuid clientId before reaching the repo', async () => {
    const { repo, seen } = fakeRepo();
    const registry = new InMemoryToolRegistry();
    registry.register(createGetClientContextTool(repo));

    await expect(
      registry.invoke('get_client_context', { clientId: 'not-a-uuid' }, ctx),
    ).rejects.toBeInstanceOf(ToolInputValidationError);
    expect(seen).toHaveLength(0);
  });

  it('cannot run without a valid tenant context (scoping enforced by the registry)', async () => {
    const { repo, seen } = fakeRepo();
    const registry = new InMemoryToolRegistry();
    registry.register(createGetClientContextTool(repo));

    const noTenant: MeriContext = { ...ctx, tenantId: '' };
    await expect(
      registry.invoke('get_client_context', { clientId: VALID_CLIENT_ID }, noTenant),
    ).rejects.toBeInstanceOf(ScopingError);
    expect(seen).toHaveLength(0);
  });

  it('is read-only', () => {
    const { repo } = fakeRepo();
    expect(createGetClientContextTool(repo).readOnly).toBe(true);
  });

  it.each(['submissionHistory', 'advocacyMatters', 'advocacyRecords'] as const)('preserves %s inventory options through the native registry', async (section) => {
    const { repo, seen } = fakeRepo();
    const registry = new InMemoryToolRegistry();
    registry.register(createGetClientContextTool(repo));
    await registry.invoke(
      'get_client_context',
      {
        clientId: VALID_CLIENT_ID,
        section,
        cursor: 'next-page',
        limit: 50,
        representation: 'summary',
      },
      ctx,
    );
    expect(seen[0]?.options).toEqual({
      section,
      cursor: 'next-page',
      limit: 50,
      representation: 'summary',
    });
  });

  it.each([{ section: 'secrets' }, { limit: 51 }, { limit: 0 }, { limit: 1.5 }, { representation: 'all' }])(
    'rejects unsupported profile options %p',
    async (options) => {
      const { repo, seen } = fakeRepo();
      const registry = new InMemoryToolRegistry();
      registry.register(createGetClientContextTool(repo));
      await expect(
        registry.invoke('get_client_context', { clientId: VALID_CLIENT_ID, ...options }, ctx),
      ).rejects.toBeInstanceOf(ToolInputValidationError);
      expect(seen).toHaveLength(0);
    },
  );
});
