import { buildChatSystemPrompt } from './chat-prompt';
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
});
