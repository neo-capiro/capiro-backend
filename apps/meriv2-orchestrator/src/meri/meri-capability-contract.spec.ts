import type { ConfigService } from '@nestjs/config';
import { ApprovalPendingError, createDelegatedTool } from '@capiro/meriv2-core';
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
import { WRITE_DELEGATED_TOOLS } from './write-tools.catalog.js';

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
  it('advertises attachment filing with a callable write handler only in full chat', () => {
    const { service } = registry();
    const metadata = MERI_CAPABILITY_REGISTRY.find((tool) => tool.name === 'save_chat_attachments');
    expect(metadata).toMatchObject({ backend: 'meri', readOnly: false, surfaces: ['full_chat'] });
    const handler = service.registry.get('save_chat_attachments');
    expect(handler).toMatchObject({ name: 'save_chat_attachments', readOnly: false });
    expect(typeof handler?.handler).toBe('function');
    expect(service.registry.executionMetadata('save_chat_attachments')).toMatchObject({
      executionMode: 'approval_required',
      externalEffect: 'crm_mutation',
    });
    expect(
      selectMeriCapabilitySchemas(
        MERI_CAPABILITY_REGISTRY,
        'full_chat',
        service.registry.list(),
      ).map((tool) => tool.name),
    ).toContain('save_chat_attachments');
    expect(
      selectMeriCapabilitySchemas(
        MERI_CAPABILITY_REGISTRY,
        'in_editor',
        service.registry.list(),
      ).map((tool) => tool.name),
    ).not.toContain('save_chat_attachments');
  });

  it('holds attachment filing for canonical approval before calling the API executor', async () => {
    const { service, execute } = registry();
    await expect(
      service.registry.invoke(
        'save_chat_attachments',
        { clientId: 'client-1', conversationId: 'conversation-1', attachmentIds: ['attachment-1'] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalPendingError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('the delegated attachment handler preserves authenticated caller, selected records and control', async () => {
    const { execute } = registry();
    const spec = WRITE_DELEGATED_TOOLS.find((tool) => tool.name === 'save_chat_attachments')!;
    const delegated = createDelegatedTool(spec, { execute });
    const input = {
      clientId: 'client-1',
      conversationId: 'conversation-1',
      attachmentIds: ['attachment-1', 'attachment-2'],
    };
    const control = { signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 };
    // Tests the bridge contract directly; production reaches this handler only
    // through the governed registry or the API's persisted approval execution.
    await delegated.handler(input, ctx, control);
    expect(execute).toHaveBeenCalledWith(ctx, 'save_chat_attachments', input, control);
  });

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
  it.each(['save_legiwatch_relevance', 'apply_legiwatch_suggestion'])(
    '%s requires the governed proposal before any API effect',
    async (name) => {
      const { service, execute } = registry();
      expect(service.registry.executionMetadata(name)).toMatchObject({
        executionMode: 'approval_required',
      });
      await expect(
        service.registry.invoke(
          name,
          {
            folderId: 'folder-1',
            suggestionId: 'suggestion-1',
            expectedVersion: 1,
            requestKey: 'request-1',
            action: 'add',
          },
          ctx,
        ),
      ).rejects.toBeInstanceOf(ApprovalPendingError);
      expect(execute).not.toHaveBeenCalled();
      expect(
        selectMeriCapabilitySchemas(
          MERI_CAPABILITY_REGISTRY,
          'in_editor',
          service.registry.list(),
        ).some((t) => t.name === name),
      ).toBe(false);
    },
  );
  it.each(['get_legiwatch_review', 'preview_legiwatch_relevance'])(
    '%s preserves selected folder/session and caller in full chat',
    async (name) => {
      const { service, execute } = registry(),
        input = {
          view: 'suggestions',
          folderId: 'folder-1',
          jurisdiction: 'FL',
          sessionKey: '2026',
        },
        control = { signal: new AbortController().signal, deadlineAt: Date.now() + 10000 };
      await service.registry.invoke(name, input, ctx, control);
      expect(execute).toHaveBeenCalledWith(ctx, name, input, control);
    },
  );

  it.each(MERI_FEDERAL_MARKET_TOOL_DEFINITIONS.map(({ name }) => name))(
    '%s reaches the existing authenticated API executor',
    async (name) => {
      const { service, execute } = registry();
      const input =
        name === 'get_district_federal_market'
          ? { state: 'VA', district: '10' }
          : { query: 'autonomy', limit: 10 };
      const control = { signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 };
      await service.registry.invoke(name, input, ctx, control);
      expect(execute).toHaveBeenCalledWith(ctx, name, input, control);
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
