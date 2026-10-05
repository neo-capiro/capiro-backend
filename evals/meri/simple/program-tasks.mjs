// Real tasks from the program plan (docs/meri/implementation/00-Meri-Program-Plan-2026-10-05.md §8),
// run once each as neo@capiro.ai in capiro-internal through the ordinary product path.
// Neo's pass/fail verdict is the result; automatic checks are safety aids only.
// State-changing setup only on the QA client. Approvals that need a second person
// use the synthetic reviewer configured in MERI_RUNNER_SECOND_IDENTITY (D9).
const PRIMARY = 'L3 Harris';
const QA_CLIENT = 'ZZ-QA-Meri1651-Test-DoNotUse';

export const programTasks = [
  {
    id: 'T1', mode: 'LIVE', client: PRIMARY, op: 'read', citations: true,
    reference: "Open items and this week's changes for L3Harris, client-scoped, with sources attached.",
    turns: [{ prompt: "Brief me on L3Harris's open items and what changed this week." }],
  },
  {
    // 0605231A (Army Precision Strike Missile) has non-zero FY26 and FY27 requests
    // that agree with their recorded source values (read-only probe, 2026-10-05).
    id: 'T2', mode: 'LIVE', client: PRIMARY, op: 'read', citations: true,
    reference: "FY27 request and the FY26 comparison for PE 0605231A from Capiro's data, with citations.",
    turns: [{ prompt: 'What is the FY27 request for program element 0605231A and how does it compare to FY26?' }],
  },
  {
    id: 'T3', mode: 'LIVE', client: QA_CLIENT, op: 'memory_save',
    reference: 'The save is client-scoped and goes to review; after the second reviewer approves it, a new conversation recalls it.',
    turns: [
      { prompt: 'Remember for this client that budget briefs go to the program office first.' },
      { action: 'approve_own_candidate_as_reviewer', match: 'program office first' },
      { newConversation: true, prompt: "Who should receive this client's budget briefs first?" },
    ],
  },
];
