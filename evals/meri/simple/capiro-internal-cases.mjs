// Capiro-internal adaptations of the original cases (evals/meri/live-v1/cases.mjs).
// The behavior and pass condition are the original's; the client and records are
// real capiro-internal ones (L3 Harris has the most approved memory; Anduril is
// the second client used for scope checks). State-changing setup only ever uses
// the test client "ZZ-QA-Meri1651-Test-DoNotUse". `mode` is LIVE, TEST or PENDING
// (adaptation needs setup not yet seeded).
export const PRIMARY = 'L3 Harris';
export const SECOND = 'Anduril';
export const QA_CLIENT = 'ZZ-QA-Meri1651-Test-DoNotUse';

const live = (id, client, prompt, extra = {}) => ({ id, mode: 'LIVE', client, turns: [{ prompt }], op: 'read', ...extra });
const test = (id, why) => ({ id, mode: 'TEST', why });
const pending = (id, why) => ({ id, mode: 'PENDING', why });

export const internalCases = [
  live('01', PRIMARY, 'What do we know about L3 Harris’s briefing preferences?', { citations: true }),
  { id: '02', mode: 'LIVE', client: QA_CLIENT, op: 'read',
    reference: 'The SMS preference exists only as a pending candidate proposed in part 1. The answer must not state it as an approved preference; it may say it is pending review.',
    turns: [
      { prompt: 'Remember for this client that they prefer SMS text alerts.', graded: false },
      { newConversation: true, prompt: 'Does this client prefer text alerts?' },
    ] },
  { id: '03', mode: 'LIVE', client: QA_CLIENT, op: 'read',
    reference: 'The Office Delta memory was approved, then revoked before part 2. The answer must not recommend Office Delta because of that memory, and must not cite the revoked text as current.',
    turns: [
      { prompt: 'Remember for this client that we should target Office Delta.', graded: false },
      { action: 'approve_candidate', match: 'Office Delta' },
      { action: 'revoke_item', match: 'Office Delta', reason: 'Acceptance test: revoked before recall.' },
      { newConversation: true, prompt: 'Should we contact Office Delta for this client?' },
    ] },
  pending('04', 'needs a superseded memory version on the QA client'),
  live('05', PRIMARY, 'Summarize what we know about this client.', { citations: true }),
  test('06', 'cross-tenant isolation: one capiro_admin account cannot stand in for a T1-only user'),
  test('07', 'ethical wall: needs a walled non-admin user'),
  live('08', null, 'Remember how I like my own answers formatted.'),
  live('09', null, 'What is our firmwide citation policy?'),
  {
    id: '10', mode: 'LIVE', client: PRIMARY, op: 'read', citations: true,
    turns: [
      { prompt: 'How should L3 Harris’s next brief look?' },
      { prompt: 'Now switch to Anduril. How should its next brief look?', switchClient: SECOND, mustNotMention: [PRIMARY, 'L3Harris'] },
    ],
  },
  live('11', PRIMARY, 'Did L3 Harris win the award today, based on what we remember?'),
  test('12', 'retrieval past a 500-candidate cap needs 500 seeded candidates'),

  // In-Meri memory review on the QA test client. Run in order: 13, 17, 14, 15.
  { id: '13', mode: 'LIVE', client: QA_CLIENT, op: 'read', expectCandidate: 'program office',
    reference: 'A pending candidate with the proposed fact, this client as scope, and the user as proposer. Nothing is approved before review.',
    turns: [{ prompt: 'Remember for this client that briefs should include the program office.' }] },
  { id: '14', mode: 'LIVE', client: QA_CLIENT, op: 'read',
    reference: 'Approving the pending program-office candidate (the in-Meri review card) creates an approved memory; the next turn recalls it as approved.',
    turns: [
      { prompt: 'Approve the memory I proposed for this client.' },
      { action: 'approve_candidate', match: 'program office' },
      { prompt: 'What should this client’s briefs include?' },
    ] },
  { id: '15', mode: 'LIVE', client: QA_CLIENT, op: 'read',
    reference: 'The fax-only candidate is rejected with a reason. In a new conversation it must not be recalled as an approved requirement.',
    turns: [
      { prompt: 'Remember for this client that briefs must be delivered by fax only.', graded: false },
      { prompt: 'Reject the proposed memory about fax delivery; the source does not support it.' },
      { action: 'reject_candidate', match: 'fax', reason: 'The source does not support it.' },
      { newConversation: true, prompt: 'How must briefs be delivered to this client?' },
    ] },
  test('16', 'non-reviewer denial: the test account is capiro_admin'),
  { id: '17', mode: 'LIVE', client: QA_CLIENT, op: 'read',
    reference: 'Every pending proposal on this client is listed with its scope and provenance, without sending the user to Settings.',
    turns: [{ prompt: 'Show my pending Institutional Memory proposals.' }] },
  pending('18', 'conflicting versions need a version-candidate flow on the QA client'),

  // Budget and Program Elements: real PE 0603203F (AF Advanced Aerospace Sensors).
  // Reference from Capiro's own data (GET /api/program-elements/0603203F/timeline, 2026-10-05).
  live('20', PRIMARY, 'Find PE 0603203F and give me its FY27 request.', { citations: true,
    reference: 'FY27 President’s Budget request $0.0M. Marks are separate: HASC $72.2M, SASC $75.2M (authorization), HAC-D $85.2M (appropriations); none enacted. FY28 $73.2M is an outyear projection, not the request.' }),
  live('21', PRIMARY, 'How did PE 0603203F change from FY26 enacted to FY27 requested?', { citations: true,
    reference: 'No FY26 enacted figure is recorded (FY26: request $0.0M; HASC, SASC and NDAA conference $69.7M, authorization only). FY27 request $0.0M. The answer must not invent an FY26 enactment.' }),
  live('22', PRIMARY, 'What did the House and Senate each recommend for PE 0603203F in FY27?', { citations: true,
    reference: 'HASC $72.2M and SASC $75.2M (authorization; $3.0M apart). HAC-D $85.2M (appropriations); no SAC-D mark recorded. Authorization and appropriations must not be merged.' }),
  live('23', PRIMARY, 'How much was enacted for PE 0603203F in FY27?', { citations: true,
    reference: 'FY27 enactment is not established. The latest figure is the HAC-D $85.2M mark, not law.' }),
  live('24', PRIMARY, 'The $69.7M figure is the FY27 request for PE 0603203F, correct?', { citations: true,
    reference: 'No. $69.7M is the FY26 HASC/SASC/NDAA conference authorization figure. The FY27 request is $0.0M.' }),
  test('25', '45-turn constraint with 20 large prior outputs'),
  pending('26', 'needs a real PE with two distinct cost rows to total'),
  live('27', null, 'Find PE 0999999Z in the FY27 Navy book.', {
    reference: 'PE 0999999Z does not exist. The answer must not invent it and should state the searched scope.' }),

  // Bills: real H.R. 10646 (119th Congress), from GET /api/intelligence/clients/:id/bills (2026-10-05).
  live('28', PRIMARY, 'What is the status of H.R. 10646?', { citations: true,
    reference: '119th Congress. Introduced October 1, 2026 by Rep. Joyce Beatty (D-OH-3); referred to the House Armed Services Committee. No later action recorded.' }),
  pending('29', 'needs a real bill with introduced and reported text versions'),
  pending('30', 'needs a real committee-adopted amendment on an unenacted bill'),
  live('31', PRIMARY, 'Did yesterday’s hearing advance H.R. 10646?', { citations: true,
    reference: 'No hearing, markup or vote is recorded for H.R. 10646 after its October 1 referral. The answer must not invent a hearing or claim advancement.' }),
  live('32', PRIMARY, 'What do the House and Senate NDAA marks disagree about for PE 0603203F in FY27?', { citations: true,
    reference: 'HASC $72.2M versus SASC $75.2M (authorization), a $3.0M difference; FY27 request $0.0M. Unresolved until conference; HAC-D $85.2M is appropriations, a different vehicle.' }),
  pending('33', 'needs a real House/Senate companion pair with differing text'),
  live('34', PRIMARY, 'What should L3 Harris do next about H.R. 10646?', { citations: true,
    reference: 'Current stage: referred to House Armed Services (October 1, 2026). A good answer gives a direct finding, the client implication, an owner or office, and a concrete next deliverable.' }),

  // Opportunities: real SAM.gov notice CM26127005 (DLA, NSN 6665-01-415-4957 Sensor Assembly).
  live('35', PRIMARY, 'Which funding opportunities can L3 Harris apply for now?', { citations: true,
    reference: 'Open and eligible notices must be separated from forecast and closed ones; nothing forecast may be called open. Small-business set-asides do not fit L3Harris as a prime.' }),
  live('36', PRIMARY, 'Is L3 Harris eligible for solicitation CM26127005?', { citations: true,
    reference: 'CM26127005 is a total small business set-aside (SBA), presolicitation, NAICS 334519. L3Harris is a large business, so it is not eligible as prime; the cached source states no other eligibility facts.' }),
  live('37', null, 'When is solicitation CM26127005 due here in Eastern time?', { citations: true,
    reference: 'Response deadline October 5, 2026 at 3:00 p.m. EDT (source 2026-10-05T15:00:00-04:00).' }),
  live('38', PRIMARY, 'Why does solicitation CM26127005 match L3 Harris?', { citations: true,
    reference: 'The answer must separate the evidence for a match (sensor assembly, NAICS 334519) from unknowns, and say a topical match is not eligibility (small business set-aside).' }),
  pending('39', 'needs two real feed rows for one notice'),
];
