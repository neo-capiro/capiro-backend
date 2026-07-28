import { WorkspaceAssistantService } from './workspace-assistant.service.js';
import { DOMAIN_PRIMER } from '../meri/meri-domain-fanout.helpers.js';

/**
 * Guards for in-editor Meri parity with the full agent:
 *  - buildSystemPrompt carries the shared domain primer + retrieve-before-draft.
 *  - verifyEdits runs the deterministic PE structural pass on proposed edits.
 * buildSystemPrompt + verifyEdits' structural half are pure w.r.t. the model
 * call, so we construct with stubs. The config stub returns CLIO_VERIFIER_ENABLED
 * = false so verifyEdits skips the network grounding pass (structural still runs).
 */
const configStub = {
  get: (k: string) => (k === 'CLIO_VERIFIER_ENABLED' ? false : undefined),
} as never;

function makeService(): WorkspaceAssistantService {
  // Args 4-7 (MeriFeatureFlagsService, MeriV2OrchestratorClient,
  // ContextCompilerService, PrismaService) are the dormant-proxy + context deps;
  // unused by buildSystemPrompt/verifyEdits, so null.
  return new WorkspaceAssistantService(
    null as never,
    null as never,
    configStub,
    null as never,
    null as never,
    null as never,
    null as never,
  );
}

function buildPrompt(dto: unknown, packet?: unknown): string {
  const svc = makeService() as unknown as {
    buildSystemPrompt: (d: unknown, p?: unknown) => string;
  };
  return svc.buildSystemPrompt(dto, packet);
}

describe('WorkspaceAssistantService.buildSystemPrompt — grounding hardening', () => {
  const dto = {
    messages: [{ role: 'user', text: 'draft the situation section' }],
    document: {
      title: 'Strategy Memo',
      product: 'Strategy Memo',
      client: 'Perseus Defense',
      sections: [{ name: 'Situation', content: '<p>...</p>' }],
    },
    setup: { tone: 'formal' },
    context: [{ label: 'PE', text: 'PE 0207179F Autonomous Collaborative Platforms' }],
    clientId: 'abc',
  };

  it('injects the shared domain primer', () => {
    const prompt = buildPrompt(dto);
    expect(prompt).toContain('RDT&E (Budget Activity 4)');
    expect(prompt).toContain(DOMAIN_PRIMER.split('\n')[0]);
  });

  it('instructs retrieve-before-draft and to challenge seed context', () => {
    const prompt = buildPrompt(dto);
    expect(prompt).toContain('RETRIEVE BEFORE YOU DRAFT');
    expect(prompt.toLowerCase()).toContain('do not assume a pe');
  });

  it('still includes the no-fabrication grounding rule', () => {
    const prompt = buildPrompt(dto);
    expect(prompt.toLowerCase()).toContain('never fabricate');
  });
});

describe('WorkspaceAssistantService.verifyEdits — structural pass parity', () => {
  // Call the private method directly with the verifier flag off (structural only).
  function verify(svc: WorkspaceAssistantService, edits: unknown, pes: Map<string, unknown>) {
    return (
      svc as unknown as {
        verifyEdits: (
          c: { apiKey: string; model: string; usedTenantKey: boolean },
          e: unknown,
          g: string[],
          p: Map<string, unknown>,
        ) => Promise<{ confidence?: unknown; structuralWarnings?: Array<{ code: string }> }>;
      }
    ).verifyEdits(
      { apiKey: 'sk-test', model: 'claude-sonnet-test', usedTenantKey: true },
      edits,
      [],
      pes,
    );
  }

  it('flags an RDT&E PE used with procurement language (no detail tool needed)', async () => {
    const svc = makeService();
    const pes = new Map<string, unknown>([
      [
        '0207179F',
        { peCode: '0207179F', title: 'Autonomous Collaborative Platforms', appropriationType: 'RDT&E', budgetActivity: '04' },
      ],
    ]);
    const edits = [
      { op: 'replace_section', section: 'Recommendation', content: '<p>Pursue directed procurement of the missile under PE 0207179F.</p>' },
    ];
    const out = await verify(svc, edits, pes);
    expect(out.structuralWarnings?.some((w) => w.code === 'rdte_procurement_mismatch')).toBe(true);
  });

  it('returns no structural warnings for a clean, correctly-framed edit', async () => {
    const svc = makeService();
    const pes = new Map<string, unknown>([
      ['0207179F', { peCode: '0207179F', title: 'Autonomous Collaborative Platforms', appropriationType: 'RDT&E', budgetActivity: '04' }],
    ]);
    const edits = [
      { op: 'replace_section', section: 'Recommendation', content: '<p>Use PE 0207179F for evaluation and demonstration authority.</p>' },
    ];
    const out = await verify(svc, edits, pes);
    expect(out.structuralWarnings).toBeUndefined();
  });

  it('skips entirely when there is no edit content', async () => {
    const svc = makeService();
    const out = await verify(svc, [], new Map());
    expect(out.structuralWarnings).toBeUndefined();
    expect(out.confidence).toBeUndefined();
  });
});
