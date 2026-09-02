/**
 * Hill Day module — the prototype's own data, verbatim.
 *
 * The wizard/editor hydrate from this module until the Hill Day backend
 * module (requirements §6 endpoints) ships. Every string below is copied from
 * the prototype's dc script (hill-day.dcscript.js) so the rendered surface
 * matches the prototype exactly — no invented data, per the honest-gap rule.
 */
import type {
  BlueprintDef,
  ClientOption,
  HillDayMeeting,
  LibraryDocRow,
  MeetingDirectory,
  ThreadRef,
} from './types.js';

export const BLUEPRINTS: BlueprintDef[] = [
  {
    name: 'Hill Day Schedule',
    desc: 'One context-rich prep section per congressional meeting, assembled from the sponsor’s calendar.',
    meta: '6 steps · Meri drafts Focus and Background',
    icon: 'CalendarCheck01',
    isNew: true,
    sources: ['Calendar', 'Directory', 'Portfolio', 'Intelligence'],
  },
  {
    name: 'Client strategy brief',
    desc: 'Recommendation, funding position, plan of action, risks and decision gates.',
    meta: '5 steps · quarterly cadence',
    icon: 'Diamond01',
    isNew: false,
    sources: ['Portfolio', 'Strategies', 'LegiWatch'],
  },
  {
    name: 'Meeting prep',
    desc: 'A single office, briefed from the Directory record and the member’s legislative history.',
    meta: '3 steps · used 118 times',
    icon: 'ClipboardCheck',
    isNew: false,
    sources: ['Directory', 'Intelligence'],
  },
  {
    name: 'Coalition memo',
    desc: 'Shared position, member-by-member status and the next action per office.',
    meta: '4 steps · firm scope',
    icon: 'Users01',
    isNew: false,
    sources: ['Portfolio', 'Directory'],
  },
];

/** The library "Start a workflow" card list (all seven templates published). */
export const LIBRARY_TEMPLATES: BlueprintDef[] = [
  BLUEPRINTS[0]!,
  ...BLUEPRINTS.slice(1),
  {
    name: 'Testimony prep',
    desc: 'Written and oral testimony drafted from the record and the member’s own framing.',
    meta: '4 steps · hearing cycle',
    icon: 'ClipboardCheck',
    isNew: false,
    sources: ['Directory', 'Intelligence'],
  },
  {
    name: 'Quarterly client report',
    desc: 'Activity, outcomes and position across the client’s full portfolio.',
    meta: '4 steps · quarterly cadence',
    icon: 'BarChartSquare02',
    isNew: false,
    sources: ['Portfolio', 'Engagement'],
  },
  {
    name: 'Client onboarding brief',
    desc: 'Who the client is, what they build, and how the firm will represent them.',
    meta: '3 steps · firm scope',
    icon: 'File04',
    isNew: false,
    sources: ['Portfolio', 'Directory'],
  },
];

export const LIBRARY_DOCS: LibraryDocRow[] = [
  {
    name: 'Kela Systems Hill Day Schedule',
    type: 'Hill Day Schedule',
    client: 'Kela Systems',
    tone: 'gray',
    label: 'Draft',
    updated: '4m ago',
    owner: 'NM',
    icon: 'CalendarCheck01',
    isHill: true,
  },
  {
    name: 'Overland AI Client Strategy Brief',
    type: 'Strategy brief',
    client: 'Overland AI',
    tone: 'ok',
    label: 'Approved',
    updated: 'Aug 10',
    owner: 'NM',
    icon: 'Diamond01',
    isHill: false,
  },
  {
    name: 'Testimony prep — HASC Seapower',
    type: 'Testimony prep',
    client: 'Kela Systems',
    tone: 'navy',
    label: 'Generating',
    updated: 'Aug 31',
    owner: 'JC',
    icon: 'Microphone01',
    isHill: false,
  },
  {
    name: 'Sen. Cruz office — meeting prep',
    type: 'Meeting prep',
    client: 'Kela Systems',
    tone: 'dark',
    label: 'Shared with client',
    updated: 'Aug 28',
    owner: 'NM',
    icon: 'ClipboardCheck',
    isHill: false,
  },
  {
    name: 'FY27 Ground Robotics coalition memo',
    type: 'Coalition memo',
    client: 'Overland AI',
    tone: 'warn',
    label: 'In review',
    updated: 'Aug 24',
    owner: 'JC',
    icon: 'Users02',
    isHill: false,
  },
  {
    name: 'Aeon Grid quarterly report',
    type: 'Client report',
    client: 'Aeon Grid',
    tone: 'gray',
    label: 'Draft',
    updated: 'Aug 19',
    owner: 'RS',
    icon: 'BarChartSquare02',
    isHill: false,
  },
  {
    name: 'Northwind Marine onboarding brief',
    type: 'Client brief',
    client: 'Northwind Marine',
    tone: 'gray',
    label: 'Archived',
    updated: 'Jul 30',
    owner: 'RS',
    icon: 'File04',
    isHill: false,
  },
];

export const CLIENTS: ClientOption[] = [
  {
    id: 'kela',
    mono: 'KS',
    name: 'Kela Systems',
    meta: 'Uncrewed maritime systems · 6 objectives · 14 offices',
  },
  {
    id: 'overland',
    mono: 'OA',
    name: 'Overland AI',
    meta: 'Ground autonomy · 4 objectives · 22 offices',
  },
  {
    id: 'aeon',
    mono: 'AG',
    name: 'Aeon Grid',
    meta: 'Grid resilience · 3 objectives · 9 offices',
  },
  {
    id: 'northwind',
    mono: 'NM',
    name: 'Northwind Marine',
    meta: 'Shipbuilding supply · 2 objectives · 5 offices',
  },
];

export const SPONSOR_SUPPLIES = [
  {
    title: 'Calendar scope',
    body: 'Only events associated with this client’s people surface in the picker.',
  },
  {
    title: 'Objectives',
    body: 'Focus is written against the client’s Portfolio objectives and live Strategies.',
  },
  {
    title: 'Engagement history',
    body: 'Prior meetings with each office, and what was promised in them.',
  },
  {
    title: 'Branding',
    body: 'Client logo from the Portfolio profile, alongside the firm mark.',
  },
];

export const MEETINGS: HillDayMeeting[] = [
  {
    id: 'x1',
    day: 1,
    time: '3:00 PM',
    dur: '45 min',
    subject: 'Kela Systems — Maven Advocacy pre-brief',
    short: 'Pre-brief with Kela leadership',
    place: 'Video call',
    kind: 'internal',
  },
  {
    id: 'm1',
    day: 2,
    time: '8:45 AM',
    dur: '30 min',
    subject: 'Kela Systems / SASC staff — FY27 unmanned surface vessel line',
    short: 'SASC staff — FY27 USV line',
    place: 'Dirksen 555',
    kind: 'hill',
    member: 'Sen. Roger Wicker (R-MS)',
    party: 'Republican · Mississippi',
    room: 'Dirksen 555',
    cmte: 'Armed Services (Chair) · Commerce, Science and Transportation · Rules and Administration',
    att: [
      {
        name: 'Cal Perrine',
        detail:
          'Professional Staff Member, Senate Armed Services · cal_perrine@armed-services.senate.gov',
        state: 'resolved',
      },
      {
        name: 'Hannah Voight',
        detail: 'Legislative Aide, Office of Sen. Wicker · hannah_voight@wicker.senate.gov',
        state: 'resolved',
      },
    ],
    focus:
      'Ask the Chairman’s staff to hold the $48M unmanned surface vessel line in the SASC mark and to keep the report language directing a Navy certification pathway for autonomous hulls. Wicker’s own shipbuilding framework already counts uncrewed vessels toward the fleet target, so this is an extension of a position the office holds rather than a new commitment. Perrine owns the seapower portfolio and will not take anything to the Chairman without delivered-hull and unit-cost numbers, so lead with those.',
    background:
      'Wicker chairs Armed Services and has pressed the Navy in three hearings this Congress on the gap between unmanned prototyping and fielded programs. Kela has met this office twice — February 2026 on the supplemental, and June 2026 with the Gulf Coast production plan. Perrine asked in June for unit cost at rate and has not received it. Your note for this meeting: bring the one-pager and do not re-litigate the fleet-count argument.',
  },
  {
    id: 'm2',
    day: 2,
    time: '10:00 AM',
    dur: '45 min',
    subject: 'Rep. Wittman staff — Seapower markup and USV procurement',
    short: 'Wittman staff — Seapower markup',
    place: 'Rayburn 2454',
    kind: 'hill',
    member: 'Rep. Rob Wittman (R-VA-01)',
    party: 'Republican · Virginia 1st',
    room: 'Rayburn 2454',
    cmte: 'Armed Services · Seapower and Projection Forces (Chair) · Natural Resources',
    att: [
      {
        name: 'Delaney Rusk',
        detail: 'Legislative Director · delaney.rusk@mail.house.gov',
        state: 'resolved',
      },
      {
        name: 't.okonjo@mail.house.gov',
        detail:
          'No Directory record for this address. Defense fellows and detailees are routinely absent.',
        state: 'unresolved',
      },
    ],
    focus:
      'Secure subcommittee support for the FY27 procurement line and a commitment to carry the certification pathway into the HASC markup. This is the office where the authorising text is written rather than defended, so the ask is specific: language, not sympathy. Rusk will want to know whether the Senate side is aligned before she commits the Chairman.',
    background:
      'Wittman chairs Seapower and Projection Forces and represents Virginia’s First District with its Newport News supplier base. He has backed capacity expansion at second-tier yards and has questioned single-source dependence across the unmanned portfolio. Kela met this office in April 2026; the outstanding request from that meeting was a supplier map by congressional district.',
  },
  {
    id: 'm3',
    day: 2,
    time: '11:15 AM',
    dur: '30 min',
    subject: 'Sen. Collins scheduling — FY27 defense appropriations introduction',
    short: 'Collins office — FY27 approps intro',
    place: 'Dirksen 413',
    kind: 'hill',
    member: 'Sen. Susan Collins (R-ME)',
    party: 'Republican · Maine',
    room: 'Dirksen 413',
    cmte: 'Appropriations (Chair) · Defense subcommittee · Intelligence',
    att: [
      {
        name: 'scheduling@collins.senate.gov',
        detail: 'Scheduling address only. No substantive attendees on the invite yet.',
        state: 'scheduler',
      },
    ],
    focus:
      'Introduce the FY27 appropriations request and tie it to the Maine maritime supplier base. No commitment is expected; the objective is to place the request with defense staff before the subcommittee sets its FY27 hearing schedule. Confirm who from the office will actually attend before the packet is printed.',
    background:
      'Collins chairs Appropriations and sits on the Defense subcommittee. Maine’s maritime industrial base is a standing priority for the office. Kela has no prior engagement here — this is a first meeting, and the invite carries only the scheduler, so attendees were added manually.',
  },
  {
    id: 'm4',
    day: 2,
    time: '1:30 PM',
    dur: '30 min',
    subject: 'Sen. Cruz staff — autonomy certification jurisdiction',
    short: 'Cruz staff — certification jurisdiction',
    place: 'Russell 404',
    kind: 'hill',
    member: 'Sen. Ted Cruz (R-TX)',
    party: 'Republican · Texas',
    room: 'Russell 404',
    cmte: 'Commerce, Science and Transportation (Chair) · Armed Services · Judiciary',
    att: [
      {
        name: 'Madison Sparber',
        detail: 'Legislative Assistant, Office of Sen. Cruz · madison.sparber@senate.gov',
        state: 'resolved',
      },
    ],
    focus:
      'Establish Commerce jurisdiction over the certification pathway before Coast Guard authorisation moves. Cruz chairs the committee that owns commercial vessel certification, and Sparber has already asked once, in writing, where the pathway sits between the Coast Guard and the Navy. Arrive with that answer on paper.',
    background:
      'Cruz chairs Commerce, Science and Transportation, which holds jurisdiction over Coast Guard authorisation and commercial vessel certification. Texas hosts Kela’s Corpus Christi integration facility and 240 of its employees. Sparber has been the working contact since March 2026 and moved the office from neutral to interested after the July technical briefing.',
  },
  {
    id: 'm5',
    day: 2,
    time: '2:45 PM',
    dur: '30 min',
    subject: 'Rep. Courtney staff — industrial base and USV line',
    short: 'Courtney staff — industrial base',
    place: 'Rayburn 2449',
    kind: 'hill',
    member: 'Rep. Joe Courtney (D-CT-02)',
    party: 'Democrat · Connecticut 2nd',
    room: 'Rayburn 2449',
    cmte: 'Armed Services · Seapower and Projection Forces (Ranking Member) · Education and Workforce',
    att: [
      {
        name: 'Brett Kalmar',
        detail:
          'Directory places him in Rep. Golden’s office. The invite is from a Courtney address — a recent office change is the likely cause.',
        state: 'stale',
      },
    ],
    focus:
      'Keep the Ranking Member’s staff aligned with the majority so the line survives conference. Courtney’s district interest is the submarine industrial base, not surface autonomy, so the angle is workforce and supplier capacity rather than platform count. Two Connecticut vendors are in Kela’s supply chain; bring the map.',
    background:
      'Courtney is Ranking Member on Seapower and Projection Forces and represents Connecticut’s Second District, home to Electric Boat. He has been a consistent vote for industrial-base funding and is sceptical of programs that pull skilled labour away from submarine construction. Kela has not met this office before.',
  },
  {
    id: 'm6',
    day: 2,
    time: '4:00 PM',
    dur: '30 min',
    subject: 'Sen. Duckworth staff — posture hearing question and test range',
    short: 'Duckworth staff — posture question',
    place: 'Hart 524',
    kind: 'hill',
    member: 'Sen. Tammy Duckworth (D-IL)',
    party: 'Democrat · Illinois',
    room: 'Hart 524',
    cmte: 'Armed Services · Commerce, Science and Transportation · Environment and Public Works',
    att: [
      {
        name: 'Priya Raghunathan',
        detail: 'Military Legislative Assistant · priya_raghunathan@duckworth.senate.gov',
        state: 'resolved',
      },
      {
        name: 'Sam Ely',
        detail: 'Legislative Correspondent · sam_ely@duckworth.senate.gov',
        state: 'resolved',
      },
    ],
    focus:
      'Ask for a question at the SASC posture hearing on the Navy’s certification timeline, and offer the Great Lakes test range as the Illinois-facing follow-on. Duckworth is the only member on this schedule who sits on both Armed Services and Commerce, which makes her the cheapest path to pressure on both halves of the ask.',
    background:
      'Duckworth serves on Armed Services and Commerce and has a long record on aviation and vehicle safety certification — the closest existing analogue to the pathway Kela is asking for. The office hosted a Great Lakes test range visit in June 2026. Raghunathan holds the portfolio and asked for the safety-case summary.',
  },
  {
    id: 'x2',
    day: 3,
    time: '10:30 AM',
    dur: '30 min',
    subject: 'Sen. Kelly staff — follow-up (virtual)',
    short: 'Kelly staff — follow-up',
    place: 'Video call',
    kind: 'hill',
    member: 'Sen. Mark Kelly (D-AZ)',
    party: 'Democrat · Arizona',
    room: 'Video call',
    cmte: 'Armed Services · Environment and Public Works',
    att: [
      {
        name: 'Ruth Ellery',
        detail: 'Military Legislative Assistant · ruth_ellery@kelly.senate.gov',
        state: 'resolved',
      },
    ],
    focus: 'Follow-up from the Hill Day, held the next morning.',
    background: 'Not part of the September 16 schedule unless selected.',
  },
];

export const DIRECTORY: Record<string, MeetingDirectory> = {
  m1: {
    issues: ['Shipbuilding', 'Unmanned surface vessels', 'Gulf Coast industrial base', 'Fleet size'],
    bio:
      'Chairs Armed Services and has pressed the Navy in three hearings this Congress on the gap between unmanned prototyping and fielded programs. His shipbuilding framework counts uncrewed vessels toward the fleet target.',
    staff: {
      'Cal Perrine': {
        role: 'Professional Staff Member, Senate Armed Services',
        topics: ['Seapower', 'Shipbuilding', 'Procurement'],
      },
      'Hannah Voight': {
        role: 'Legislative Aide, Office of Sen. Wicker',
        topics: ['Scheduling', 'Constituent industry'],
      },
    },
  },
  m2: {
    issues: ['Seapower authorisation', 'Supplier base capacity', 'Single-source dependence'],
    bio:
      'Chairs Seapower and Projection Forces. Represents the Newport News supplier base, has backed capacity expansion at second-tier yards and questioned single-source dependence across the unmanned portfolio.',
    staff: {
      'Delaney Rusk': {
        role: 'Legislative Director',
        topics: ['Defense authorisation', 'Markup language', 'Virginia suppliers'],
      },
    },
  },
  m3: {
    issues: ['Defense appropriations', 'Maine maritime base', 'Intelligence oversight'],
    bio:
      'Chairs Appropriations and sits on the Defense subcommittee. Maine’s maritime industrial base is a standing priority for the office. No prior engagement on record.',
    staff: {},
  },
  m4: {
    issues: ['Commercial vessel certification', 'Coast Guard authorisation', 'Texas industry'],
    bio:
      'Chairs Commerce, Science and Transportation, which holds jurisdiction over Coast Guard authorisation and commercial vessel certification. Texas hosts the Corpus Christi integration facility.',
    staff: {
      'Madison Sparber': {
        role: 'Legislative Assistant',
        topics: ['Commerce jurisdiction', 'Certification', 'Texas facilities'],
      },
    },
  },
  m5: {
    issues: ['Submarine industrial base', 'Shipyard workforce', 'Connecticut suppliers'],
    bio:
      'Ranking Member on Seapower and Projection Forces. A consistent vote for industrial-base funding and sceptical of programs that pull skilled labour away from submarine construction.',
    staff: {
      'Brett Kalmar': { role: 'Legislative Director', topics: ['Industrial base', 'Workforce'] },
    },
  },
  m6: {
    issues: ['Safety certification', 'Aviation and vehicle autonomy', 'Great Lakes test range'],
    bio:
      'Serves on Armed Services and Commerce with a long record on aviation and vehicle safety certification, the closest existing analogue to the pathway being asked for.',
    staff: {
      'Priya Raghunathan': {
        role: 'Military Legislative Assistant',
        topics: ['Certification timeline', 'Posture hearings'],
      },
      'Sam Ely': { role: 'Legislative Correspondent', topics: ['Constituent mail', 'Scheduling'] },
    },
  },
};

export const THREADS: Record<string, ThreadRef[]> = {
  m1: [
    {
      id: 't1',
      subject: 'FY27 USV line — materials for SASC staff',
      meta: 'Cal Perrine · 6 messages',
      age: '43 days',
    },
    {
      id: 't2',
      subject: 'Kela Systems capability one-pager',
      meta: 'Hannah Voight · 3 messages',
      age: '57 days',
    },
    {
      id: 't3',
      subject: 'Gulf Coast production plan — June readout',
      meta: 'Cal Perrine · 9 messages',
      age: '88 days',
    },
  ],
  m2: [
    {
      id: 't4',
      subject: 'Seapower markup timing',
      meta: 'Delaney Rusk · 4 messages',
      age: '19 days',
    },
  ],
  m3: [],
  m4: [
    {
      id: 't5',
      subject: 'Autonomy certification — Commerce jurisdiction question',
      meta: 'Madison Sparber · 7 messages',
      age: '28 days',
    },
  ],
  m5: [],
  m6: [
    {
      id: 't6',
      subject: 'Great Lakes test range visit',
      meta: 'Priya Raghunathan · 5 messages',
      age: '78 days',
    },
  ],
};

export const DOW_COLUMNS = [
  ['MON', '14'],
  ['TUE', '15'],
  ['WED', '16'],
  ['THU', '17'],
  ['FRI', '18'],
] as const;

export const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const;

/** Hill Day date line on the paper cover. */
export const HILL_DAY_DATELINE =
  'Wednesday, September 16, 2026 · six congressional meetings · FY27 unmanned surface vessel line and the autonomy certification pathway.';
