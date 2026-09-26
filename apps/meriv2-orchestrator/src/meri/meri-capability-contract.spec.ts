import type { ConfigService } from '@nestjs/config';
import { ApprovalPendingError, createDelegatedTool } from '@capiro/meriv2-core';
import {
  MERI_CAPABILITY_REGISTRY,
  MERI_FEDERAL_MARKET_TOOL_DEFINITIONS,
  MERI_TOOL_MANIFEST,
  assertMeriCapabilityHandlers,
  meriCapabilitiesForSurface,
  selectMeriCapabilitySchemas,
  type MeriCapabilityDefinition,
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
  it('defines distinct bounded contracts for the three overlapping search capabilities', () => {
    const contracts = Object.fromEntries(
      MERI_CAPABILITY_REGISTRY.filter((tool) =>
        ['search_capiro_data', 'search_research_sources', 'search_client_knowledge'].includes(
          tool.name,
        ),
      ).map((tool) => [tool.name, tool as MeriCapabilityDefinition]),
    ) as Record<string, MeriCapabilityDefinition>;
    expect(Object.keys(contracts).sort()).toEqual([
      'search_capiro_data',
      'search_client_knowledge',
      'search_research_sources',
    ]);
    for (const tool of Object.values(contracts)) {
      expect(tool.searchContract).toMatchObject({
        contractRole: 'advisory_only',
        purpose: expect.any(String),
        exclusions: expect.arrayContaining([expect.any(String)]),
        supportedScopes: expect.arrayContaining([expect.any(String)]),
        prerequisites: expect.arrayContaining([expect.any(String)]),
        evidenceAuthority: expect.any(String),
        availabilityReasonCodes: expect.arrayContaining([expect.any(String)]),
      });
      expect(tool.description).not.toMatch(/use this first/i);
    }
    expect(contracts.search_capiro_data!.searchContract?.exclusions).toContain(
      'Exact page or section extraction from a client document.',
    );
    expect(contracts.search_research_sources!.searchContract?.supportedScopes).toContain(
      'cross-record internal research search',
    );
    expect(contracts.search_client_knowledge!.searchContract?.supportedScopes).toContain(
      'one authorized selected client',
    );
  });

  it.each([
    ['specific client profile question', 'search_client_knowledge', 'one selected client'],
    ['exact uploaded document passage', 'search_client_knowledge', 'Exact document text'],
    ['multi-domain Capiro query', 'search_capiro_data', 'cross-domain'],
    ['meeting and mail discovery', 'search_research_sources', 'meetings, mail'],
  ])('records the correct boundary for %s', (_caseName, contractTool, expectedPhrase) => {
    const byName = Object.fromEntries(
      MERI_CAPABILITY_REGISTRY.map((tool) => [tool.name, tool as MeriCapabilityDefinition]),
    ) as Record<string, MeriCapabilityDefinition>;
    const currentTool = byName[contractTool]!;
    const contract = currentTool.searchContract!;
    const guidance = [
      currentTool.description,
      contract.purpose,
      ...contract.exclusions,
      ...contract.supportedScopes,
    ].join(' ');
    expect(guidance.toLowerCase()).toContain(expectedPhrase.toLowerCase());
    if (_caseName === 'exact uploaded document passage') {
      expect(byName.read_client_documents).toBeDefined();
      expect(byName.search_capiro_data!.searchContract!.exclusions.join(' ')).toMatch(
        /exact page|section/i,
      );
    }
  });

  it('preserves search handlers, schemas, and declared surfaces while adding descriptive metadata', () => {
    const { service } = registry();
    const expectedSurfaces = {
      search_capiro_data: ['full_chat'],
      search_research_sources: ['full_chat', 'in_editor'],
      search_client_knowledge: ['full_chat', 'in_editor'],
    };
    for (const [name, surfaces] of Object.entries(expectedSurfaces)) {
      const metadata = MERI_CAPABILITY_REGISTRY.find(
        (tool) => tool.name === name,
      )! as MeriCapabilityDefinition;
      const handler = service.registry.get(name);
      expect(metadata).toMatchObject({ backend: 'meri', readOnly: true, surfaces });
      expect(typeof handler?.handler).toBe('function');
      expect(handler?.readOnly).toBe(true);
      expect(
        selectMeriCapabilitySchemas(
          MERI_CAPABILITY_REGISTRY,
          'full_chat',
          service.registry.list(),
        ).map((tool) => tool.name),
      ).toContain(name);
      expect(
        selectMeriCapabilitySchemas(MERI_CAPABILITY_REGISTRY, 'in_editor', service.registry.list())
          .map((tool) => tool.name)
          .includes(name as (typeof MERI_CAPABILITY_REGISTRY)[number]['name']),
      ).toBe(surfaces.includes('in_editor'));
    }
  });

  it('keeps the three native names and descriptions aligned with the generated tool manifest', () => {
    const searchNames = [
      'search_capiro_data',
      'search_research_sources',
      'search_client_knowledge',
    ];
    for (const name of searchNames) {
      const capability = MERI_CAPABILITY_REGISTRY.find((tool) => tool.name === name)!;
      expect(MERI_TOOL_MANIFEST[name]).toBe(capability.description);
    }
    expect(
      searchNames.map((name) => MERI_CAPABILITY_REGISTRY.find((tool) => tool.name === name)?.name),
    ).toEqual(searchNames);
  });

  it('keeps federal award search contracts distinct until identity and PE semantics have parity', () => {
    const byName = Object.fromEntries(
      MERI_CAPABILITY_REGISTRY.map((tool) => [tool.name, tool as MeriCapabilityDefinition]),
    ) as Record<string, MeriCapabilityDefinition>;
    const peSearch = byName.search_federal_awards!;
    const identitySearch = byName.search_federal_contract_awards!;
    const peContract = peSearch.searchContract!;
    const identityContract = identitySearch.searchContract!;

    expect(peSearch).toMatchObject({
      backend: 'meri',
      readOnly: true,
      surfaces: ['full_chat', 'in_editor'],
    });
    expect(identitySearch).toMatchObject({
      backend: 'federal_market',
      readOnly: true,
      surfaces: ['full_chat'],
    });
    expect(peContract.contractRole).toBe('advisory_only');
    expect(identityContract.contractRole).toBe('advisory_only');
    expect(peContract.purpose).toMatch(/PE-code filters/i);
    expect(peContract.exclusions.join(' ')).toMatch(/Client-identity filtering/i);
    expect(peContract.exclusions.join(' ')).toMatch(/Action-date, state, or district filtering/i);
    expect(peContract.exclusions.join(' ')).toMatch(/amount as a cumulative obligated total/i);
    expect(identityContract.purpose).toMatch(/reviewed federal identities/i);
    expect(identityContract.supportedScopes.join(' ')).toMatch(
      /action-date range and place-of-performance/i,
    );
    expect(identityContract.exclusions.join(' ')).toMatch(/PE\) filtering/i);
    expect(identityContract.exclusions.join(' ')).toMatch(/amount as cumulative obligations/i);
    expect(identityContract.prerequisites.join(' ')).toMatch(
      /confirmed mappings with rollUpAwards enabled/i,
    );
    expect(identityContract.evidenceAuthority).toMatch(/USAspending/);
    expect(identityContract.evidenceAuthority).toMatch(/synchronization timestamps/i);
    expect(peContract.evidenceAuthority).toMatch(/does not expose a source URL/i);
    expect(MERI_TOOL_MANIFEST.search_federal_awards).toBe(peSearch.description);
    expect(MERI_TOOL_MANIFEST.search_federal_contract_awards).toBe(identitySearch.description);
    expect(peSearch.name).toBe('search_federal_awards');
    expect(identitySearch.name).toBe('search_federal_contract_awards');
  });

  it('keeps client documents, research attachments, and governed memory as distinct evidence readers', () => {
    const byName = Object.fromEntries(
      MERI_CAPABILITY_REGISTRY.map((tool) => [tool.name, tool as MeriCapabilityDefinition]),
    ) as Record<string, MeriCapabilityDefinition>;
    const readers = {
      read_client_documents: byName.read_client_documents!,
      get_research_evidence: byName.get_research_evidence!,
      search_memory: byName.search_memory!,
    };
    for (const reader of Object.values(readers)) {
      expect(reader).toMatchObject({ backend: 'meri', readOnly: true });
      expect(reader.searchContract).toMatchObject({
        contractRole: 'advisory_only', purpose: expect.any(String),
        exclusions: expect.arrayContaining([expect.any(String)]),
        supportedScopes: expect.arrayContaining([expect.any(String)]),
        prerequisites: expect.arrayContaining([expect.any(String)]),
        evidenceAuthority: expect.any(String),
        availabilityReasonCodes: expect.arrayContaining([expect.any(String)]),
      });
    }
    expect(readers.read_client_documents.searchContract?.supportedScopes).toContain(
      'one currently visible client and attachments authorized for the caller',
    );
    expect(readers.get_research_evidence.searchContract?.supportedScopes).toContain(
      'one research session owned by the authenticated tenant and user',
    );
    expect(readers.search_memory.searchContract?.supportedScopes).toContain(
      'authorized firm memory and the authenticated user’s private memory',
    );
    expect(readers.read_client_documents.searchContract?.evidenceAuthority).toMatch(
      /content hash, section kind\/label, character range/,
    );
    expect(readers.get_research_evidence.searchContract?.evidenceAuthority).toMatch(
      /capturedAt.*content hash.*does not return a page\/section locator/,
    );
    expect(readers.search_memory.searchContract?.evidenceAuthority).toMatch(
      /governance and freshness metadata.*source ID\/reference\/excerpt\/version/,
    );
    expect(readers.read_client_documents.searchContract?.exclusions).toContain(
      'Research-session attachments that are not also available as client Documents-tab files.',
    );
    expect(readers.search_memory.searchContract?.exclusions).toContain(
      'Underlying client documents, source records, meetings, or mail; use their source readers.',
    );
    expect(readers.search_memory.searchContract?.exclusions).toContain(
      'The prior content of a corrected or superseded item; active recall does not expose its correction history.',
    );
    expect(new Set(Object.values(readers).map((reader) => reader.name)).size).toBe(3);
  });

  it('keeps reader contracts descriptive while callable schemas and surfaces remain registered', () => {
    const { service } = registry();
    const names = ['read_client_documents', 'get_research_evidence', 'search_memory'];
    for (const name of names) {
      const metadata = MERI_CAPABILITY_REGISTRY.find((tool) => tool.name === name)!;
      expect(MERI_TOOL_MANIFEST[name]).toBe(metadata.description);
      expect(typeof service.registry.get(name)?.handler).toBe('function');
      expect(selectMeriCapabilitySchemas(
        MERI_CAPABILITY_REGISTRY, 'full_chat', service.registry.list(),
      ).map((tool) => tool.name)).toContain(name);
      expect(metadata.surfaces).toContain('full_chat');
    }
    const surfaces = Object.fromEntries(
      MERI_CAPABILITY_REGISTRY.filter((tool) => names.includes(tool.name))
        .map((tool) => [tool.name, (tool as MeriCapabilityDefinition).surfaces]),
    );
    expect(surfaces.read_client_documents).toContain('in_editor');
    expect(surfaces.get_research_evidence).not.toContain('in_editor');
    expect(surfaces.search_memory).not.toContain('in_editor');
  });

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
