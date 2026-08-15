/* Auto-extracted prototype fixtures (PORTFOLIO-UI-BUILD-SPEC §14).

 * These are the design's literal fixtures. Sections with no backend render

 * from these and are flagged UI-only in the ship report; sections with a

 * real endpoint bind to it and ignore the fixture. */

export const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'HomeLine' },
  { id: 'portfolio', label: 'Portfolio', icon: 'Briefcase01', children: [
    { id: 'clients', label: 'Clients' },
    { id: 'programs', label: 'Program elements' },
    { id: 'coalitions', label: 'Coalitions' }
  ] },
  { id: 'engagement', label: 'Engagement Manager', icon: 'Mail01' },
  { id: 'workspace', label: 'Workspace', icon: 'Grid01' },
  { id: 'strategies', label: 'Strategies', icon: 'Target04' },
  { id: 'directory', label: 'Directory', icon: 'Users01', caret: true },
  { id: 'intelligence', label: 'Intelligence', icon: 'Stars02', caret: true }
];

export const CAP_AREAS = [
  {
    name: 'Autonomous ground maneuver', maturity: 'Fielded', ui: 'success', tier: 'Public record',
    source: 'Award data', pe: 'PE 0605053A', matches: '6 opportunities · 3 bills',
    body: 'Off-road autonomy stack for tactical wheeled and tracked platforms, operating without GPS or continuous comms.',
    tags: ['Ground robotics', 'GPS-denied navigation', 'Army']
  },
  {
    name: 'Perception in degraded conditions', maturity: 'Prototype', ui: 'blue', tier: 'Client-verified',
    source: 'Client materials', pe: 'PE 4868W12002', matches: '4 opportunities · 2 bills',
    body: 'Multi-sensor perception for dust, smoke, and night operations, validated at the Austin test site.',
    tags: ['Sensor fusion', 'Test and evaluation']
  },
  {
    name: 'Mission autonomy software', maturity: 'Fielded', ui: 'success', tier: 'Client-verified',
    source: 'Client materials', pe: 'PE 0605053A', matches: '5 opportunities · 4 bills',
    body: 'Mission planning and multi-vehicle coordination software delivered as a government-owned interface.',
    tags: ['Modular open systems', 'Software acquisition']
  },
  {
    name: 'Autonomous logistics and sustainment', maturity: 'Research', ui: 'warning', tier: 'Inferred',
    source: 'Inferred from awards', pe: 'Not yet mapped', matches: '2 opportunities · 1 bill',
    body: 'Unmanned resupply and casualty evacuation concepts, currently limited to funded research work.',
    tags: ['Contested logistics', 'ONR']
  }
];

export const CAP_CODES = [
  { label: 'UEI', value: 'ZQ4M8TR2LKD7' },
  { label: 'CAGE', value: '8H4T9' },
  { label: 'Primary NAICS', value: '336992 · Military Armored Vehicle and Tank Manufacturing' },
  { label: 'Secondary NAICS', value: '541715 · R&D in Physical, Engineering and Life Sciences' },
  { label: 'PSC codes', value: '2350, A013, D302' },
  { label: 'Set-asides', value: 'Small business · SBIR Phase III eligible' },
  { label: 'Contract vehicles', value: 'SBIR Phase III · Army OTA · GSA MAS' },
  { label: 'Facility clearance', value: 'Secret · CMMC Level 2 assessed' }
];

export const CAP_FIT = [
  { target: 'H.R. 9201 · Defense Autonomy Test Range Act', why: 'Autonomous ground maneuver plus the Austin test site', fit: 96 },
  { target: 'PE 0605053A · Ground Robotics', why: 'Fielded capability already funded in this line', fit: 94 },
  { target: 'Autonomous Ground Vehicle Integration · Army', why: 'Maneuver and mission autonomy match the statement of work', fit: 92 },
  { target: 'Trusted Autonomy Research Partnership · ONR', why: 'Degraded-condition perception and prior ONR award', fit: 88 }
];

export const CAP_PERF = [
  { title: 'ULTRA autonomy integration', agency: 'Army DEVCOM GVSC', value: '$28.4M', period: '2023 – 2026', role: 'Prime', status: 'Active', ui: 'success' },
  { title: 'Trusted autonomy research', agency: 'Office of Naval Research', value: '$4.2M', period: '2024 – 2026', role: 'Prime', status: 'Active', ui: 'success' },
  { title: 'Robotic combat vehicle experimentation', agency: 'Army Futures Command', value: '$11.8M', period: '2022 – 2025', role: 'Sub', status: 'Complete', ui: 'gray' },
  { title: 'GPS-denied navigation study', agency: 'DARPA TTO', value: '$6.5M', period: '2021 – 2024', role: 'Prime', status: 'Complete', ui: 'gray' },
  { title: 'Autonomy test range support', agency: 'DEVCOM Ground Vehicle Systems', value: '$3.1M', period: '2026 – 2028', role: 'Prime', status: 'Awarded', ui: 'brand' }
];

export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'relationships', label: 'Relationships' },
  { id: 'work', label: 'Work' },
  { id: 'intelligence', label: 'Intelligence' },
  { id: 'files', label: 'Files' }
];

export const PILL = {
  gray: ['#F9FAFB', '#EAECF0', '#344054', '#667085'],
  brand: ['#F2F4F7', '#D0D5DD', '#101828', '#101828'],
  error: ['#FEF3F2', '#FECDCA', '#B42318', '#F04438'],
  warning: ['#FFFAEB', '#FEDF89', '#B54708', '#F79009'],
  success: ['#ECFDF3', '#ABEFC6', '#027A48', '#12B76A'],
  blue: ['#F2F4F7', '#D0D5DD', '#101828', '#344054']
};

export const CLIENTS = [
  { id: 'overland', name: 'Overland AI', init: 'OA', sector: 'Defense technology', loc: 'Seattle, WA', status: 'Active', stone: 'success', focus: ['FY27 Ground Robotics', 'Army Procurement', 'Autonomy'], owner: 'Sarah Martinez', ownerInit: 'SM', strategies: 3, readiness: 68, bills: 12, matches: 7, attention: 8, next: 'Aug 14', dark: true },
  { id: 'boresight', name: 'Boresight', init: 'BS', sector: 'Sensors & optics', loc: 'Huntsville, AL', status: 'Active', stone: 'success', focus: ['FY27 Sensors', 'Missile Defense'], owner: 'Jordan Clayton', ownerInit: 'JC', strategies: 2, readiness: 74, bills: 9, matches: 4, attention: 5, next: 'Aug 15' },
  { id: 'aperture', name: 'Aperture Defense', init: 'AD', sector: 'Space systems', loc: 'Colorado Springs, CO', status: 'Active', stone: 'success', focus: ['Space Force Budget', 'Launch Access'], owner: 'Sarah Martinez', ownerInit: 'SM', strategies: 4, readiness: 61, bills: 14, matches: 9, attention: 4, next: 'Aug 18' },
  { id: 'ridgeline', name: 'Ridgeline Systems', init: 'RS', sector: 'Secure comms', loc: 'Reston, VA', status: 'Active', stone: 'success', focus: ['Zero Trust', 'DISA Contracts'], owner: 'Amara Reid', ownerInit: 'AR', strategies: 3, readiness: 82, bills: 7, matches: 5, attention: 2, next: 'Aug 19' },
  { id: 'halcyon', name: 'Halcyon Grid', init: 'HG', sector: 'Energy resilience', loc: 'Austin, TX', status: 'At risk', stone: 'warning', focus: ['Grid Security', 'DOE Loan Programs'], owner: 'Jordan Clayton', ownerInit: 'JC', strategies: 2, readiness: 34, bills: 11, matches: 6, attention: 6, next: 'Aug 12' },
  { id: 'northwind', name: 'Northwind Logistics', init: 'NL', sector: 'Defense logistics', loc: 'Norfolk, VA', status: 'Active', stone: 'success', focus: ['Sealift Recapitalization'], owner: 'Amara Reid', ownerInit: 'AR', strategies: 2, readiness: 57, bills: 6, matches: 3, attention: 1, next: 'Aug 21' },
  { id: 'cascade', name: 'Cascade Biosciences', init: 'CB', sector: 'Biotechnology', loc: 'Portland, OR', status: 'At risk', stone: 'warning', focus: ['BARDA Funding', 'FDA Pathway'], owner: 'Sarah Martinez', ownerInit: 'SM', strategies: 1, readiness: 29, bills: 8, matches: 8, attention: 3, next: 'Aug 26' },
  { id: 'tidewater', name: 'Tidewater Marine', init: 'TM', sector: 'Shipbuilding', loc: 'Pascagoula, MS', status: 'Prospect', stone: 'gray', focus: ['Shipyard Workforce'], owner: 'Jordan Clayton', ownerInit: 'JC', strategies: 0, readiness: 12, bills: 4, matches: 2, attention: 0, next: 'Sep 03' }
];

export const CROSS = [
  { id: 'x1', client: 'overland', init: 'OA', title: 'FY27 Ground Robotics reduced by $22.7M', eyebrow: 'Overland AI · appropriations change · linked to active strategy', kind: 'Budget', ui: 'error', due: 'Today' },
  { id: 'x2', client: 'halcyon', init: 'HG', title: 'DOE loan guarantee terms revised before close', eyebrow: 'Halcyon Grid · program change · owner Jordan Clayton', kind: 'Funding', ui: 'error', due: 'Today' },
  { id: 'x3', client: 'overland', init: 'OA', title: 'HASC autonomous-systems hearing scheduled', eyebrow: 'Overland AI · relevant to autonomy and ground robotics', kind: 'Hearing', ui: 'blue', due: 'Aug 13' },
  { id: 'x4', client: 'cascade', init: 'CB', title: 'BARDA solicitation closes in 9 days', eyebrow: 'Cascade Biosciences · pursuit not yet assigned', kind: 'Deadline', ui: 'warning', due: 'Aug 20' },
  { id: 'x5', client: 'aperture', init: 'AD', title: 'Launch services mark restored in Senate report', eyebrow: 'Aperture Defense · favorable change · confirm posture', kind: 'Budget', ui: 'success', due: 'Aug 22' }
];

export const PORTFOLIO_PES = [
  { code: '0605053A', name: 'Ground Robotics', pb: '$192.2M', auth: '$182.2M', approp: '$169.5M', delta: '−$22.7M', down: true, init: 'OA', client: 'Overland AI' },
  { code: '4868W12002', name: 'Robotics & Applique Systems', pb: '$84.3M', auth: '$84.3M', approp: '$64.0M', delta: '−$20.3M', down: true, init: 'OA', client: 'Overland AI' },
  { code: '1203164SF', name: 'Space Launch Services', pb: '$210.4M', auth: '$210.4M', approp: '$226.0M', delta: '+$15.6M', init: 'AD', client: 'Aperture Defense' },
  { code: '0603270A', name: 'Electronic Warfare Advanced Payloads', pb: '$58.6M', auth: '$61.0M', approp: '$61.0M', delta: '+$2.4M', init: 'BS', client: 'Boresight' },
  { code: '0303140G', name: 'Information Systems Security Program', pb: '$96.1M', auth: '$96.1M', approp: '$92.4M', delta: '−$3.7M', down: true, init: 'RS', client: 'Ridgeline Systems' },
  { code: '0604256A', name: 'Threat Simulator Development', pb: '$41.2M', auth: '$44.0M', approp: '$44.0M', delta: '+$2.8M', init: 'BS', client: 'Boresight' }
];

export const OV_ATTN = [
  { id: 'a1', title: 'FY27 Ground Robotics reduced by $22.7M', eyebrow: 'Appropriations change · linked to active strategy', kind: 'Budget', ui: 'error', due: 'Today' },
  { id: 'a2', title: 'HASC autonomous-systems hearing scheduled', eyebrow: 'Relevant to autonomy and ground robotics', kind: 'Hearing', ui: 'blue', due: 'Aug 13' },
  { id: 'a3', title: 'Committee outreach milestone is due', eyebrow: 'FY27 Ground Robotics strategy · owner Sarah Martinez', kind: 'Work', ui: 'warning', due: 'Aug 14' },
  { id: 'a4', title: 'EPA comment period closes in 11 days', eyebrow: 'Federal Register matter linked to client watchlist', kind: 'Regulatory', ui: 'warning', due: 'Aug 21' },
  { id: 'a5', title: 'Two LDA registrants have no Q3 filing yet', eyebrow: 'Federal footprint · disclosure compliance', kind: 'Compliance', ui: 'gray', due: 'Sep 20' },
  { id: 'a6', title: 'Arlington partner lab is missing an employee count', eyebrow: 'District Nexus coverage stays at 92% until resolved', kind: 'Data', ui: 'gray', due: 'Open' },
  { id: 'a7', title: 'Client requested an Army procurement assessment', eyebrow: 'Email thread with Stephanie Bonk · commitment open', kind: 'Client', ui: 'blue', due: 'Aug 12' },
  { id: 'a8', title: 'Conference restoration memo has no source pack', eyebrow: 'Deliverable due Sep 05 · owner Sarah Martinez', kind: 'Work', ui: 'warning', due: 'Sep 05' }
];

export const ORG = [
  [{ id: 'js', level: 'Executive', init: 'JS', name: 'James Smith', title: 'Chief Executive Officer', meta: 'Executive · Confirmed' }],
  [
    { id: 'sb', level: 'Leadership', init: 'SB', name: 'Stephanie Bonk', title: 'VP Government Affairs', meta: 'Executive leadership · Override' },
    { id: 'aj', level: 'Leadership', init: 'AJ', name: 'Alex Johnson', title: 'VP Operations', meta: 'Executive leadership · Auto-placed' }
  ],
  [
    { id: 'mc', level: 'Team', init: 'MC', name: 'Maya Chen', title: 'Director, Federal Affairs', meta: 'Leadership · Auto-placed' },
    { id: 'dr', level: 'Team', init: 'DR', name: 'Daniel Ruiz', title: 'Director, Policy & Regulatory', meta: 'Leadership · Auto-placed' },
    { id: 'ps', level: 'Team', init: 'PS', name: 'Priya Shah', title: 'Director, Strategic Partnerships', meta: 'Leadership · Auto-placed' }
  ],
  [
    { id: 'ct', level: 'Team', init: 'CT', name: 'Chris Taylor', title: 'Government Relations Manager', meta: 'Management · Auto-placed' },
    { id: 'open', level: 'Team', init: '—', name: 'Open role', title: 'Regulatory Counsel', meta: 'Unfilled · title needs review', ghost: true }
  ]
];

export const LEVELS = [
  ['Executive', 'CEO · President · Founder'],
  ['C-suite', 'COO · CFO · CTO · CGAO'],
  ['Senior leadership', 'EVP · SVP'],
  ['Leadership', 'VP · Director'],
  ['Management', 'Manager · Senior Manager'],
  ['Team', 'Associate · Analyst · Coordinator']
];

export const TARGETS = [
  {
    id: 't1', kind: 'person', init: 'JD', name: 'Rep. Jane Doe', role: 'WA-07 · House Armed Services',
    full: 'WA-07 · House of Representatives · HASC', confirm: 'Direct target · Confirmed',
    priority: 'High', disposition: 'Supportive', date: 'Aug 14',
    strategy: 'FY27 Ground Robotics Funding', ask: 'Schedule member meeting before HASC markup',
    next: 'HASC member outreach · Aug 14 · Sarah Martinez',
    why: [['Committee', 'House Armed Services jurisdiction'], ['District', 'Seattle headquarters in WA-07'], ['Capability', 'Ground robotics and autonomy match'], ['Strategy', 'Live member-subject Strategy node']]
  },
  {
    id: 't2', kind: 'org', init: 'SASC', name: 'Senate Armed Services', role: 'Committee · Authorization',
    full: 'Federal · Senate committee · Authorization', confirm: 'Jurisdiction match · Confirmed',
    priority: 'High', disposition: 'Neutral', date: 'Aug 20',
    strategy: 'FY27 NDAA Authorization', ask: 'Protect authorization level',
    next: 'Committee engagement · Aug 20 · Jordan Clayton',
    why: [['Committee', 'Authorization jurisdiction over the program'], ['Bill', 'S. 2291 hearing scheduled'], ['Capability', 'Defense robotics acceleration'], ['Strategy', 'Authorization-stage Strategy node']]
  },
  {
    id: 't3', kind: 'org', init: 'G8', name: 'Army G-8', role: 'Army resourcing office',
    full: 'Army · HQDA G-8 · Programming', confirm: 'Agency target · Confirmed',
    priority: 'High', disposition: 'Supportive', date: 'Aug 25',
    strategy: 'Army Procurement Positioning', ask: 'Validate procurement pathway',
    next: 'Army G-8 meeting · Aug 25 · Sarah Martinez',
    why: [['Office', 'Owns Army programming and resourcing'], ['Program', 'PE 0605053A Ground Robotics'], ['Capability', 'ULTRA procurement fit'], ['Strategy', 'Procurement-stage Strategy node']]
  }
];

export const GOV_ROWS = [
  { name: 'Rep. Jane Doe', type: 'Member', jurisdiction: 'WA-07', office: 'HASC', target: 'Current', group: 'Congress', targetId: 't1' },
  { name: 'Senate Armed Services', type: 'Committee', jurisdiction: 'Federal', office: 'SASC', target: 'Current', group: 'Committees', targetId: 't2' },
  { name: 'Army G-8', type: 'Agency office', jurisdiction: 'Army', office: 'HQDA G-8', target: 'Current', group: 'Agencies', targetId: 't3' },
  { name: 'Rep. Marcus Lee', type: 'Member', jurisdiction: 'TX-31', office: 'Appropriations', target: 'Known', group: 'Congress' },
  { name: 'Office of the Under Secretary, R&E', type: 'Agency office', jurisdiction: 'DoD', office: 'OUSD(R&E)', target: 'Known', group: 'Agencies' },
  { name: 'Sen. Patricia Alvarez', type: 'Member', jurisdiction: 'WA', office: 'SASC', target: 'Known', group: 'Congress' },
  { name: 'House Appropriations · Defense', type: 'Committee', jurisdiction: 'Federal', office: 'HAC-D', target: 'Known', group: 'Committees' },
  { name: 'DEVCOM Ground Vehicle Systems', type: 'Agency office', jurisdiction: 'Army', office: 'GVSC', target: 'Known', group: 'Agencies' },
  { name: 'Rep. Daniel Kim', type: 'Member', jurisdiction: 'WA-08', office: 'Science & Technology', target: 'Known', group: 'Congress' },
  { name: 'DARPA Tactical Technology Office', type: 'Agency office', jurisdiction: 'DoD', office: 'DARPA TTO', target: 'Known', group: 'Agencies' },
  { name: 'Sen. Robert Hayes', type: 'Member', jurisdiction: 'AL', office: 'SAC-D', target: 'Known', group: 'Congress' },
  { name: 'House Science, Space & Technology', type: 'Committee', jurisdiction: 'Federal', office: 'SST', target: 'Known', group: 'Committees' },
  { name: 'Office of Naval Research', type: 'Agency office', jurisdiction: 'Navy', office: 'ONR Code 30', target: 'Known', group: 'Agencies' },
  { name: 'Rep. Alan Brooks', type: 'Member', jurisdiction: 'VA-08', office: 'Armed Services', target: 'Known', group: 'Congress' },
  { name: 'Rep. Maria Torres', type: 'Member', jurisdiction: 'TX-31', office: 'Armed Services', target: 'Known', group: 'Congress' },
  { name: 'Senate Appropriations · Defense', type: 'Committee', jurisdiction: 'Federal', office: 'SAC-D', target: 'Known', group: 'Committees' },
  { name: 'Army Futures Command', type: 'Agency office', jurisdiction: 'Army', office: 'AFC', target: 'Known', group: 'Agencies' },
  { name: 'House Oversight · Cybersecurity', type: 'Committee', jurisdiction: 'Federal', office: 'Oversight', target: 'Known', group: 'Committees' }
];

export const TIMELINE = [
  { date: 'Aug 10', mark: 'N', kind: 'Client note', group: 'Notes', title: 'Priority shifted toward Army procurement', body: 'Stephanie wants the next meeting focused on procurement rather than RDT&E.', meta: 'Added by Sarah Martinez · Internal note', action: 'Pinned' },
  { date: 'Aug 08', mark: 'E', kind: 'Email thread', group: 'Email', title: 'RE: FY27 Ground Robotics Mark', body: '2 emails exchanged with Stephanie Bonk. Client requested an assessment before Tuesday.', meta: 'Gmail sync · Meri summary available', action: 'Open thread' },
  { date: 'Aug 06', mark: 'D', kind: 'Deliverable', group: 'Documents', title: 'FY27 Congressional Strategy Memo', body: 'Client-facing strategy memo delivered to Stephanie Bonk and James Smith.', meta: 'Workspace · Sent by Jordan Clayton', action: 'Open file' },
  { date: 'Aug 03', mark: 'M', kind: 'Client meeting', group: 'Meetings', title: 'Overland AI Strategy Review', body: '42 minutes · 4 attendees · 3 decisions · 2 commitments recorded.', meta: 'Meeting notes and debrief available', action: 'Open meeting' },
  { date: 'Jul 29', mark: 'O', kind: 'Outreach', group: 'Outreach', title: 'HASC staff introduction campaign', body: 'Four draft messages prepared for committee staff targets. Two approved.', meta: 'Outreach V3 · Strategy-linked', action: 'Open outreach' },
  { date: 'Jul 24', mark: 'C', kind: 'Client call', group: 'Calls', title: 'Quarterly check-in with James Smith', body: '18 minutes. Confirmed FY27 posture and the conference-stage advocacy plan.', meta: 'Logged by Sarah Martinez', action: 'Open log' }
];

export const NODES = [
  { mark: 'A', kind: 'Action', title: 'HASC member outreach', init: 'SM', owner: 'Sarah Martinez', date: 'Aug 14', status: 'In progress', ui: 'blue' },
  { mark: 'M', kind: 'Milestone', title: 'Committee engagement', init: 'JC', owner: 'Jordan Clayton', date: 'Aug 20', status: 'Active', ui: 'success' },
  { mark: 'D', kind: 'Deliverable', title: 'Client conference strategy brief', init: 'SM', owner: 'Sarah Martinez', date: 'Sep 05', status: 'Draft', ui: 'gray' }
];

export const UPCOMING = [
  { date: 'Aug 14', title: 'HASC member outreach', strategy: 'FY27 Ground Robotics', init: 'SM', ui: 'blue' },
  { date: 'Aug 20', title: 'Committee engagement', strategy: 'FY27 Ground Robotics', init: 'JC', ui: 'success' },
  { date: 'Aug 25', title: 'Army G-8 meeting', strategy: 'Army Procurement', init: 'SM', ui: 'blue' },
  { date: 'Sep 05', title: 'Client conference brief', strategy: 'FY27 Ground Robotics', init: 'SM', ui: 'gray' },
  { date: 'Sep 10', title: 'Autonomy comment draft', strategy: 'Regulatory Readiness', init: 'SM', ui: 'gray' }
];

export const INTEL_TABS = [
  ['overview', 'Overview'], ['legislative', 'Legislative'], ['regulatory', 'Regulatory'],
  ['funding', 'Funding & Budget'], ['footprint', 'Federal Footprint'], ['district', 'District Nexus']
];

export const INTEL_META = {
  overview: { title: 'Client intelligence', sub: 'External signals organized around this client, not a wall of raw database counters.', primary: 'Sync intelligence' },
  legislative: { title: 'Legislative', sub: 'Tracked bills, client-fit recommendations, hearings, and material changes from LegiWatch.', primary: 'Track bill', secondary: 'Configure', solid: true },
  regulatory: { title: 'Regulatory', sub: 'Federal Register matters shown as decision-oriented lifecycle rails with client deadlines.', primary: 'Track matter', solid: true },
  funding: { title: 'Funding & Budget', sub: 'Grant and contract opportunities, active pursuits, and relevant defense budget programs in one domain.', primary: 'Sync sources' },
  footprint: { title: 'Federal footprint', sub: 'Lobbying activity, federal awards, political giving, and the government entities connected to the client.', primary: 'Export profile' },
  district: { title: 'District Nexus', sub: 'Facilities, employees, contracts, grants, and representatives translated into a defensible congressional footprint.', primary: 'Manage facilities' }
};

export const DOMAIN_STATS = {
  legislative: [['12', 'Tracked bills'], ['3', 'Material changes'], ['2', 'Upcoming hearings'], ['4', 'High-fit recommendations'], ['91%', 'Watchlist coverage']],
  regulatory: [['3', 'Active matters'], ['1', 'Deadline < 14 days'], ['2', 'Linked bills'], ['4', 'Agencies'], ['11', 'Days to next deadline']],
  funding: [['7', 'Active opportunities'], ['2', 'Pursuing'], ['$62M', 'Largest ceiling'], ['3', 'Relevant programs'], ['Aug 30', 'Next deadline']],
  footprint: [['8', 'LDA filings'], ['$1.8M', 'Lobbying · TTM'], ['$84.2M', 'Federal awards · TTM'], ['$380K', 'PAC disbursements'], ['4', 'Registrants']],
  district: [['8', 'Districts'], ['$84.2M', 'Contract obligations'], ['$11.6M', 'Grant obligations'], ['430', 'Employees mapped'], ['92%', 'Coverage']]
};

export const INTEL_ATTN = [
  { title: 'Ground Robotics mark reduced by $22.7M', body: 'HAC-D position now sits below the FY27 request and the active client strategy target.', kind: 'Funding', ui: 'error', due: 'Today', go: 'funding' },
  { title: 'HASC hearing scheduled for autonomous systems', body: 'Upcoming hearing maps to autonomy capability, active strategy, and current targets.', kind: 'Hearing', ui: 'blue', due: 'Aug 13', go: 'legislative' },
  { title: 'H.R. 8124 advanced to committee', body: 'Client-fit 94% · new committee action · linked to three watchlist topics.', kind: 'Legislative', ui: 'blue', due: 'Today', go: 'legislative' },
  { title: 'Federal Register comment period closes soon', body: 'Autonomous Vehicle Safety Framework · 11 days remaining.', kind: 'Regulatory', ui: 'warning', due: 'Aug 21', go: 'regulatory' },
  { title: 'WA-07 nexus strengthened by new award', body: '$8.4M contract obligation mapped to the Seattle facility.', kind: 'District', ui: 'success', due: 'Aug 09', go: 'district' }
];

export const DOMAINS = [
  { id: 'legislative', label: 'Legislative', sub: '3 high-fit bills · 1 upcoming hearing', value: '12', unit: 'Tracked' },
  { id: 'regulatory', label: 'Regulatory', sub: '1 deadline inside 14 days', value: '3', unit: 'Matters' },
  { id: 'funding', label: 'Funding & Budget', sub: '2 pursuits · 3 Program Elements', value: '7', unit: 'Matches' },
  { id: 'footprint', label: 'Federal Footprint', sub: '8 LDA filings · active PAC mapping', value: '$84M', unit: 'Awards' },
  { id: 'district', label: 'District Nexus', sub: 'WA-07 and WA-08 are strongest', value: '8', unit: 'Districts' }
];

export const STAGES = [
  { id: 'introduced', label: 'Introduced', count: 3 },
  { id: 'committee', label: 'Committee', count: 5 },
  { id: 'passed', label: 'Passed', count: 2 },
  { id: 'enacted', label: 'Enacted', count: 2 }
];

export const BILLS = [
  { number: 'H.R. 8124', title: 'Autonomous Systems Readiness Act', latest: 'Latest: Referred to HASC', fit: 94, stage: 'introduced' },
  { number: 'S. 1840', title: 'Trusted Autonomy Supply Chain', latest: 'Latest: Introduced Aug 6', fit: 87, stage: 'introduced' },
  { number: 'H.R. 8800', title: 'FY27 National Defense Authorization', latest: 'HASC · mark reported', fit: 98, stage: 'committee' },
  { number: 'S. 2291', title: 'Defense Robotics Acceleration', latest: 'SASC · hearing scheduled', fit: 91, stage: 'committee' },
  { number: 'H.R. 6712', title: 'Critical Technology Workforce Act', latest: 'Passed House · 302–121', fit: 76, stage: 'passed' },
  { number: 'P.L. 119-22', title: 'Defense Innovation Authorization', latest: 'Enacted · July 28', fit: 72, stage: 'enacted' }
];

export const RECS = [
  { number: 'H.R. 9201', title: 'Defense Autonomy Test Range Act', why: 'Capability + district + HASC match', fit: '96%' },
  { number: 'S. 3108', title: 'Robotics Acquisition Reform Act', why: 'Procurement + Army G-8 match', fit: '92%' },
  { number: 'H.R. 7810', title: 'Trusted Systems Workforce Act', why: 'Workforce + WA facility match', fit: '84%' }
];

export const MATTERS = [
  { title: 'Autonomous Vehicle Safety Framework', agency: 'DOT · NHTSA', docket: 'FR 2026-18422', stage: 'Comment period', ui: 'warning', detail: 'Comments close Aug 21 · 11 days', linked: 'H.R. 8124 · S. 1840', steps: [['Proposed', 'done'], ['Comment', 'now'], ['Final', 'pending'], ['Effective', 'pending']] },
  { title: 'AI Assurance for Defense Systems', agency: 'Department of Defense', docket: 'DOD-2026-OS-0041', stage: 'Proposed rule', ui: 'blue', detail: 'Public hearing Sep 4', linked: 'H.R. 8800', steps: [['Proposed', 'done'], ['Comment', 'now'], ['Final', 'pending'], ['Effective', 'pending']] },
  { title: 'Cybersecurity Standards for UAS Suppliers', agency: 'CISA · DHS', docket: 'FR 2026-17110', stage: 'Final rule', ui: 'brand', detail: 'Effective Oct 1', linked: 'S. 2291', steps: [['Proposed', 'done'], ['Comment', 'done'], ['Final', 'now'], ['Effective', 'pending']] }
];

export const DEADLINES = [
  { date: 'Aug 21', title: 'Autonomous Vehicle Safety Framework', ask: 'Submit or approve comment strategy', urgent: true },
  { date: 'Sep 04', title: 'AI Assurance for Defense Systems', ask: 'Prepare public-hearing brief' },
  { date: 'Oct 01', title: 'Cybersecurity Standards for UAS', ask: 'Final rule becomes effective' }
];

export const OPPS = [
  { type: 'Contract', title: 'Autonomous Ground Vehicle Integration', agency: 'Army Contracting Command', amount: '$48M', due: 'Sep 14', fit: 97, status: 'Pursuing' },
  { type: 'Grant', title: 'Trusted Autonomy Research Partnership', agency: 'Office of Naval Research', amount: '$12M', due: 'Aug 30', fit: 93, status: 'Saved', soon: true },
  { type: 'Contract', title: 'Robotics Test Range Support', agency: 'DEVCOM Ground Vehicle Systems', amount: '$62M', due: 'Oct 02', fit: 89, status: 'Match' },
  { type: 'Grant', title: 'Resilient Navigation Demonstration', agency: 'DARPA', amount: '$8.5M', due: 'Oct 18', fit: 86, status: 'Match' }
];

export const PROGRAMS = [
  { code: '0605053A', name: 'Ground Robotics', pb: '$192.2M', auth: '$182.2M', approp: '$169.5M', delta: '−$22.7M', down: true },
  { code: '4868W12002', name: 'Robotics & Applique Systems', pb: '$84.3M', auth: '$84.3M', approp: '$64.0M', delta: '−$20.3M', down: true },
  { code: '0603270A', name: 'Electronic Warfare Advanced Payloads', pb: '$58.6M', auth: '$61.0M', approp: '$61.0M', delta: '+$2.4M' }
];

export const FOOT_STATS = [
  { value: '$1.8M', label: 'Lobbying · TTM', note: '8 LD-2 filings · 3 active registrants', delta: '▲ 18% YoY', up: true },
  { value: '$84.2M', label: 'Federal awards · TTM', note: '14 awards · Army leads at $51.4M' },
  { value: '$380K', label: 'PAC disbursements', note: 'Current cycle · incumbent members lead' },
  { value: '4', label: 'Registrants', note: '3 active · 1 terminated Q4 2024' }
];

export const REGISTRANTS = [
  { name: 'Capitol Strategies Group' },
  { name: 'Federal Policy Partners' },
  { name: 'Northwest Government Affairs' },
  { name: 'Beacon Hill Advocates', ended: 'Q4 2024' }
];

export const EV = {
  lda: { tier: 'Public record', name: 'Publicly disclosed lobbying', source: 'LD-1 / LD-2 filings' },
  cpf: { tier: 'Public record', name: 'Public congressional request', source: 'CPF / earmark / Member disclosure' },
  amend: { tier: 'Public record', name: 'Public amendment', source: 'Rules Committee / HASC / SASC record' },
  client: { tier: 'Client-verified', name: 'Verified client submission', source: 'White paper, request letter or email held in Capiro' },
  infer: { tier: 'Inferred', name: 'Inferred match', source: 'Likely relationship · nothing on file proves it' }
};

export const TIER = {
  'Public record': ['#F2F4F7', '#D0D5DD', '#101828', '#101828'],
  'Client-verified': ['#ECFDF3', '#ABEFC6', '#027A48', '#12B76A'],
  'Inferred': ['#FFFAEB', '#FEDF89', '#B54708', '#F79009']
};

export const ADVOCACY = [
  {
    id: 'v1', fy: 'FY27', vehicle: 'NDAA', activity: 'Lobbied', ask: 'Ground robotics / autonomy provisions',
    outcome: 'Pending', oui: 'gray', ev: 'lda', evLabel: 'LD-2',
    meta: 'Q2 2026 · Capitol Strategies Group · House, Senate, DoD',
    note: 'The LD-2 proves the client lobbied on the FY27 NDAA and names the issue. No client submission is on file, so Capiro does not claim a specific request was made.'
  },
  {
    id: 'v2', fy: 'FY27', vehicle: 'NDAA', activity: 'Amendment submitted', ask: 'Autonomous logistics pilot',
    outcome: 'Made in Order', oui: 'brand', ev: 'amend', evLabel: 'Rules Committee',
    meta: 'Sponsor Rep. Daniel Kim · House Rules, HASC',
    note: 'Sponsor and disposition come from the Rules Committee record. The request text comes from the white paper the client submitted, held in Capiro.'
  },
  {
    id: 'v3', fy: 'FY26', vehicle: 'NDAA', activity: 'Community funding request', ask: '$8M test facility',
    outcome: 'Included', oui: 'success', ev: 'cpf', evLabel: 'HASC disclosure',
    meta: 'Submitting Member, recipient and purpose published by HASC',
    note: 'HASC published the submitting Member, the intended recipient and location, the purpose, and the associated Member disclosures. This is the strongest public proof of a specific dollar request.'
  },
  {
    id: 'v4', fy: 'FY26', vehicle: 'Defense Appropriations', activity: 'Lobbied', ask: 'Ground Robotics RDT&E funding',
    outcome: 'Enacted +$12M', oui: 'success', ev: 'lda', evLabel: 'LD-2 + budget docs',
    meta: 'Q3 2025 · Federal Policy Partners · DoD, Army, HASC',
    note: 'The LD-2 names the appropriations act and the funding area. Budget documents show the program line and the enacted increase, but do not attribute it to the client.'
  },
  {
    id: 'v5', fy: 'FY25', vehicle: 'NDAA', activity: 'Client submission', ask: 'Procurement authority',
    outcome: 'Not included', oui: 'error', ev: 'client', evLabel: 'Client document',
    meta: 'Submitted to HASC professional staff · March 2024',
    note: 'Capiro holds the submission and the covering email. No Member sponsor was identified and no amendment was filed, so the request never reached the public record.'
  },
  {
    id: 'v6', fy: 'FY26', vehicle: 'Defense Appropriations', activity: 'Inferred match', ask: 'Autonomy test range increase',
    outcome: 'Included +$5M', oui: 'warning', ev: 'infer', evLabel: 'Inferred',
    meta: 'Report language matched to a client priority',
    note: 'Capiro matched enacted report language to a client priority. Nothing on file proves the client asked for it, so this is not counted as a client request.'
  }
];

export const LIFE = {
  v1: [
    { label: 'Disclosed', date: 'Q2 2026', ev: 'LD-2', tier: 'Public record', st: 'done' },
    { label: 'Issue named', date: 'Q2 2026', ev: 'LD-2', tier: 'Public record', st: 'current' },
    { label: 'Request on file', date: '—', ev: 'Not on file', tier: 'Inferred', st: 'gap' },
    { label: 'Sponsor', date: '—', ev: 'No record', st: 'pending' },
    { label: 'Amendment', date: '—', ev: 'No record', st: 'pending' },
    { label: 'Committee', date: 'Pending', ev: 'No evidence yet', st: 'pending' }
  ],
  v2: [
    { label: 'Requested', date: 'Feb 18', ev: 'Client document', tier: 'Client-verified', st: 'done' },
    { label: 'Submitted', date: 'Mar 6', ev: 'Client document', tier: 'Client-verified', st: 'done' },
    { label: 'Sponsor', date: 'Apr 2', ev: 'Public record', tier: 'Public record', st: 'done' },
    { label: 'Amendment', date: 'Jun 9', ev: 'Rules Committee', tier: 'Public record', st: 'done' },
    { label: 'Made in order', date: 'Jun 17', ev: 'Rules Committee', tier: 'Public record', st: 'done' },
    { label: 'House passed', date: 'Jul 12', ev: 'Roll call 284', tier: 'Public record', st: 'current' },
    { label: 'Conference', date: 'Pending', ev: 'No evidence yet', st: 'pending' },
    { label: 'Enacted', date: '—', ev: 'No evidence yet', st: 'pending' }
  ],
  v3: [
    { label: 'Requested', date: 'Mar 2025', ev: 'Client document', tier: 'Client-verified', st: 'done' },
    { label: 'Member request', date: 'Apr 2025', ev: 'HASC disclosure', tier: 'Public record', st: 'done' },
    { label: 'House mark', date: 'Jun 2025', ev: 'Committee report', tier: 'Public record', st: 'done' },
    { label: 'Conference', date: 'Nov 2025', ev: 'Conference report', tier: 'Public record', st: 'done' },
    { label: 'Enacted', date: 'Dec 2025', ev: 'Public law', tier: 'Public record', st: 'done' }
  ],
  v4: [
    { label: 'Submission', date: 'Apr 2025', ev: 'Client document', tier: 'Client-verified', st: 'done' },
    { label: 'Disclosed', date: 'Q3 2025', ev: 'LD-2', tier: 'Public record', st: 'done' },
    { label: 'Program line', date: 'Jun 2025', ev: 'Budget docs', tier: 'Public record', st: 'done' },
    { label: 'House mark', date: 'Jul 2025', ev: 'Committee report', tier: 'Public record', st: 'done' },
    { label: 'Enacted +$12M', date: 'Dec 2025', ev: 'Approps act', tier: 'Public record', st: 'done' }
  ],
  v5: [
    { label: 'Requested', date: 'Feb 2024', ev: 'Client document', tier: 'Client-verified', st: 'done' },
    { label: 'Submitted', date: 'Mar 2024', ev: 'Client email', tier: 'Client-verified', st: 'done' },
    { label: 'Sponsor', date: '—', ev: 'Not identified', tier: 'Inferred', st: 'gap' },
    { label: 'Amendment', date: '—', ev: 'No record', st: 'pending' },
    { label: 'Not included', date: 'Dec 2024', ev: 'Enacted text', tier: 'Public record', st: 'closed' }
  ],
  v6: [
    { label: 'Interest logged', date: 'Jan 2025', ev: 'Meeting note', tier: 'Client-verified', st: 'done' },
    { label: 'Request doc', date: '—', ev: 'Not on file', tier: 'Inferred', st: 'gap' },
    { label: 'Language match', date: 'Jul 2025', ev: 'Committee report', tier: 'Inferred', st: 'current' },
    { label: 'Included +$5M', date: 'Dec 2025', ev: 'Approps act', tier: 'Public record', st: 'closed' }
  ]
};

export const NODE = {
  done: { bg: 'linear-gradient(180deg,#39424F 0%,#1B2430 46%,#0E141C 100%)', ring: 'none', mark: '✓', markFg: '#ffffff', fg: '#101828' },
  current: { bg: '#ffffff', ring: 'inset 0 0 0 2px #101828', mark: '', markFg: '#101828', fg: '#101828' },
  gap: { bg: '#FFFAEB', ring: 'inset 0 0 0 1px #FEDF89', mark: '!', markFg: '#B54708', fg: '#B54708' },
  closed: { bg: '#F2F4F7', ring: 'inset 0 0 0 1px #D0D5DD', mark: '·', markFg: '#475467', fg: '#475467' },
  pending: { bg: '#F9FAFB', ring: 'inset 0 0 0 1px #EAECF0', mark: '', markFg: '#98A2B3', fg: '#667085' }
};

export const SPARK = [34, 41, 38, 47, 52, 49, 63, 74, 68];

export const LDA = [
  { period: '2026 Q2', type: 'LD-2', registrant: 'Capitol Strategies Group', amount: '$480K', issues: 'DEF · HOM · SCI', entities: 'DoD · Army · HASC' },
  { period: '2026 Q1', type: 'LD-2', registrant: 'Capitol Strategies Group', amount: '$420K', issues: 'DEF · SCI · BUD', entities: 'DoD · SASC · OMB' },
  { period: '2025 Q4', type: 'LD-2', registrant: 'Federal Policy Partners', amount: '$390K', issues: 'DEF · AVI · SCI', entities: 'Army · DARPA · HASC' },
  { period: '2025 Q3', type: 'LD-2', registrant: 'Federal Policy Partners', amount: '$310K', issues: 'DEF · BUD', entities: 'DoD · Army · Congress' },
  { period: '2025 Q2', type: 'LD-2', registrant: 'Northwest Government Affairs', amount: '$240K', issues: 'DEF · TEC', entities: 'DoD · WA Delegation' }
];

export const DISTRICTS = [
  {
    code: 'WA-07', label: 'Seattle headquarters', meta: '$38.6M · 248 employees', score: 94, strength: 'Strong', ui: 'success',
    lat: 47.61, lon: -122.33, la: 'l', lv: -4, rep: 'Rep. Jane Doe', chamber: 'House · HASC',
    tiles: [['Facility', 'Seattle HQ'], ['Employees', '248'], ['Contracts', '$38.6M'], ['Grants', '$4.2M'], ['Partners', '3']]
  },
  {
    code: 'WA-08', label: 'Manufacturing footprint', meta: '$24.1M · 112 employees', score: 86, strength: 'Strong', ui: 'success',
    lat: 47.15, lon: -120.60, la: 'r', lv: 8, rep: 'Rep. Daniel Kim', chamber: 'House · Science & Technology',
    tiles: [['Facility', 'Redmond Mfg'], ['Employees', '112'], ['Contracts', '$24.1M'], ['Grants', '$1.1M'], ['Partners', '2']]
  },
  {
    code: 'AL-05', label: 'Army aviation and missile partners', meta: '$9.4M · 26 employees', score: 71, strength: 'Moderate', ui: 'blue',
    lat: 34.73, lon: -86.58, la: 'r', rep: 'Rep. Karen Whitfield', chamber: 'House · HAC-D',
    tiles: [['Facility', 'Huntsville office'], ['Employees', '26'], ['Contracts', '$9.4M'], ['Grants', '—'], ['Partners', '4']]
  },
  {
    code: 'TX-31', label: 'Army program activity', meta: '$14.8M · 38 employees', score: 64, strength: 'Moderate', ui: 'blue',
    lat: 30.51, lon: -97.68, la: 'r', lv: 8, rep: 'Rep. Maria Torres', chamber: 'House · HASC',
    tiles: [['Facility', 'Austin test site'], ['Employees', '38'], ['Contracts', '$14.8M'], ['Grants', '$2.0M'], ['Partners', '1']]
  },
  {
    code: 'MI-10', label: 'Ground vehicle supply base', meta: '$6.8M · 18 employees', score: 58, strength: 'Moderate', ui: 'blue',
    lat: 42.60, lon: -82.95, la: 'r', lv: -6, rep: 'Rep. Thomas Reilly', chamber: 'House · HASC Tactical Air and Land',
    tiles: [['Facility', 'Supplier site'], ['Employees', '18'], ['Contracts', '$6.8M'], ['Grants', '—'], ['Partners', '5']]
  },
  {
    code: 'CA-45', label: 'Supplier and partner nexus', meta: '$7.2M · 20 employees', score: 48, strength: 'Developing', ui: 'gray',
    lat: 33.72, lon: -117.90, la: 'r', lv: 12, rep: 'Rep. Elaine Park', chamber: 'House · Appropriations',
    tiles: [['Facility', 'Partner plant'], ['Employees', '20'], ['Contracts', '$7.2M'], ['Grants', '—'], ['Partners', '2']]
  },
  {
    code: 'CO-05', label: 'Autonomy test and evaluation', meta: '$5.6M · 14 employees', score: 44, strength: 'Developing', ui: 'gray',
    lat: 38.83, lon: -104.82, la: 'l', rep: 'Rep. Victor Salas', chamber: 'House · Armed Services',
    tiles: [['Facility', 'Test detachment'], ['Employees', '14'], ['Contracts', '$5.6M'], ['Grants', '$0.9M'], ['Partners', '2']]
  },
  {
    code: 'VA-08', label: 'Federal partner activity', meta: '$5.1M · 12 employees', score: 37, strength: 'Developing', ui: 'gray',
    lat: 38.88, lon: -77.09, la: 'r', lv: -6, rep: 'Rep. Alan Brooks', chamber: 'House · Appropriations',
    tiles: [['Facility', 'Partner lab'], ['Employees', 'Needs count'], ['Contracts', '$5.1M'], ['Grants', '$3.4M'], ['Partners', '3']]
  }
];

export const FACILITIES = [
  { name: 'Seattle Headquarters', district: 'WA-07', employees: '248', rep: 'Rep. Jane Doe', status: 'Confirmed', ui: 'success' },
  { name: 'Redmond Manufacturing', district: 'WA-08', employees: '112', rep: 'Rep. Daniel Kim', status: 'Confirmed', ui: 'success' },
  { name: 'Austin Test Site', district: 'TX-31', employees: '38', rep: 'Rep. Maria Torres', status: 'Confirmed', ui: 'success' },
  { name: 'Partner Lab · Arlington', district: 'VA-08', employees: '—', rep: 'Rep. Alan Brooks', status: 'Needs count', ui: 'warning' }
];

export const FOLDERS = [
  { id: 'root', label: 'Overland AI', count: 28, subs: 7, depth: 0, kids: true, open: true, crumb: 'Overland AI' },
  { id: 'fy27', label: 'FY27 Strategy', count: 8, subs: 3, depth: 1, kids: true, open: true, crumb: 'Overland AI / FY27 Strategy' },
  { id: 'briefing', label: 'Briefing', count: 2, subs: 0, depth: 2, crumb: 'Overland AI / FY27 Strategy / Briefing' },
  { id: 'research', label: 'Research', count: 3, subs: 0, depth: 2, crumb: 'Overland AI / FY27 Strategy / Research' },
  { id: 'deliverables', label: 'Deliverables', count: 3, subs: 0, depth: 2, crumb: 'Overland AI / FY27 Strategy / Deliverables' },
  { id: 'meetings', label: 'Meetings', count: 6, subs: 0, depth: 1, kids: true, crumb: 'Overland AI / Meetings' },
  { id: 'materials', label: 'Client Materials', count: 5, subs: 0, depth: 1, kids: true, crumb: 'Overland AI / Client Materials' },
  { id: 'outreach', label: 'Outreach', count: 4, subs: 0, depth: 1, kids: true, crumb: 'Overland AI / Outreach' },
  { id: 'contracts', label: 'Contracts', count: 2, subs: 0, depth: 1, kids: true, crumb: 'Overland AI / Contracts' },
  { id: 'regulatory', label: 'Regulatory', count: 2, subs: 0, depth: 1, kids: true, crumb: 'Overland AI / Regulatory' },
  { id: 'archive', label: 'Archive', count: 1, subs: 0, depth: 1, kids: true, crumb: 'Overland AI / Archive' }
];

export const FILES = [
  { id: 'f1', folder: 'fy27', ext: 'DOCX', name: 'FY27 Congressional Strategy Memo', smart: true, linked: 'Strategy · FY27 Ground Robotics', modified: 'Aug 10', owner: 'Sarah', status: 'Approved', ui: 'success' },
  { id: 'f2', folder: 'fy27', ext: 'PDF', name: 'Ground Robotics Budget Analysis', linked: 'Research / Budget', modified: 'Aug 08', owner: 'Meri', status: 'Verified', ui: 'brand' },
  { id: 'f3', folder: 'fy27', ext: 'XLSX', name: 'Congressional Target List', smart: true, linked: 'Strategy · Current targets', modified: 'Aug 06', owner: 'Jordan', status: 'Current', ui: 'gray' },
  { id: 'f4', folder: 'fy27', ext: 'DOCX', name: 'HASC Member Meeting Brief', smart: true, linked: 'Meeting · Aug 14', modified: 'Aug 10', owner: 'Sarah', status: 'Draft', ui: 'warning' },
  { id: 'f5', folder: 'fy27', ext: 'PDF', name: 'Overland AI Capability Statement', linked: 'Client Materials', modified: 'Aug 03', owner: 'Client', status: 'Current', ui: 'gray' },
  { id: 'f6', folder: 'fy27', ext: 'MSG', name: 'HASC Staff Outreach Campaign', smart: true, linked: 'Outreach · Draft campaign', modified: 'Jul 29', owner: 'Jordan', status: '2 approved', ui: 'success' },
  { id: 'f7', folder: 'fy27', ext: 'PDF', name: 'Army Procurement Research Pack', linked: 'Research / Army', modified: 'Jul 26', owner: 'Meri', status: 'Verified', ui: 'brand' },
  { id: 'f8', folder: 'meetings', ext: 'DOCX', name: 'Aug 03 Strategy Review — notes', smart: true, linked: 'Meeting · Aug 03', modified: 'Aug 03', owner: 'Sarah', status: 'Current', ui: 'gray' },
  { id: 'f9', folder: 'materials', ext: 'PDF', name: 'Overland AI Company Overview', linked: 'Client Materials', modified: 'Jul 18', owner: 'Client', status: 'Current', ui: 'gray' },
  { id: 'f10', folder: 'research', ext: 'PDF', name: 'FY27 Mark Comparison', linked: 'Research / Budget', modified: 'Jul 22', owner: 'Meri', status: 'Verified', ui: 'brand' }
];

export const PEOPLE = {
  js: { init: 'JS', name: 'James Smith', title: 'Chief Executive Officer', level: 'Executive', meta: 'Executive · Confirmed', email: 'james.smith@overland.ai', phone: '(206) 555-0110', levelFull: 'Executive', reports: '—', note: 'Final decision-maker on federal posture. Prefers a one-page summary ahead of any live discussion.' },
  sb: { init: 'SB', name: 'Stephanie Bonk', title: 'VP Government Affairs', level: 'Leadership', meta: 'Executive leadership · Override', email: 'stephanie.bonk@overland.ai', phone: '(206) 555-0184', levelFull: 'Executive leadership', reports: 'James Smith · CEO', override: true, note: 'Leads federal strategy and coordinates closely with the CEO on defense-market priorities.' },
  aj: { init: 'AJ', name: 'Alex Johnson', title: 'VP Operations', level: 'Leadership', meta: 'Executive leadership · Auto-placed', email: 'alex.johnson@overland.ai', phone: '(206) 555-0121', levelFull: 'Executive leadership', reports: 'James Smith · CEO', note: 'Owns manufacturing and the Redmond facility. Useful for district and workforce evidence.' },
  mc: { init: 'MC', name: 'Maya Chen', title: 'Director, Federal Affairs', level: 'Team', meta: 'Leadership · Auto-placed', email: 'maya.chen@overland.ai', phone: '(206) 555-0143', levelFull: 'Leadership', reports: 'Stephanie Bonk · VP Government Affairs', note: 'Day-to-day contact for committee outreach and hearing preparation.' },
  dr: { init: 'DR', name: 'Daniel Ruiz', title: 'Director, Policy & Regulatory', level: 'Team', meta: 'Leadership · Auto-placed', email: 'daniel.ruiz@overland.ai', phone: '(206) 555-0158', levelFull: 'Leadership', reports: 'Stephanie Bonk · VP Government Affairs', note: 'Owns the autonomy rulemaking response and Federal Register comment drafting.' },
  ps: { init: 'PS', name: 'Priya Shah', title: 'Director, Strategic Partnerships', level: 'Team', meta: 'Leadership · Auto-placed', email: 'priya.shah@overland.ai', phone: '(206) 555-0166', levelFull: 'Leadership', reports: 'Alex Johnson · VP Operations', note: 'Partner and supplier relationships that support the CA-45 nexus.' },
  ct: { init: 'CT', name: 'Chris Taylor', title: 'Government Relations Manager', level: 'Team', meta: 'Management · Auto-placed', email: 'chris.taylor@overland.ai', phone: '(206) 555-0177', levelFull: 'Management', reports: 'Maya Chen · Director, Federal Affairs', note: 'Coordinates scheduling and the staff-level follow-up cadence.' }
};

export const SOURCES = [
  { label: 'Client profile', status: 'Complete', note: 'Core fields present', ui: 'success' },
  { label: 'LDA disclosures', status: 'Connected', note: '4 registrants', ui: 'success' },
  { label: 'Federal contracts', status: 'Connected', note: 'Refreshed 2h', ui: 'success' },
  { label: 'Federal assistance', status: 'Connected', note: 'Refreshed 2h', ui: 'success' },
  { label: 'FEC / PAC', status: 'Connected', note: 'Current cycle', ui: 'success' },
  { label: 'District resolution', status: 'Partial', note: '92% mapped', ui: 'warning' }
];
