import {
  buildAssistantSystemPrompt,
  buildDraftSystemPrompt,
  type StrategyAssistantInput,
  type StrategyDraftInput,
} from './strategy-prompt.js';

/*
 * Attachment grounding (CRT-5 / MRI-7): user-uploaded document text, resolved by
 * api-strategy and forwarded here, must land in the system prompt so Meri
 * actually grounds on it (the whole point of the "Start from a document" path).
 */
describe('strategy-prompt — attachment grounding (CRT-5/MRI-7)', () => {
  it('renders attached document text in the draft system prompt', () => {
    const input = {
      clientId: 'c1',
      type: 'appropriations',
      goal: 'Win the plus-up',
      attachments: [{ filename: 'memo.pdf', text: 'FY27 shipbuilding priorities' }],
    } as StrategyDraftInput;
    const sys = buildDraftSystemPrompt(input, '(pack)');
    expect(sys).toContain('# Attached documents');
    expect(sys).toContain('memo.pdf');
    expect(sys).toContain('FY27 shipbuilding priorities');
  });

  it('omits the attachments section when none are provided', () => {
    const input = { clientId: 'c1', type: 'appropriations', goal: 'g' } as StrategyDraftInput;
    expect(buildDraftSystemPrompt(input, '(pack)')).not.toContain('# Attached documents');
  });

  it('renders attached document text in the assistant system prompt', () => {
    const input = {
      scope: 'strategy',
      instruction: 'incorporate the memo',
      clientId: 'c1',
      strategy: { id: 's1', title: 'Plan', type: 'appropriations', nodes: [] },
      attachments: [{ filename: 'brief.docx', text: 'coalition sign-on plan' }],
    } as StrategyAssistantInput;
    const sys = buildAssistantSystemPrompt(input, '(pack)');
    expect(sys).toContain('# Attached documents');
    expect(sys).toContain('brief.docx');
    expect(sys).toContain('coalition sign-on plan');
  });
});
