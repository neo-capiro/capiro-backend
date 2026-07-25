import type { MeriContext } from '@capiro/meriv2-core';
import { StrategyContextPackService } from './strategy-context-pack.service.js';
import type { ApiToolExecutorRepo } from '../api-tool-executor.repo.js';

const CTX = { tenantId: 't', userId: 'u', clerkUserId: 'c', role: 'standard_user' } as MeriContext;

/** Build a pack service over a stubbed executor whose per-tool result is canned. */
function build(results: Record<string, unknown>) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const execute = jest.fn(
    async (_ctx: MeriContext, name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      if (!(name in results)) throw new Error(`unexpected tool ${name}`);
      return results[name];
    },
  );
  const svc = new StrategyContextPackService({ execute } as unknown as ApiToolExecutorRepo);
  return { svc, calls };
}

// Canned tool results using the REAL tool response shapes (matching
// apps/api meri-tools.service.ts): tracked bills under `bills`, intelligence as
// a `data` string, memory rows carrying `clientId`.
const RICH = {
  get_client_context: {
    tool: 'get_client_context',
    context: { client: { name: 'Aerovance' }, description: 'defense sensors' },
    profile: {
      capabilities: [{ x: 1 }],
      people: [{ x: 1 }, { x: 2 }],
      facilities: [],
      submissionHistory: [],
    },
  },
  search_client_knowledge: {
    results: [{ id: 'd1', title: 'FY27 ask', snippet: '...', score: 0.7 }],
  },
  search_tracked_bills: {
    tool: 'search_tracked_bills',
    clientId: 'client-1',
    total: 1,
    bills: [{ id: 'hr1' }],
  },
  query_intelligence: {
    tool: 'query_intelligence',
    data: 'Surging LDA issues: shipbuilding, munitions',
  },
  query_knowledge_graph: {
    summary: 'client ↔ HAC-D',
    nodes: [{ id: 'n1', type: 'client', label: 'Aerovance' }],
  },
  search_memory: {
    summary: '1 memory item',
    results: [{ memoryItemId: 'm1', clientId: 'client-1', title: 'debrief', relevance: 0.6 }],
  },
};

describe('StrategyContextPackService — full pack', () => {
  it('assembles the 8-tab + KG + prior-engagement sections and never calls query_debriefs', async () => {
    const { svc, calls } = build(RICH);
    const pack = await svc.compile({
      ctx: CTX,
      clientId: 'client-1',
      query: 'win the plus-up',
      slim: false,
    });

    const names = pack.provenance.sections.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Client profile',
        'Relevant documents',
        'Tracked bills',
        'Intelligence',
        'Knowledge graph',
        'Prior engagement',
      ]),
    );
    // Wall-safety: the un-walled query_debriefs is NEVER used.
    expect(calls.some((c) => c.name === 'query_debriefs')).toBe(false);
    // Documents are relevance-retrieved top-K over client_doc_chunk with the goal.
    const kb = calls.find((c) => c.name === 'search_client_knowledge')!;
    expect(kb.input).toMatchObject({
      clientId: 'client-1',
      kind: 'client_doc_chunk',
      query: 'win the plus-up',
    });
    // CTX-2: the knowledge graph is client-anchored (seeded on the client node),
    // never a firm-wide (seedless) walk.
    const kg = calls.find((c) => c.name === 'query_knowledge_graph')!;
    expect(kg.input).toMatchObject({ seed: 'client:client-1' });
    // Prior engagement rides the WALL-RIDING search_memory (not query_debriefs).
    expect(calls.some((c) => c.name === 'search_memory')).toBe(true);
    expect(pack.text).toContain('## Prior engagement');
    // Tracked bills + Intelligence sections render from their real shapes.
    expect(pack.text).toContain('## Tracked bills');
    expect(pack.text).toContain('## Intelligence');
    expect(pack.text).toContain('shipbuilding');
  });
});

describe('StrategyContextPackService — cross-client scoping (CTX-4)', () => {
  it('drops prior-engagement memory rows that belong to a DIFFERENT client', async () => {
    const bleed = {
      ...RICH,
      search_memory: {
        summary: '2 items',
        results: [
          {
            memoryItemId: 'm-other',
            clientId: 'client-2',
            title: 'other client debrief',
            relevance: 0.9,
          },
          { memoryItemId: 'm-gen', clientId: null, title: 'tenant-general note', relevance: 0.5 },
        ],
      },
    };
    const { svc } = build(bleed);
    const pack = await svc.compile({ ctx: CTX, clientId: 'client-1', query: 'goal', slim: false });

    // The other client's memory must not appear; the tenant-general (null) row is kept.
    expect(pack.text).not.toContain('other client debrief');
    expect(pack.text).toContain('tenant-general note');
    const eng = pack.provenance.sections.find((s) => s.name === 'Prior engagement');
    expect(eng?.count).toBe(1);
  });

  it('omits prior engagement entirely when every memory row is another client', async () => {
    const allOther = {
      ...RICH,
      search_memory: {
        summary: '1 item',
        results: [{ memoryItemId: 'm-other', clientId: 'client-2', title: 'x', relevance: 0.9 }],
      },
    };
    const { svc } = build(allOther);
    const pack = await svc.compile({ ctx: CTX, clientId: 'client-1', query: 'goal', slim: false });
    expect(pack.provenance.sections.map((s) => s.name)).not.toContain('Prior engagement');
    expect(pack.provenance.omitted).toEqual(expect.arrayContaining(['Prior engagement']));
  });
});

describe('StrategyContextPackService — walled client', () => {
  it('omits memory/KG sections when the wall-riding tools return empty (no leak), keeps tenant-scoped profile', async () => {
    // A walled client: search_memory + query_knowledge_graph fail-closed → empty.
    const walled = {
      ...RICH,
      query_knowledge_graph: { summary: '', nodes: [] },
      search_memory: { results: [] },
    };
    const { svc } = build(walled);
    const pack = await svc.compile({ ctx: CTX, clientId: 'client-1', query: 'goal', slim: false });

    const names = pack.provenance.sections.map((s) => s.name);
    expect(names).toContain('Client profile'); // client-own, tenant-scoped
    expect(names).not.toContain('Knowledge graph'); // walled → empty → omitted
    expect(names).not.toContain('Prior engagement'); // walled → empty → omitted
    expect(pack.provenance.omitted).toEqual(
      expect.arrayContaining(['Knowledge graph', 'Prior engagement']),
    );
    expect(pack.text).not.toContain('## Prior engagement');
  });
});

describe('StrategyContextPackService — slim (rail assistant)', () => {
  it('fetches only profile + documents + KG, not tracker/intel/engagement', async () => {
    const { svc, calls } = build(RICH);
    await svc.compile({ ctx: CTX, clientId: 'client-1', query: 'push a step', slim: true });
    const fetched = new Set(calls.map((c) => c.name));
    expect(fetched.has('get_client_context')).toBe(true);
    expect(fetched.has('search_client_knowledge')).toBe(true);
    expect(fetched.has('query_knowledge_graph')).toBe(true);
    expect(fetched.has('search_tracked_bills')).toBe(false);
    expect(fetched.has('query_intelligence')).toBe(false);
    expect(fetched.has('search_memory')).toBe(false);
  });
});

describe('StrategyContextPackService — A8 pack health', () => {
  it('is "ok" when every section resolves — only the documented Targets gap is optional-omitted', async () => {
    const { svc } = build(RICH);
    const pack = await svc.compile({ ctx: CTX, clientId: 'client-1', query: 'goal', slim: false });

    expect(pack.health.status).toBe('ok');
    expect(pack.health.missingRequired).toEqual([]);
    expect(pack.health.omittedOptional).toEqual(['Targets (no read tool)']);
  });

  it('stays "ok" for a walled client — KG/prior-engagement land in omittedOptional, never missingRequired', async () => {
    const walled = {
      ...RICH,
      query_knowledge_graph: { summary: '', nodes: [] },
      search_memory: { results: [] },
    };
    const { svc } = build(walled);
    const pack = await svc.compile({ ctx: CTX, clientId: 'client-1', query: 'goal', slim: false });

    expect(pack.health.status).toBe('ok');
    expect(pack.health.missingRequired).toEqual([]);
    expect(pack.health.omittedOptional).toEqual(
      expect.arrayContaining(['Knowledge graph', 'Prior engagement', 'Targets (no read tool)']),
    );
    expect(pack.health.omittedOptional).not.toContain('Client profile');
  });

  it('degrades to "degraded" with "Client profile" in missingRequired (never omittedOptional) when the profile fetch fails', async () => {
    // Drop the get_client_context stub so the mock executor throws, exercising
    // the run() catch path — the only way `omitted` can contain 'Client profile'.
    const { get_client_context: _unused, ...noProfile } = RICH;
    const { svc } = build(noProfile);
    const pack = await svc.compile({ ctx: CTX, clientId: 'client-1', query: 'goal', slim: false });

    expect(pack.health.status).toBe('degraded');
    expect(pack.health.missingRequired).toEqual(['Client profile']);
    expect(pack.health.omittedOptional).not.toContain('Client profile');
  });
});
