import type { ConfigService } from '@nestjs/config';
import { InEditorAssistantService } from './in-editor-assistant.service';
import { MeriRegistryService } from '../meri-registry.service';
import type { ApiClientContextRepo } from '../api-client-context.repo';
import type { ApiToolExecutorRepo } from '../api-tool-executor.repo';
import { RequestCredentialsStore } from '../../request/request-credentials.store';
import type { MeriContext } from '@capiro/meriv2-core';

/**
 * The in-editor loop, driven end-to-end with mocked I/O:
 * - global.fetch handles the Anthropic tool-use rounds AND the tool-schema GET.
 * - tool EXECUTION goes through the REAL registry, whose delegated tools call a
 *   fake ToolExecutor (so we assert the loop routes tools through the registry).
 */

const ctx: MeriContext = {
  tenantId: 't1',
  userId: 'u1',
  clerkUserId: 'cu1',
  role: 'member' as never,
};

const config = {
  get: (k: string) =>
    k === 'MERIV2_API_BASE_URL'
      ? 'http://api.test'
      : k === 'ANTHROPIC_API_KEY'
        ? 'sk-global'
        : undefined,
} as unknown as ConfigService;

const clientRepo = {
  loadClientContext: async () => ({ client: { id: 'c', name: 'n' } }),
} as unknown as ApiClientContextRepo;

const fakePrisma = {
  withTenant: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
  withSystem: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
} as never;

function makeService(executor: ApiToolExecutorRepo) {
  const registryService = new MeriRegistryService(clientRepo, executor, config);
  return new InEditorAssistantService(registryService, config, fakePrisma);
}

const anthropic = (content: unknown[], stop_reason: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ content, stop_reason }),
});

const originalFetch = global.fetch;
afterEach(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('InEditorAssistantService.run', () => {
  it('runs a tool round through the registry, then returns the proposed reply + edits', async () => {
    const executeSpy = jest.fn(async (_ctx: unknown, _name: string, _input: unknown) => ({
      items: [{ id: 'hr1' }],
      count: 1,
    }));
    const executor = { execute: executeSpy } as unknown as ApiToolExecutorRepo;

    let anthropicCall = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schemas: [
              { name: 'search_congress_bills', description: 'x', input_schema: { type: 'object' } },
              { name: 'send_email', description: 'x', input_schema: { type: 'object' } },
            ],
          }),
        };
      }
      anthropicCall += 1;
      if (anthropicCall === 1) {
        return anthropic(
          [{ type: 'tool_use', id: 'tu1', name: 'search_congress_bills', input: { q: 'ndaa' } }],
          'tool_use',
        );
      }
      return anthropic(
        [
          {
            type: 'tool_use',
            id: 'tu2',
            name: 'propose_document_edits',
            input: {
              reply: 'Here is the update.',
              edits: [{ op: 'replace_section', section: 'Summary', content: '<p>Updated.</p>' }],
            },
          },
        ],
        'tool_use',
      );
    });

    const svc = makeService(executor);
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      svc.run(ctx, { messages: [{ role: 'user', text: 'update the summary' }] }),
    );

    expect(out.reply).toBe('Here is the update.');
    expect(out.edits).toEqual([
      { op: 'replace_section', section: 'Summary', content: '<p>Updated.</p>' },
    ]);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]).toBe('search_congress_bills');
    expect(out.steps?.some((s) => s.tool === 'search_congress_bills' && s.status === 'done')).toBe(
      true,
    );
  });

  it('returns a prompt when the last message is not from the user (no model call)', async () => {
    const executor = { execute: jest.fn() } as unknown as ApiToolExecutorRepo;
    const fetchSpy = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;
    const svc = makeService(executor);
    const out = await svc.run(ctx, { messages: [{ role: 'assistant', text: 'hi' }] });
    expect(out.reply).toMatch(/What would you like me to do/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns a plain answer when the model uses no tools', async () => {
    const executor = { execute: jest.fn() } as unknown as ApiToolExecutorRepo;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) {
        return { ok: true, status: 200, json: async () => ({ schemas: [] }) };
      }
      return anthropic([{ type: 'text', text: 'Advice: tighten the ask.' }], 'end_turn');
    });
    const svc = makeService(executor);
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      svc.run(ctx, { messages: [{ role: 'user', text: 'any advice?' }] }),
    );
    expect(out.reply).toBe('Advice: tighten the ask.');
    expect(out.edits).toEqual([]);
  });

  it('degrades to a friendly error if the model call throws', async () => {
    const executor = { execute: jest.fn() } as unknown as ApiToolExecutorRepo;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) {
        return { ok: true, status: 200, json: async () => ({ schemas: [] }) };
      }
      return { ok: false, status: 529, text: async () => 'overloaded' };
    });
    const svc = makeService(executor);
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      svc.run(ctx, { messages: [{ role: 'user', text: 'draft it' }] }),
    );
    expect(out.reply).toMatch(/error reaching the model/);
    expect(out.edits).toEqual([]);
  });

  it('flags a PE structural mismatch on the proposed edits (verifier LLM disabled)', async () => {
    const executor = {
      execute: jest.fn(async () => ({
        programElement: {
          peCode: '0207179F',
          title: 'Autonomous Collaborative Platforms',
          service: 'Air Force',
          appropriationType: 'RDT&E',
          budgetActivity: '04',
        },
      })),
    } as unknown as ApiToolExecutorRepo;

    let anthropicCall = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schemas: [
              { name: 'get_program_element', description: 'x', input_schema: { type: 'object' } },
            ],
          }),
        };
      }
      anthropicCall += 1;
      if (anthropicCall === 1) {
        return anthropic(
          [
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'get_program_element',
              input: { peCode: '0207179F' },
            },
          ],
          'tool_use',
        );
      }
      return anthropic(
        [
          {
            type: 'tool_use',
            id: 'tu2',
            name: 'propose_document_edits',
            input: {
              reply: 'Updated the ask.',
              edits: [
                {
                  op: 'replace_section',
                  section: 'Ask',
                  content:
                    '<p>Recommend directed procurement of PE 0207179F to buy units at scale.</p>',
                },
              ],
            },
          },
        ],
        'tool_use',
      );
    });

    const svc = makeService(executor);
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      svc.run(ctx, { messages: [{ role: 'user', text: 'tighten the ask' }] }),
    );

    expect(out.confidence).toBeUndefined();
    expect(out.structuralWarnings).toHaveLength(1);
    expect(out.structuralWarnings?.[0]?.code).toBe('rdte_procurement_mismatch');
    expect(out.structuralWarnings?.[0]?.peCode).toBe('0207179F');
  });

  it('computes confidence from the grounding verifier when CLIO_VERIFIER_ENABLED', async () => {
    const verifierConfig = {
      get: (k: string) =>
        k === 'MERIV2_API_BASE_URL'
          ? 'http://api.test'
          : k === 'ANTHROPIC_API_KEY'
            ? 'sk-global'
            : k === 'CLIO_VERIFIER_ENABLED'
              ? 'true'
              : undefined,
    } as unknown as ConfigService;
    const executor = { execute: jest.fn() } as unknown as ApiToolExecutorRepo;

    let anthropicCall = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) {
        return { ok: true, status: 200, json: async () => ({ schemas: [] }) };
      }
      anthropicCall += 1;
      if (anthropicCall === 1) {
        return anthropic(
          [
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'propose_document_edits',
              input: {
                reply: 'Done.',
                edits: [
                  {
                    op: 'replace_section',
                    section: 'Summary',
                    content: '<p>Fully backed claim.</p>',
                  },
                ],
              },
            },
          ],
          'tool_use',
        );
      }
      return anthropic(
        [
          {
            type: 'text',
            text: JSON.stringify({ claims: [{ claim: 'x', supported: true, sourceIds: [1] }] }),
          },
        ],
        'end_turn',
      );
    });

    const registryService = new MeriRegistryService(clientRepo, executor, verifierConfig);
    const svc = new InEditorAssistantService(registryService, verifierConfig, fakePrisma);
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      svc.run(ctx, { messages: [{ role: 'user', text: 'draft it' }] }),
    );

    expect(out.confidence?.level).toBe('high');
  });

  it('fails open (no confidence, edits still returned) if the verifier LLM call throws', async () => {
    const verifierConfig = {
      get: (k: string) =>
        k === 'MERIV2_API_BASE_URL'
          ? 'http://api.test'
          : k === 'ANTHROPIC_API_KEY'
            ? 'sk-global'
            : k === 'CLIO_VERIFIER_ENABLED'
              ? 'true'
              : undefined,
    } as unknown as ConfigService;
    const executor = { execute: jest.fn() } as unknown as ApiToolExecutorRepo;

    let anthropicCall = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) {
        return { ok: true, status: 200, json: async () => ({ schemas: [] }) };
      }
      anthropicCall += 1;
      if (anthropicCall === 1) {
        return anthropic(
          [
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'propose_document_edits',
              input: {
                reply: 'Done.',
                edits: [
                  { op: 'replace_section', section: 'Summary', content: '<p>Some claim.</p>' },
                ],
              },
            },
          ],
          'tool_use',
        );
      }
      return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
    });

    const registryService = new MeriRegistryService(clientRepo, executor, verifierConfig);
    const svc = new InEditorAssistantService(registryService, verifierConfig, fakePrisma);
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      svc.run(ctx, { messages: [{ role: 'user', text: 'draft it' }] }),
    );

    expect(out.reply).toBe('Done.');
    expect(out.edits).toHaveLength(1);
    expect(out.confidence).toBeUndefined();
  });
});

describe('InEditorAssistantService Phase 16 release gate', () => {
  const HIGH_RISK_REQUEST =
    'confirm the FY27 budget amount for PE 0604270F and whether the NDAA passed the House';
  const UNSUPPORTED_EDIT =
    '<p>PE 0604270F received $412.5 million in FY27 and the NDAA passed the House on July 1.</p>';

  function driveProposeEdits(): jest.Mock {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schemas: [
              { name: 'search_congress_bills', description: 'x', input_schema: { type: 'object' } },
            ],
          }),
        };
      }
      return anthropic(
        [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'propose_document_edits',
            input: {
              reply: 'Applied the figures.',
              edits: [{ op: 'replace_section', section: 'Summary', content: UNSUPPORTED_EDIT }],
            },
          },
        ],
        'tool_use',
      );
    });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    return fetchMock as unknown as jest.Mock;
  }

  const originalSurfaces = process.env.MERI_RELEASE_GATE_SURFACES;
  const originalGate = process.env.MERI_RELEASE_GATE;
  const originalTenants = process.env.MERI_RELEASE_GATE_TENANTS;
  afterEach(() => {
    if (originalSurfaces === undefined) delete process.env.MERI_RELEASE_GATE_SURFACES;
    else process.env.MERI_RELEASE_GATE_SURFACES = originalSurfaces;
    if (originalGate === undefined) delete process.env.MERI_RELEASE_GATE;
    else process.env.MERI_RELEASE_GATE = originalGate;
    if (originalTenants === undefined) delete process.env.MERI_RELEASE_GATE_TENANTS;
    else process.env.MERI_RELEASE_GATE_TENANTS = originalTenants;
  });

  it('is dark by default — unverified high-risk edits are returned unchanged', async () => {
    delete process.env.MERI_RELEASE_GATE_SURFACES;
    delete process.env.MERI_RELEASE_GATE;
    delete process.env.MERI_RELEASE_GATE_TENANTS;
    driveProposeEdits();
    const svc = makeService({ execute: jest.fn() } as unknown as ApiToolExecutorRepo);
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      svc.run(ctx, { messages: [{ role: 'user', text: HIGH_RISK_REQUEST }] }),
    );
    expect(out.reply).toBe('Applied the figures.');
    expect(out.edits).toEqual([
      { op: 'replace_section', section: 'Summary', content: UNSUPPORTED_EDIT },
    ]);
  });

  it('requires all three controls and does not infer a tenant canary', async () => {
    process.env.MERI_RELEASE_GATE = 'enforce';
    process.env.MERI_RELEASE_GATE_SURFACES = 'in-editor';
    delete process.env.MERI_RELEASE_GATE_TENANTS;
    driveProposeEdits();
    const svc = makeService({ execute: jest.fn() } as unknown as ApiToolExecutorRepo);
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      svc.run(ctx, { messages: [{ role: 'user', text: HIGH_RISK_REQUEST }] }),
    );
    expect(out.edits).toHaveLength(1);
  });

  it('shadow computes verification but returns the original edits unchanged', async () => {
    process.env.MERI_RELEASE_GATE = 'shadow';
    process.env.MERI_RELEASE_GATE_TENANTS = 't1';
    process.env.MERI_RELEASE_GATE_SURFACES = 'in-editor';
    driveProposeEdits();
    const svc = makeService({ execute: jest.fn() } as unknown as ApiToolExecutorRepo);
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      svc.run(ctx, { messages: [{ role: 'user', text: HIGH_RISK_REQUEST }] }),
    );
    expect(out.reply).toBe('Applied the figures.');
    expect(out.edits).toEqual([
      { op: 'replace_section', section: 'Summary', content: UNSUPPORTED_EDIT },
    ]);
  });

  it('withholds the edits only for the explicitly canaried tenant in enforce', async () => {
    process.env.MERI_RELEASE_GATE = 'enforce';
    process.env.MERI_RELEASE_GATE_TENANTS = 't1';
    process.env.MERI_RELEASE_GATE_SURFACES = 'in-editor';
    driveProposeEdits();
    const svc = makeService({ execute: jest.fn() } as unknown as ApiToolExecutorRepo);
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      svc.run(ctx, { messages: [{ role: 'user', text: HIGH_RISK_REQUEST }] }),
    );
    expect(out.edits).toEqual([]);
    expect(out.reply).toMatch(/did not propose these edits/i);
    expect(out.reply).toMatch(/Nothing was changed in your document/i);
  });

  it('leaves a non-canaried tenant unchanged', async () => {
    process.env.MERI_RELEASE_GATE = 'enforce';
    process.env.MERI_RELEASE_GATE_TENANTS = 'other-tenant';
    process.env.MERI_RELEASE_GATE_SURFACES = 'in-editor';
    driveProposeEdits();
    const svc = makeService({ execute: jest.fn() } as unknown as ApiToolExecutorRepo);
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      svc.run(ctx, { messages: [{ role: 'user', text: HIGH_RISK_REQUEST }] }),
    );
    expect(out.edits).toHaveLength(1);
  });

  it('never withholds an advice-only turn, even when enforced', async () => {
    process.env.MERI_RELEASE_GATE = 'enforce';
    process.env.MERI_RELEASE_GATE_TENANTS = 't1';
    process.env.MERI_RELEASE_GATE_SURFACES = 'all';
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/clio/tool-schemas')) {
        return { ok: true, status: 200, json: async () => ({ schemas: [] }) };
      }
      return anthropic(
        [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'propose_document_edits',
            input: { reply: 'I could not confirm the FY27 amount.', edits: [] },
          },
        ],
        'tool_use',
      );
    });
    const svc = makeService({ execute: jest.fn() } as unknown as ApiToolExecutorRepo);
    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      svc.run(ctx, { messages: [{ role: 'user', text: HIGH_RISK_REQUEST }] }),
    );
    expect(out.reply).toBe('I could not confirm the FY27 amount.');
    expect(out.edits).toEqual([]);
  });
});
