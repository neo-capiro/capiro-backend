// Real tasks from the program plan (docs/meri/implementation/00-Meri-Program-Plan-2026-10-05.md §8),
// run once each as neo@capiro.ai in capiro-internal through the ordinary product path.
// Neo's pass/fail verdict is the result; automatic checks are safety aids only.
// State-changing setup only on the QA client. Approvals that need a second person
// use the synthetic reviewer configured in MERI_RUNNER_SECOND_IDENTITY (D9). Action
// proposals are approved by their owner (decided 2026-10-07; see the finish plan),
// so T8 is approved by the tester, and only for a card addressed to the tester.
const PRIMARY = 'L3 Harris';
const QA_CLIENT = 'ZZ-QA-Meri1651-Test-DoNotUse';
// Neo's commitments audit prompt (2026-10-05/06 runs; efficiency check 594a31e5).
const COMMITMENTS_AUDIT_PROMPT =
  'What has changed with the commitments and deliverables we owe this client? Audit every commitment we have made. List each commitment with: what was promised, when and where it was made, the internal owner, current status (completed, in progress, or no record of action), and what needs follow-up. Cross-check emails, meeting notes, debriefs, native tasks, action items, and monday.com work from boards explicitly mapped to this client or a board ID/link I supplied: explicitly flag any commitment found in an email or meeting summary that has no corresponding tracked task or action item. Do not treat unrelated personal monday.com work as this client’s commitment, do not mark anything complete without evidence, cite the underlying records, and say whether monday.com was checked, disconnected, unavailable, or not mapped.';

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
  {
    // Synthetic files from make-files.mjs: page 4 of the PDF states the capability
    // ("unmanned maritime sensors for littoral surveillance"); the sheet's cost
    // column is Sensors 1.25, Integration 2.50, Testing 3.75 ($M), total 7.50.
    // A Word export is a generated file, not an external effect: full chat runs
    // create_word at once (recorded as one succeeded proposal, no approval step),
    // and the turn carries its download link.
    id: 'T4', mode: 'LIVE', client: QA_CLIENT, op: 'artifact_create', expectDownloadKind: 'docx',
    reference: 'Answers from both files (page 4 capability; total 7.50 $M; Testing 3.75 is the largest line), then a Word document whose download opens as a .docx.',
    turns: [
      { prompt: 'What capability does the attached PDF describe on page 4?', attach: ['qa-capability-profile.pdf', 'qa-cost-sheet.xlsx'] },
      { prompt: 'What is the total of the cost column in the attached spreadsheet?' },
      { prompt: 'Which cost line is the largest, and how does it relate to the capability on page 4?' },
      { prompt: 'Export that answer as a Word document.' },
    ],
  },
  {
    // Release D, permission gate. Owner approval; the only allowed delivery is
    // the tester's own mailbox, checked by sendToTesterGate before approving.
    id: 'T8', mode: 'LIVE', client: PRIMARY, op: 'send',
    reference: "A proposal card appears addressed only to the tester; nothing sends before approval; after approval inside Meri the summary arrives in the tester's own mailbox.",
    turns: [
      { prompt: "Draft an email to me summarizing today's L3Harris items and send it." },
      { action: 'approve_send_to_tester' },
    ],
  },
  {
    // Release D, audit. Read-only: no proposal and no task is created. Statuses
    // limited to completed, in progress, no record of action (Neo's verdict).
    id: 'T9', mode: 'LIVE', client: PRIMARY, op: 'audit', citations: true,
    reference: 'Every commitment listed with what was promised, when and where, owner, status (completed, in progress, or no record of action only) and follow-up; untracked commitments flagged; monday.com check state stated; no task created.',
    turns: [{ prompt: COMMITMENTS_AUDIT_PROMPT }],
  },
];
