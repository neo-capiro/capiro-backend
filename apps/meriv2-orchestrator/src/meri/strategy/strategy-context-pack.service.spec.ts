import type { MeriContext } from '@capiro/meriv2-core';
import { StrategyContextPackService } from './strategy-context-pack.service.js';
import type { ApiToolExecutorRepo } from '../api-tool-executor.repo.js';

const CTX = { tenantId: 't', userId: 'u', clerkUserId: 'c', role: 'standard_user' } as MeriContext;

/** Build a pack service over a stubbed executor whose per-tool result is canned. */
function build(results: Record<string, unknown>) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const execute = jest.fn(async (_ctx: MeriContext, name: string, input: Record<string, unknown>) => {
    calls.push({ name, input });
    if (!(name in results)) throw new Error(`unexpected tool ${name}`);
    return results[name];
  });
  const svc = new StrategyContextPackService({ execute } as unknown as ApiToolExecutorRepo);
  return { svc, calls };
}

const RICH = {
  get_client_context: {
    tool: 'get_client_context',
    context: { client: { name: 'Aerovance' }, description: 'defense sensors' },
    profile: { capabilities: [{ x: 1 }], people: [{ x: 1 }, { x: 2 }], facilities: [], submissionHistory: [] },
  },
  search_client_knowledge: { results: [{ id: 'd1', title: 'FY27 ask', snippet: '...', score: 0.7 }] },
  search_tracked_bills: { results: [{ id: 'hr1' }] },
  query_intelligence: { results: [{ id: 'i1' }] },
  query_knowledge_graph: { summary: 'client ↔ HAC-D', nodes: [{ id: 'n1', type: 'client', label: 'Aerovance' }] },
  search_memory: { results: [{ memoryItemId: 'm1', score: 0.6 }] },
};

describe('StrategyContextPackService — full pack', () => {
  it('assembles the 8-tab + KG + prior-engagement sections and never calls query_debriefs', async () => {
    const { svc, calls } = build(RICH);
    const pack = await svc.compile({ ctx: CTX, clientId: 'client-1', query: 'win the plus-up', slim: false });

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
    expect(kb.input).toMatchObject({ clientId: 'client-1', kind: 'client_doc_chunk', query: 'win the plus-up' });
    // Prior engagement rides the WALL-RIDING search_memory (not query_debriefs).
    expect(calls.some((c) => c.name === 'search_memory')).toBe(true);
    expect(pack.text).toContain('## Prior engagement');
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
    expect(pack.provenance.omitted).toEqual(expect.arrayContaining(['Knowledge graph', 'Prior engagement']));
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
