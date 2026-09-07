import { meriEvalFixtureSchema, type MeriEvalFixture } from './eval.types.js';

/** Invented evaluation records, never production/client data or current government facts. */
export const GA_FIXTURE_VERSION = '2026-09-06.1';
export interface GovernmentAffairsFixture extends MeriEvalFixture {
  observedAt: string;
  requiredSourceIds: number[];
  reviewChecks: string[];
  referenceAnswer: string;
}

const client = {
  id: 1,
  title: 'Synthetic Arbor Sensors profile / strategy AS-7; observed 2026-09-06',
  text: 'Record client:arbor, sections capabilities/facilities/constraints; source eval://client/arbor. Arbor Sensors is a for-profit small business. Capability: marine acoustic sensors. Headquarters: WA-07; plant: OR-01. Facilities coverage: 2 of 3 returned; third facility unavailable, location unknown. Strategy AS-7 approved 2026-09-01: pursue a Navy demonstration in FY2027; preserve a credible technical ask without representing proposed funding as enacted. Finance has not approved matching cash. Strategy owner: government affairs director. Earlier attachment AS-brief section 4 requires limiting any spending commitment to enacted funding. These are synthetic fixtures, not real client facts.',
};
const budget = {
  id: 2,
  title: 'Synthetic FY2027 Navy budget table / PE 0609001N, project DEM-1, page 42',
  text: 'Source eval://budget/fy2027/page/42, observed 2026-09-06. Units: thousands of dollars. FY2027 request: 12,000; House appropriations committee recommendation: 9,000. Same PE 0609001N, project DEM-1 and scope. Delta is -3,000 thousand dollars (-$3 million, -25%). Neither stage is enacted. Separate authorization proposal mentions $14 million; it is not an appropriation. FY2026 award AW-8 for $200,000 is historical, not new FY2027 funds. No final enacted amount in the supplied records. Committee staff accepts technical follow-up; no submission deadline verified.',
};
const hearing = {
  id: 3,
  title: 'Synthetic maritime hearing H-77 / transcript section 6 at 00:47:12',
  text: 'Source eval://hearing/H-77/transcript/6, observed 2026-09-06; hearing held 2026-09-04. At 00:47:12 Dr. Mira Lin, technical witness, stated: "We need a demonstration to measure acoustic detection in coastal noise." This is a witness recommendation, not adopted policy, an appropriation or an award. At 00:49:03 the chair invited technical data without promising funding. No numerical performance threshold or follow-up deadline was stated. Metadata headline says "Committee approves sensors" but the full transcript records no vote; headline is not evidence of adoption.',
};

function fixture(input: Omit<GovernmentAffairsFixture, 'observedAt'>): GovernmentAffairsFixture {
  return { ...input, ...meriEvalFixtureSchema.parse(input), observedAt: '2026-09-06' };
}

export const GOVERNMENT_AFFAIRS_FIXTURES: GovernmentAffairsFixture[] = [
  fixture({
    id: 'ga-budget-stage-and-units',
    skill: 'appropriations',
    question:
      'Should Arbor treat the FY2027 Navy mark as secured funding? Recommend the next government-affairs action and quantify the change.',
    sources: [client, budget],
    expect: {
      mustInclude: ['0609001N', 'DEM-1', '2027', '25%'],
      mustNotInclude: ['funding is secured', 'the enacted amount is $9 million'],
      mustCite: true,
    },
    requiredSourceIds: [1, 2],
    reviewChecks: [
      'Correct -$3 million and -25% with thousands-to-dollars units.',
      'Separate request, committee, authorization, enacted and award.',
      'Connect demonstration strategy and earlier enacted-only constraint.',
      'Suggest technical staff ask without inventing a deadline; identify absent enacted proof.',
    ],
    referenceAnswer:
      'Recommend a technical follow-up, not a spending commitment. Arbor’s marine sensors fit strategy AS-7, but its earlier attachment permits spending commitments only against enacted funding; WA-07/OR-01 footprint supports a proposed local-impact case, with the third facility unverified. [1] Observed 2026-09-06, FY2027 PE 0609001N / DEM-1, page 42, in thousands: request 12,000 versus House appropriations committee 9,000 is a $3 million reduction, or 25%. Neither is enacted; authorization and the FY2026 award are separate. [2] Inference: the reduction creates demonstration risk; seeking restoration or a smaller demonstration are alternatives, not approved strategies. The government affairs director should propose a one-page technical brief to committee staff. No deadline is verified. Retrieve enacted status and the missing facility before finalizing the case. [1][2]',
  }),
  fixture({
    id: 'ga-funding-eligibility-and-forecast',
    skill: 'funding',
    question: 'Rank these funding options for Arbor and tell us what we can actually pursue now.',
    sources: [
      client,
      {
        id: 2,
        title: 'Synthetic canonical Funding Opportunities matching result / match run M-41',
        text: 'Source eval://funding/matches/M-41 observed 2026-09-06. Canonical matching service results, not raw similarity. FO-1: OPEN marine sensor demonstration, small-business for-profit applicants allowed, US performance, deadline 2026-10-15 17:00 ET, 20% non-federal cash match mandatory; Arbor capability/geography pass, overall conditional because matching cash unverified, confidence medium. FO-2: OPEN, eligible applicants nonprofit universities only; Arbor explicitly ineligible despite strong sensor similarity. FF-3: PROCUREMENT FORECAST, anticipated release FY2027 Q2, no open solicitation or verified due date, eligibility not determined. Do not reinterpret forecast date as deadline.',
      },
    ],
    expect: {
      mustInclude: ['FO-1', 'FO-2', 'FF-3', '20%', '2026-10-15'],
      mustNotInclude: ['Arbor is eligible for FO-2', 'FF-3 is open'],
      mustCite: true,
    },
    requiredSourceIds: [1, 2],
    reviewChecks: [
      'Use canonical conditional/ineligible outcomes instead of inventing a match score.',
      'Cash-match uncertainty blocks unconditional recommendation.',
      'FO-2 nonprofit disqualifier outweighs capability similarity.',
      'Forecast is monitoring only; do not turn release quarter into a deadline.',
    ],
    referenceAnswer:
      'Prioritize conditional diligence on FO-1: Arbor’s marine sensors and US facilities match, but finance has not approved matching cash. The third facility is also unavailable. [1] Canonical match M-41, observed 2026-09-06, permits for-profit small businesses; FO-1 is open, requires 20% non-federal cash, and closes 2026-10-15 at 17:00 ET. Confidence is medium until the match is verified. FO-2 is disqualified because only nonprofit universities qualify. FF-3 is a procurement forecast, not an open opportunity or known deadline. [2] The government affairs director should ask finance for match approval and have the proposal lead prepare the eligibility checklist before the published FO-1 deadline. If no match is available, do not submit; monitor FF-3 instead. No new matching score is asserted. [1][2]',
  }),
  fixture({
    id: 'ga-meeting-history-and-role',
    skill: 'meeting',
    question:
      'Prepare Arbor for its next discussion with the WA-07 office, using the actual history and a specific ask.',
    sources: [
      client,
      {
        id: 2,
        title: 'Synthetic office directory verification and meeting debrief / D-5, M-12',
        text: 'Source eval://meetings/M-12#commitments observed 2026-09-06. Meeting on 2026-09-02 with Alex Reed; directory D-5 verified 2026-09-05 lists Reed as WA-07 legislative assistant, not chief of staff. Arbor promised a two-page noise-test summary by 2026-09-09. Office offered to review it; no funding support or introduction promised. Next meeting 2026-09-10 at 14:00 ET. Technical lead owns noise-test summary. Unverified old CRM note calls Reed chief of staff; current verified directory supersedes this role note.',
      },
    ],
    expect: {
      mustInclude: ['Alex Reed', 'legislative assistant', '2026-09-09'],
      mustNotInclude: ['Reed promised funding', 'Reed is chief of staff'],
      mustCite: true,
    },
    requiredSourceIds: [1, 2],
    reviewChecks: [
      'Carry forward actual technical-data commitment, not fictional relationship leverage.',
      'Use current verified role rather than stale CRM title.',
      'Specific ask and concise talking points serve the approved client objective.',
      'Separate proposed introduction from office commitment.',
    ],
    referenceAnswer:
      'Arbor should earn a credible demonstration discussion by delivering its promised evidence first. Its marine sensors and WA-07 headquarters support AS-7, while OR-01 plant and an unknown third facility require careful geographic claims. [1] Debrief M-12 and directory D-5, observed 2026-09-06, identify Alex Reed as legislative assistant, verified 2026-09-05. The office promised review only. [2] Ask Reed to review the two-page noise-test summary and discuss a suitable technical office; an introduction is a proposal, not a commitment. Talking points: demonstration objective, measured capability, and evidence still needed. Technical lead should deliver the summary by 2026-09-09; government affairs director should prepare the 2026-09-10 14:00 ET meeting and record follow-up. Matching funds and complete facility details remain unverified. [1][2]',
  }),
  fixture({
    id: 'ga-hearing-statement-versus-decision',
    skill: 'hearing',
    question:
      'Does the hearing mean Arbor has won a funded demonstration? Give actionable intelligence from the transcript.',
    sources: [client, hearing],
    expect: {
      mustInclude: ['Mira Lin', '00:47:12'],
      mustNotInclude: ['Arbor has won funding', 'the committee adopted the demonstration'],
      mustCite: true,
    },
    requiredSourceIds: [1, 3],
    reviewChecks: [
      'Use exact speaker and timestamp plus the transcript location.',
      'Reject misleading metadata headline in favor of actual recorded statement.',
      'Tie coastal-noise evidence to client capability and strategy.',
      'Propose technical response without invented adopted policy or deadline.',
    ],
    referenceAnswer:
      'No funded demonstration is established. Arbor’s marine acoustic sensors fit the question raised and AS-7, but a spending commitment still requires enacted proof. Its WA-07/OR-01 footprint is known; the third facility is unavailable. [1] H-77 transcript section 6, observed 2026-09-06: at 00:47:12 Dr. Mira Lin recommended a demonstration to measure acoustic detection in coastal noise; at 00:49:03 the chair invited technical data. These are statements, not a vote, appropriation or award. The headline overstates the transcript. [3] Inference: a concise coastal-noise test brief may advance a technical conversation; an alternative is gathering additional results first. Government affairs director should coordinate the technical lead’s proposed brief to committee staff. No deadline or performance threshold is verified; retrieve those before committing. [1][3]',
  }),
  fixture({
    id: 'ga-legislation-current-version',
    skill: 'legislation',
    question:
      'What does the sensor certification bill require Arbor to do now, and whom should we approach?',
    sources: [
      client,
      {
        id: 2,
        title: 'Synthetic federal bill version and stage / HR 9998, 119th Congress, IH §402',
        text: 'Source eval://legislation/119/hr9998/IH#402, observed 2026-09-06. Federal jurisdiction; 119th Congress. Current verified version: introduced House (IH), referred to House Armed Services Committee, no committee report or enactment. Section 402 proposes certification within 90 days after enactment. No current statutory certification deadline exists from this bill. Prior bill in 118th Congress expired and used 30 days; it is not this version. Committee jurisdiction supports contacting committee staff; no current individual staff assignment or hearing date is verified.',
      },
    ],
    expect: {
      mustInclude: ['119', '402', '90 days'],
      mustNotInclude: ['Arbor must certify within 30 days', 'HR 9998 is enacted'],
      mustCite: true,
    },
    requiredSourceIds: [1, 2],
    reviewChecks: [
      'Federal 119th Congress introduced version differs from expired 118th.',
      'Ninety days begins only after possible enactment, not today.',
      'Practical readiness recommendation is labeled proposed strategy.',
      'Use verified committee jurisdiction without fabricated staff assignment or hearing date.',
    ],
    referenceAnswer:
      'Prepare a readiness assessment rather than treat the proposal as a current deadline. Arbor’s marine sensors may be affected; AS-7 and the unavailable third facility make scope confirmation material. [1] Federal HR 9998, 119th Congress, IH section 402, observed 2026-09-06, is introduced and referred to House Armed Services Committee. It proposes certification 90 days after enactment; the expired 118th Congress 30-day text is not current. [2] Inference: early technical comments could shape workable certification; waiting for a committee revision is an alternative. Government affairs director should have the technical lead draft implementation questions for committee staff. Verify the assigned office role, covered products and schedule before outreach; no present legal deadline or hearing date is supported. [1][2]',
  }),
  fixture({
    id: 'ga-executive-consistent-deliverable',
    skill: 'executive',
    question:
      'Write a complete executive decision briefing for Arbor using the same budget, hearing and strategy evidence. Include prioritized recommendations, owners, and material gaps.',
    sources: [client, budget, hearing],
    expect: {
      mustInclude: ['0609001N', 'DEM-1', '25%', '00:47:12'],
      mustNotInclude: ['the demonstration is funded', 'enacted FY2027 funding totals $9 million'],
      mustCite: true,
    },
    requiredSourceIds: [1, 2, 3],
    reviewChecks: [
      'Complete decision-ready brief, no placeholder sections or promised unwritten appendix.',
      'Same stage, delta, speaker and sources as chat; no upgraded claims in deliverable.',
      'Prioritize actionable recommendation with owner and realistic target.',
      'Explicit uncertainty, alternative course, missing enacted proof and partial facility coverage.',
    ],
    referenceAnswer:
      'Decision: authorize technical engagement, not a spending commitment. Arbor’s AS-7 objective, marine sensors and WA-07/OR-01 footprint support a demonstration case; a third facility is unavailable and matching cash is unapproved. [1] Evidence observed 2026-09-06: FY2027 PE 0609001N / DEM-1, page 42, thousands of dollars, request 12,000 versus House appropriations committee 9,000 is a $3 million reduction (25%). It is not enacted funding; authorization and historical awards are separate. [2] H-77 section 6: Dr. Mira Lin at 00:47:12 recommended coastal-noise demonstration evidence; the statement and chair’s invitation are not policy adoption or funding. [3] Judgment: a smaller demonstration or restoration case could fit, but either is proposed strategy. Priority 1: government affairs director and technical lead prepare a one-page evidence brief for committee staff. Priority 2: finance verify any commitment against enacted proof and match availability. No submission deadline is verified. Missing information: final enacted status, performance thresholds, third facility and staff timing; retrieve before committing resources. [1][2][3]',
  }),
];

/** The provider sees records, not the expected answer, checklist or grading keys. */
export function governmentAffairsFixtureInput(fixture: GovernmentAffairsFixture): string {
  return `Synthetic evaluation as of ${fixture.observedAt}. Use only the supplied records. They are the complete available fixture evidence; identify unavailable data instead of inventing retrieval. Cite the supplied source numbers inline.\n\n${fixture.sources.map((source) => `[${source.id}] ${source.title}\n${source.text}`).join('\n\n')}\n\nUser request: ${fixture.question}`;
}
