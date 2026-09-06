import type { ConfigService } from '@nestjs/config';
import {
  MERI_CAPABILITY_REGISTRY,
  MERI_FEDERAL_MARKET_TOOL_DEFINITIONS,
  assertMeriCapabilityHandlers,
  meriCapabilitiesForSurface,
  selectMeriCapabilitySchemas,
} from '@capiro/shared';
import { MeriRegistryService } from './meri-registry.service.js';
import type { ApiClientContextRepo } from './api-client-context.repo.js';
import type { ApiToolExecutorRepo } from './api-tool-executor.repo.js';

const ctx = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user' as const,
};

function registry() {
  const execute = jest.fn().mockResolvedValue({ items: [], total: 0 });
  const service = new MeriRegistryService(
    { loadClientContext: jest.fn() } as unknown as ApiClientContextRepo,
    { execute } as unknown as ApiToolExecutorRepo,
    { get: () => undefined } as unknown as ConfigService,
  );
  return { service, execute };
}

describe('native capability registration contract', () => {
  it('every capability intended for full chat has an actual callable registration', () => {
    const { service } = registry();
    expect(() => assertMeriCapabilityHandlers(service.registry.list())).not.toThrow();
    const selected = selectMeriCapabilitySchemas(
      MERI_CAPABILITY_REGISTRY,
      'full_chat',
      service.registry.list(),
    );
    expect(selected.map((tool) => tool.name)).toEqual(
      MERI_CAPABILITY_REGISTRY.map((tool) => tool.name),
    );
  });

  it.each(MERI_FEDERAL_MARKET_TOOL_DEFINITIONS.map(({ name }) => name))(
    '%s reaches the existing authenticated API executor',
    async (name) => {
      const { service, execute } = registry();
      const input =
        name === 'get_district_federal_market'
          ? { state: 'VA', district: '10' }
          : { query: 'autonomy', limit: 10 };
      await service.registry.invoke(name, input, ctx);
      expect(execute).toHaveBeenCalledWith(ctx, name, input);
    },
  );

  it('rejects a missing handler instead of silently dropping an intended capability', () => {
    const names = MERI_CAPABILITY_REGISTRY.map((tool) => tool.name).filter(
      (name) => name !== 'search_procurement_forecasts',
    );
    expect(() => assertMeriCapabilityHandlers(names)).toThrow('search_procurement_forecasts');
    expect(
      selectMeriCapabilitySchemas(MERI_CAPABILITY_REGISTRY, 'full_chat', names).some(
        (tool) => tool.name === 'search_procurement_forecasts',
      ),
    ).toBe(false);
  });

  it('keeps unknown/internal schemas and full-chat-only tools out of the editor', () => {
    const extra = { name: 'unreviewed_api_write' };
    const schemas = [...MERI_CAPABILITY_REGISTRY, extra, { name: 'tag_live_policy_mentions' }];
    const callable = schemas.map((tool) => tool.name);
    const full = selectMeriCapabilitySchemas(schemas, 'full_chat', callable);
    expect(full).not.toContain(extra);
    expect(full.some((tool) => tool.name === 'tag_live_policy_mentions')).toBe(false);
    const editor = selectMeriCapabilitySchemas(schemas, 'in_editor', callable);
    expect(editor.map((tool) => tool.name)).toEqual(
      meriCapabilitiesForSurface('in_editor').map((tool) => tool.name),
    );
    expect(editor.some((tool) => tool.name === 'send_email')).toBe(false);
    for (const { name } of MERI_FEDERAL_MARKET_TOOL_DEFINITIONS)
      expect(editor.some((tool) => tool.name === name)).toBe(false);
  });

  it('does not advertise duplicate schemas', () => {
    const schema = { name: 'search_procurement_forecasts' };
    expect(selectMeriCapabilitySchemas([schema, schema], 'full_chat', [schema.name])).toEqual([
      schema,
    ]);
  });
});
