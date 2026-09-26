export type ActionIntentCategory =
  | 'artifact_create'
  | 'email_send'
  | 'email_reply'
  | 'note_save'
  | 'memory_change'
  | 'task_change'
  | 'client_change'
  | 'research_save'
  | 'legiwatch_change'
  | 'brief_save'
  | 'unknown_write_tool';

export interface ActionIntentDecision {
  authorized: boolean;
  category: ActionIntentCategory;
  reason: 'explicit_action_intent' | 'missing_explicit_action_intent' | 'unknown_write_tool';
}

const ACTIONS: Record<
  string,
  { category: ActionIntentCategory; verbs: RegExp; nouns: RegExp; directives?: RegExp }
> = {
  prepare_legiwatch_briefing: { category: 'legiwatch_change', verbs: /\b(create|generate|save)\b/i, nouns: /\b(legiwatch|briefing)\b/i },
  save_legislative_research: { category: 'research_save', verbs: /\b(save|store)\b/i, nouns: /\b(legislative research|research)\b/i },
  save_legiwatch_relevance: { category: 'legiwatch_change', verbs: /\b(save|store)\b/i, nouns: /\b(legiwatch|relevance)\b/i },
  apply_legiwatch_suggestion: { category: 'legiwatch_change', verbs: /\b(apply|use)\b/i, nouns: /\b(legiwatch|suggestion)\b/i },
  create_meeting_brief: { category: 'artifact_create', verbs: /\b(create|generate|export|download|produce|build)\b/i, nouns: /\b(meeting brief|brief)\b/i },
  draft_policy_memo: { category: 'artifact_create', verbs: /\b(create|generate|export|download|produce|build)\b/i, nouns: /\b(policy memo|memo)\b/i },
  save_note: { category: 'note_save', verbs: /\b(save|record|add|log|store)\b/i, nouns: /\b(note|notes)\b/i },
  save_chat_attachments: { category: 'artifact_create', verbs: /\b(save|store|download|export)\b/i, nouns: /\b(attachment|attachments|file|files)\b/i },
  send_email: {
    category: 'email_send',
    verbs: /\bsend\b/i,
    nouns: /\b(email|message)\b/i,
    directives: /(?:^|\b(?:can|could|would|will)\s+you\s+)email\b/i,
  },
  reply_email: { category: 'email_reply', verbs: /\b(reply|respond|send)\b/i, nouns: /\b(email|message|thread)\b/i },
  save_memory: {
    category: 'memory_change',
    verbs: /\b(save|store)\b/i,
    nouns: /\b(memory|fact|preference|positioning|alias)\b/i,
    directives: /\bremember(?=\s+(?:that|this|these|the following|for future))\b/i,
  },
  confirm_memory: { category: 'memory_change', verbs: /\b(confirm|remember|save)\b/i, nouns: /\b(memory|fact|preference)\b/i },
  correct_memory: { category: 'memory_change', verbs: /\b(correct|update|change)\b/i, nouns: /\b(memory|fact|preference)\b/i },
  forget_memory: { category: 'memory_change', verbs: /\b(forget|delete|remove)\b/i, nouns: /\b(memory|fact|preference)\b/i },
  create_word: { category: 'artifact_create', verbs: /\b(create|generate|export|download|produce|build|make|revise|repair|update)\b/i, nouns: /\b(word|document|docx|file)\b/i },
  create_excel: { category: 'artifact_create', verbs: /\b(create|generate|export|download|produce|build|make|revise|repair|update)\b/i, nouns: /\b(excel|spreadsheet|workbook|xlsx|file)\b/i },
  create_powerpoint: { category: 'artifact_create', verbs: /\b(create|generate|export|download|produce|build|make|revise|repair|update)\b/i, nouns: /\b(powerpoint|presentation|slides|pptx|file)\b/i },
  schedule_task: { category: 'task_change', verbs: /\b(schedule|create|add)\b/i, nouns: /\b(task|reminder|follow-up)\b/i },
  cancel_scheduled_task: { category: 'task_change', verbs: /\b(cancel|delete|remove)\b/i, nouns: /\b(task|reminder|schedule)\b/i },
  create_client: { category: 'client_change', verbs: /\b(create|add)\b/i, nouns: /\b(client|customer)\b/i },
  create_task: { category: 'task_change', verbs: /\b(create|add)\b/i, nouns: /\b(task|todo|follow-up)\b/i },
  update_task: { category: 'task_change', verbs: /\b(update|change|edit|complete)\b/i, nouns: /\b(task|todo|follow-up)\b/i },
  update_client_profile: { category: 'client_change', verbs: /\b(update|change|edit)\b/i, nouns: /\b(client|profile|client profile)\b/i },
  save_business_development_brief: { category: 'brief_save', verbs: /\b(save|store|update)\b/i, nouns: /\b(brief)\b/i },
  create_research_portfolio_snapshot: {
    category: 'research_save',
    verbs: /\b(create|capture|save)\b/i,
    nouns: /\b(research\s+portfolio\s+snapshot|portfolio\s+snapshot|snapshot)\b/i,
  },
  request_research_portfolio_output: {
    category: 'artifact_create',
    verbs: /\b(create|generate|export|request|produce)\b/i,
    nouns: /\b(research\s+portfolio\s+(?:output|export)|portfolio\s+(?:output|export)|csv|export)\b/i,
  },
  save_research_portfolio_output_to_client: {
    category: 'client_change',
    verbs: /\b(save|file|attach|store)\b/i,
    nouns: /\b(client\s+files?|client|portfolio\s+(?:output|export)|output|export)\b/i,
  },
  watch_research_portfolio: {
    category: 'research_save',
    verbs: /\b(watch|monitor|subscribe|notify)\b/i,
    nouns: /\b(research\s+portfolio|portfolio|changes?|updates?)\b/i,
  },
  update_research_portfolio_change_state: {
    category: 'research_save',
    verbs: /\b(mark|acknowledge|dismiss|undo)\b/i,
    nouns: /\b(portfolio\s+(?:change|event)|change|event)\b/i,
  },
};

/** Deterministic authorization for a specific write tool from the current user request. */
export function classifyActionIntent(userRequest: string, toolName: string): ActionIntentDecision {
  const action = ACTIONS[toolName];
  if (!action) return { authorized: false, category: 'unknown_write_tool', reason: 'unknown_write_tool' };
  const text = typeof userRequest === 'string' ? userRequest : '';
  const authorized =
    (action.nouns.test(text) && hasUnnegatedVerb(text, action.verbs)) ||
    (action.directives ? hasUnnegatedVerb(text, action.directives) : false);
  return {
    authorized,
    category: action.category,
    reason: authorized ? 'explicit_action_intent' : 'missing_explicit_action_intent',
  };
}

function hasUnnegatedVerb(text: string, verbs: RegExp): boolean {
  const flags = verbs.flags.includes('g') ? verbs.flags : `${verbs.flags}g`;
  const matcher = new RegExp(verbs.source, flags);
  for (const match of text.matchAll(matcher)) {
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 48), index);
    if (!/\b(?:don't|do\s+not|never|without|not)\b[^.!?]{0,36}$/i.test(before)) return true;
  }
  return false;
}
