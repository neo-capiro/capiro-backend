import { buildChatSystemPrompt } from './chat-prompt';
import { KeywordIntentRouter } from '@capiro/meriv2-core';
import type { MeriContext } from '@capiro/meriv2-core';

const ctx: MeriContext = {
  tenantId: 't1',
  userId: 'u1',
  clerkUserId: 'cu1',
  role: 'member' as never,
};

describe('buildChatSystemPrompt', () => {
  it('injects pre-warmed memories so personal facts answer without a tool round (canary regression)', () => {
    const prompt = buildChatSystemPrompt(
      {
        memoryContext: [
          'user nickname: the user goes by Ninja',
          'firm focus: defense appropriations',
        ],
      },
      ctx,
    );
    expect(prompt).toContain('# What you remember (firm + this user)');
    expect(prompt).toContain('- user nickname: the user goes by Ninja');
    expect(prompt).toContain('- firm focus: defense appropriations');
  });

  it('omits the memory section when nothing was recalled', () => {
    const prompt = buildChatSystemPrompt({}, ctx);
    expect(prompt).not.toContain('# What you remember');
  });

  it('always routes firm-data questions to the right tools (canary regression: meetings → query_debriefs, memory-first)', () => {
    const prompt = buildChatSystemPrompt({}, ctx);
    expect(prompt).toContain('call search_memory FIRST');
    expect(prompt).toContain('query_debriefs');
    expect(prompt).toContain('never use them for firm-internal questions');
  });

  it('tells the model document tools RUN (no approval hold) and to report the real result — never a phantom download', () => {
    const prompt = buildChatSystemPrompt({}, ctx);
    // Document tools are PASS-classified: they run immediately, they are NOT held.
    expect(prompt).toContain('run IMMEDIATELY (no approval hold)');
    expect(prompt).toContain('create_word');
    // The crux of the false-"ready for download" bug: report the actual result.
    expect(prompt).toContain('REPORT ITS ACTUAL RESULT');
    expect(prompt).toContain(
      'do NOT claim a downloadable file exists when the tool did not return one',
    );
  });
});

describe('plan-mode steering (agent-map wiring)', () => {
  it('injects a mode steer when a non-default mode classifies with signal', () => {
    const intent = new KeywordIntentRouter().classify('draft a memo about the NDAA');
    expect(intent.mode).toBe('writing');
    const prompt = buildChatSystemPrompt({}, ctx, intent);
    expect(prompt).toContain('# Mode: writing');
    expect(prompt).toContain('Produce the document itself');
  });

  it('stays byte-identical for research/zero-signal turns (the common case)', () => {
    const noSignal = new KeywordIntentRouter().classify('hello there');
    expect(noSignal.confidence).toBe(0);
    expect(buildChatSystemPrompt({}, ctx, noSignal)).toBe(buildChatSystemPrompt({}, ctx));
  });

  it('compliance questions get the accuracy-over-helpfulness steer', () => {
    const intent = new KeywordIntentRouter().classify('do I have an LDA disclosure obligation?');
    expect(intent.mode).toBe('compliance');
    const prompt = buildChatSystemPrompt({}, ctx, intent);
    expect(prompt).toContain('# Mode: compliance');
  });
});
