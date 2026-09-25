import { classifyActionIntent } from './action-intent';

describe('classifyActionIntent', () => {
  it('recognizes every registered write tool as a known action class', () => {
    const writeTools = [
      'prepare_legiwatch_briefing', 'save_legislative_research', 'save_legiwatch_relevance',
      'apply_legiwatch_suggestion', 'create_meeting_brief', 'draft_policy_memo', 'save_note',
      'save_chat_attachments', 'send_email', 'reply_email', 'save_memory', 'confirm_memory',
      'correct_memory', 'forget_memory', 'create_word', 'create_excel', 'create_powerpoint',
      'schedule_task', 'cancel_scheduled_task', 'create_client', 'create_task', 'update_task',
      'update_client_profile',
      'save_business_development_brief',
    ];
    expect(writeTools).toHaveLength(24);
    for (const tool of writeTools) {
      expect(classifyActionIntent('', tool).reason).toBe('missing_explicit_action_intent');
    }
  });

  it.each([
    ['I2', 'Analyze these options and tell me the implications.', 'create_word'],
    ['J1', 'Review the client situation and recommend next steps.', 'create_task'],
    ['L1', 'What should I say in an email to the client?', 'send_email'],
    ['Q1', 'Draft an email and memo for me.', 'draft_policy_memo'],
    ['S1', 'Summarize this meeting as a leave-behind.', 'create_meeting_brief'],
    ['T2', 'What do you remember about this client?', 'save_memory'],
    ['draft only', 'Draft an email to Alex.', 'send_email'],
    ['negative file intent', 'Draft the memo here without creating a Word file.', 'create_word'],
    ['file noun alone', 'I only need the Word file requirements summarized in chat.', 'create_word'],
    ['negative send intent', "Do not send the email; just improve the draft.", 'send_email'],
  ])('denies read-only or drafting request %s', (_id, prompt, tool) => {
    expect(classifyActionIntent(prompt, tool).authorized).toBe(false);
  });

  it.each([
    ['Create a Word document with the analysis.', 'create_word'],
    ['Update the client profile with the new address.', 'update_client_profile'],
    ['Send this email to Alex.', 'send_email'],
    ['Email them the approved response.', 'send_email'],
    ['Could you email Alex the approved response?', 'send_email'],
    ['Make me a Word doc with the analysis.', 'create_word'],
    ['Remember that Project Falcon means the radar modernization effort.', 'save_memory'],
    ['Save the updated prospect brief.', 'save_business_development_brief'],
  ])('allows explicit request: %s', (prompt, tool) => {
    expect(classifyActionIntent(prompt, tool)).toMatchObject({ authorized: true, reason: 'explicit_action_intent' });
  });

  it('denies an unknown write tool', () => {
    expect(classifyActionIntent('Create a record.', 'unknown_write')).toMatchObject({
      authorized: false,
      category: 'unknown_write_tool',
      reason: 'unknown_write_tool',
    });
  });
});
