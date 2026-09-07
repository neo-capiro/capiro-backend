/** Labels shared by the library and file review. Keys remain the storage contract. */
export const CONTEXT_CATEGORIES = [
  {
    key: 'context_manifest',
    label: 'Context overview',
    question: 'What context do we have, and what is missing?',
    description: 'An index of documents, their owners and dates, missing information, and unresolved questions.',
  },
  {
    key: 'strategy_brief',
    label: 'Strategy brief',
    question: 'What are we trying to accomplish?',
    description: 'The client’s goal, desired outcome, success criteria, target date, current position, and assumptions.',
  },
  {
    key: 'client_constraints',
    label: 'Client constraints',
    question: 'What limits must we respect?',
    description: 'Budget, staffing, political sensitivities, do-not-contact instructions, blackout dates, and required approvals.',
  },
  {
    key: 'ask_and_options',
    label: 'Ask and options',
    question: 'What are we requesting, and what alternatives are acceptable?',
    description: 'The decision-maker, exact request, amount or program, preferred outcome, fallback options, and tradeoffs.',
  },
  {
    key: 'stakeholder_map',
    label: 'Stakeholders and relationships',
    question: 'Who determines or influences the outcome?',
    description: 'Members, committees, agencies, partners and opponents; their influence, positions, relationships, and next steps.',
  },
  {
    key: 'calendar_and_deadlines',
    label: 'Calendar and deadlines',
    question: 'When must things happen?',
    description: 'Congressional, agency, budget-cycle, client and internal dates; sources, uncertainty, dependencies, and preparation time.',
  },
  {
    key: 'decision_rules',
    label: 'When to change course',
    question: 'What should happen if circumstances change?',
    description: 'Instructions for responding to a moved deadline, stakeholder opposition, or other changes that require a review.',
  },
  {
    key: 'current_plan',
    label: 'Current plan',
    question: 'What are we currently scheduled to do?',
    description: 'Strategy steps, dates, owners, status, dependencies, blockers, completion criteria, and linked work.',
  },
  {
    key: 'evidence_register',
    label: 'Evidence and sources',
    question: 'What supports or challenges our claims?',
    description: 'Claims and supporting sources, publication dates, confidence, conflicting evidence, and gaps.',
  },
  {
    key: 'meeting_intelligence',
    label: 'Meeting notes and intelligence',
    question: 'What did we learn or commit to in a meeting?',
    description: 'Attendees, commitments, deadlines, new signals or positions, supporting statements, and follow-up actions.',
  },
  {
    key: 'decision_log',
    label: 'Decisions made',
    question: 'What have we already decided, and why?',
    description: 'Decisions, decision-makers, rationale, evidence, rejected alternatives, and reasons to reconsider.',
  },
  {
    key: 'agent_mission',
    label: 'Meri’s assignment',
    question: 'What ongoing assignment are we giving Meri?',
    description: 'The objective, owner, desired check-in schedule, when to alert the team, boundaries, and stop conditions.',
  },
  {
    key: 'execution_playbook',
    label: 'How to prepare the work',
    question: 'How should a particular kind of work be prepared?',
    description: 'Required inputs, preparation steps, expected deliverable, Workspace or Outreach destination, and approval checkpoints.',
  },
  {
    key: 'agent_permissions',
    label: 'Approval and action limits',
    question: 'What actions require authorization?',
    description: 'Your firm’s written review and approval policy, risk categories, access boundaries, and when to seek renewed approval.',
  },
] as const;

export function contextCategoryLabel(templateKey: string): string {
  // Existing documents use numbered keys (e.g. 01_strategy_brief).
  const key = templateKey.replace(/^\d+_/, '');
  return CONTEXT_CATEGORIES.find((category) => category.key === key)?.label
    ?? key.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}
