import { WorkspaceAssistantService } from './workspace-assistant.service.js';
import { DOMAIN_PRIMER } from '../meri/meri-domain-fanout.helpers.js';

/**
 * Fix #4/#7 guard: the in-editor Meri system prompt must carry the domain
 * primer and the retrieve-before-draft / challenge-seed-context instruction, so
 * the WRITER shares the same structural rigor as the fact-CHECKER. buildSystemPrompt
 * is pure w.r.t. the injected services, so we can construct with stubs.
 */
function makeService(): WorkspaceAssistantService {
  return new WorkspaceAssistantService(null as never, null as never);
}

function buildPrompt(dto: unknown): string {
  const svc = makeService() as unknown as { buildSystemPrompt: (d: unknown) => string };
  return svc.buildSystemPrompt(dto);
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
    // A distinctive line from the primer must be present verbatim.
    expect(prompt).toContain('RDT&E (Budget Activity 4)');
    expect(prompt).toContain(DOMAIN_PRIMER.split('\n')[0]); // header line
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
