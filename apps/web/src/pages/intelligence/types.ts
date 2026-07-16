/* ── LDA types ─────────────────────────────────────────────────────────── */

export interface LdaDashboard {
  totalFilings: number;
  totalClients: number;
  totalRegistrants: number;
  totalLobbyists: number;
  totalIssueCodes: number;
  topIssueCodes: {
    code: string;
    name: string;
    totalFilings5y: number;
    totalSpending5y: number | null;
  }[];
  topClients: { id: number; name: string; totalFilings: number; totalSpending: number | null }[];
  topRegistrants: { id: number; name: string; totalFilings: number; totalClients: number }[];
  recentFilings: {
    filingUuid: string;
    filingYear: number;
    clientName: string;
    registrantName: string;
    income: number | null;
    issueCodes: string[];
  }[];
}

export interface LdaTrend {
  year: number;
  period: string;
  totalIncome: number | null;
  totalExpenses: number | null;
  filingCount: number;
}

export interface LdaIssueCode {
  code: string;
  name: string;
  totalFilings5y: number;
  totalSpending5y: number | null;
}

export interface LdaIssueDetail extends LdaIssueCode {
  topClients: {
    id: number;
    name: string;
    state: string | null;
    totalFilings: number;
    totalSpending: number | null;
  }[];
}

export interface LdaClient {
  id: number;
  name: string;
  state: string | null;
  totalFilings: number;
  totalSpending: number | null;
  issueCodes: string[];
  latestFilingYear: number | null;
}

export interface LdaFiling {
  id: string;
  filingUuid: string;
  filingType: string;
  filingYear: number;
  filingPeriod: string | null;
  income: number | null;
  expenses: number | null;
  dtPosted: string | null;
  registrantName: string;
  clientName: string;
  clientState: string | null;
  issueCodes: string[];
}

export interface LdaRegistrant {
  id: number;
  name: string;
  state: string | null;
  city: string | null;
  totalFilings: number;
  totalClients: number;
}

export interface LdaLobbyist {
  id: number;
  firstName: string;
  lastName: string;
  coveredPositions: unknown[];
  registrantIds: number[];
  activeYears: number[];
}

export interface LdaEntity {
  id: number;
  name: string;
  totalFilings5y: number;
}

export interface CongressBill {
  id: string;
  congress: number;
  billType: string;
  billNumber: string;
  title: string;
  introducedDate: string | null;
  sponsorName: string | null;
  sponsorState: string | null;
  sponsorParty: string | null;
  latestActionText: string | null;
  latestActionDate: string | null;
  policyArea: string | null;
  cosponsorsCount: number;
  originChamber: string | null;
  url: string | null;
}

export interface FecCommittee {
  id: string;
  name: string;
  committeeType: string | null;
  designation: string | null;
  party: string | null;
  state: string | null;
  totalReceipts: number | null;
  totalDisbursements: number | null;
  cashOnHand: number | null;
}

export interface PagedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/* ── Existing lobby-intel / federal-spending types ──────────────────────── */

export interface LobbyIntelSummary {
  id: string;
  slug: string;
  name: string;
  state: string | null;
  totalSpending: number | null;
  filings: number | null;
  issues: string[];
  years: number[];
  trajectory: string | null;
  growthRate: number | null;
  yearlySpend: { year: number; amount: number }[];
}
export interface LobbyIssue {
  code: string;
  name: string;
  totalSpending: number | null;
  totalFilings: number | null;
  surgeTrend: string | null;
  surgePct: number | null;
  latestQuarter: string | null;
  latestIncome: number | null;
}
export interface LobbyTrendingTopic {
  word: string;
  latestCount: number;
  avgPrior: number | null;
  growthPct: number | null;
  kind: string;
}
export interface LobbyOverview {
  totalClients: number;
  totalIssues: number;
  topSpenders: LobbyIntelSummary[];
  exploding: LobbyIntelSummary[];
  hotIssues: LobbyIssue[];
  surgingIssues: LobbyIssue[];
  trendingTopics: LobbyTrendingTopic[];
  lastSyncedAt: string | null;
}
export interface FederalContractor {
  id: string;
  name: string;
  slug: string | null;
  uei: string | null;
  totalContracts: number | null;
  pctOfAllContracts: number | null;
  costPerTaxpayer: number | null;
  category: string | null;
  subsidiaries: number | null;
  rankByContracts: number | null;
  yearlySpend: { year: number; amount: number }[];
  topAgencies: { slug?: string; name: string; amount: number }[];
  topAwards: {
    awardId: string;
    recipient: string;
    amount: number;
    agency: string;
    description?: string;
    startDate?: string;
  }[];
  noBidAwards: {
    awardId: string;
    recipient: string;
    amount: number;
    agency: string;
    description?: string;
  }[];
  noBidTotal: number | null;
}
export interface FederalAgency {
  slug: string;
  name: string;
  abbreviation: string | null;
  displayName: string | null;
  budgetAuthority: number | null;
  obligated: number | null;
  outlays: number | null;
  pctOfTotal: number | null;
  pctContracts: number | null;
  costPerAmerican: number | null;
  rankBySpending: number | null;
  contractsTotal: number | null;
  grantsTotal: number | null;
  yearlyBudget: { year: number; amount: number }[];
  topContractors: { name: string; amount: number }[];
}
export interface FederalIndustry {
  code: string;
  name: string;
  slug: string | null;
  totalSpending: number | null;
  rank: number | null;
  pctOfTotal: number | null;
}
export interface FederalSpendingOverview {
  totalContractors: number;
  totalAgencies: number;
  totalIndustries: number;
  topContractors: FederalContractor[];
  topAgencies: FederalAgency[];
  topIndustries: FederalIndustry[];
  topNoBidContractors: { name: string; total: number; count: number }[];
  lastSyncedAt: string | null;
}

/* ── New types ──────────────────────────────────────────────────────────── */

export interface IntelligenceInsight {
  id: string;
  category: string;
  title: string;
  body: string;
  severity: string; // info, notable, critical
  generatedAt: string;
}

export interface FederalRegisterDoc {
  id: string;
  documentNumber: string;
  type: string;
  title: string;
  abstract?: string;
  agencyNames: string[];
  publicationDate: string;
  commentEndDate?: string | null;
  effectiveDate?: string | null;
  htmlUrl?: string | null;
  significantRule: boolean;
}

export interface BillAction {
  id: string;
  date: string;
  text: string;
  type?: string | null;
  chamber?: string | null;
}

export interface BillCommittee {
  id: string;
  committeeName: string;
  committeeCode?: string | null;
  chamber?: string | null;
}

export interface BillSubject {
  id: string;
  name: string;
}

export interface CongressBillDetail extends CongressBill {
  actions: BillAction[];
  committees: BillCommittee[];
  subjects: BillSubject[];
}

/* ── Client Intelligence Profile ──────────────────────────────────────── */

export interface ClientCapabilityRef {
  name: string;
  sector: string | null;
  tags: string[];
}

export interface ClientIntelProfile {
  client: {
    id: string;
    name: string;
    description: string | null;
    sectorTag: string | null;
    submissionTracks: string[];
    capabilities: ClientCapabilityRef[];
  };
  lda: {
    matched: boolean;
    ldaClientId: number | null;
    confidence: number;
    totalFilings: number;
    totalSpending: number | null;
    issueCodes: string[];
    recentFilings: LdaFiling[];
    yearlySpend: { year: number; amount: number }[];
  };
  contracting: {
    matched: boolean;
    contractorName: string | null;
    totalContracts: number | null;
    rankByContracts: number | null;
    noBidTotal: number | null;
    topAgencies: { name: string; amount: number }[];
    yearlySpend: { year: number; amount: number }[];
  };
  lobbyIntel: {
    matched: boolean;
    trajectory: string | null;
    growthRate: number | null;
    totalSpending: number | null;
  };
  relevantBills: { total: number; bills: CongressBill[] };
  activeRegulations: { total: number; documents: FederalRegisterDoc[] };
  competitors: {
    topBySpend: { name: string; totalSpending: number; sharedIssues: string[] }[];
    newEntrants: { name: string; firstFilingDate: string; issues: string[] }[];
  };
  aiSummary: string | null;
  lastUpdated: string;
}

export interface IntelligenceChange {
  id: string;
  source: string;
  changeType: string;
  severity: string;
  title: string;
  description: string;
  relatedClientIds: string[];
  relatedIssues: string[];
  relatedPeCodes?: string[];
  data: Record<string, unknown>;
  detectedAt: string;
  consumed?: boolean;
}

/**
 * Cross-client alert roll-up (GET /api/intelligence/portfolio-alerts). Same
 * alert taxonomy as the client Intelligence tab Top Alerts, spanning every
 * active client. Shared by the dashboard Needs-Attention banner and the
 * Changes inbox so all three surfaces use one taxonomy.
 */
export interface PortfolioAlertItem {
  id: string;
  type: string;
  severity: string;
  title: string;
  subtitle: string;
  when: string;
  countdownDays: number | null;
  countdownLabel: string | null;
  href: string | null;
  clientId: string;
  clientName: string;
  state?: string | null;
}

export interface PortfolioAlertsResponse {
  alerts: PortfolioAlertItem[];
  total: number;
  clientCount: number;
  generatedAt: string;
}

/** Friendly labels for the portfolio-alert category taxonomy. */
export const PORTFOLIO_ALERT_CATEGORY_LABELS: Record<string, string> = {
  comment_deadline: 'Comment deadline',
  comment_overdue: 'Comment closed',
  competitor_filing: 'Competitor filing',
  contract_award: 'Contract award',
  hearing: 'Hearing',
  bill_movement: 'Bill movement',
};

export interface CrmClient {
  id: string;
  name: string;
  status: string;
  description: string | null;
}

export interface GeneratedBriefing {
  briefing: string;
  generatedAt: string;
  dataPoints: { source: string; metric: string; value: string }[];
}

export interface BriefingWhatsNewItem {
  title: string;
  source: string;
  detail: string;
  citation: string;
}

export interface BriefingWhatsComingItem {
  title: string;
  date: string;
  type: string;
  action: string;
}

export interface BriefingSuggestedAction {
  action: string;
  rationale: string;
  urgency: 'high' | 'medium' | 'low';
}

export interface EnhancedBriefing {
  heroSummary: string;
  whatsNew: BriefingWhatsNewItem[];
  whatsComing: BriefingWhatsComingItem[];
  suggestedActions: BriefingSuggestedAction[];
  generatedAt: string;
}

export interface TrackedBill {
  identifier: string;
  title: string;
  latestActionDate: string | null;
  latestActionText: string | null;
  sponsorName: string | null;
  sponsorParty: string | null;
  subjectNames: string[];
}

export interface TrackedBillsResult {
  total: number;
  issueCodes: string[];
  bills: TrackedBill[];
}

export interface LeaderboardRegistrant {
  name: string;
  filingCount: number;
  totalIncome: number;
  isNewEntrant: boolean;
  firstFilingDate: string | null;
  sharedLobbyists: string[];
}

export interface IssueLeaderboard {
  issueCode: string;
  issueName: string;
  totalFilings: number;
  registrants: LeaderboardRegistrant[];
}

export interface CompetitorBoardEntry {
  registrantName: string;
  filingCount: number;
  isNewEntrant: boolean;
  issueOverlap: string[];
}

export interface CompetitorBoard {
  competitors: CompetitorBoardEntry[];
  leaderboards: IssueLeaderboard[];
}

export interface ExStafferCoveredPosition {
  position_title?: string;
  offices?: Array<{ name?: string }>;
  dates_covered?: string;
}

export interface ExStafferEntry {
  name: string;
  coveredPositions: ExStafferCoveredPosition[];
}

export interface ExStaffersResult {
  lobbyists: ExStafferEntry[];
}

export interface HealthScore {
  score: number;
  breakdown: {
    meetings: number;
    emails: number;
    tasksCompleted: number;
    debriefs: number;
    outreachSent: number;
  };
  trend: 'improving' | 'stable' | 'declining';
  period: string;
}

export interface CommentAlert {
  documentId: string;
  title: string;
  type: string;
  commentEndDate: string;
  daysToDeadline: number;
  severity: string;
  agencies: string[];
  clientId: string;
  clientName: string;
  relevanceScore: number;
}

/* ── Home dashboard, today timeline + ticker + Meri brief ─────────────── */

export type TimelineEventSeverity = 'info' | 'notable' | 'critical';
export type TimelineEventKind = 'hearing' | 'deadline' | 'change' | 'brief';

export interface TimelineEvent {
  id: string;
  kind: TimelineEventKind;
  label: string;
  title: string;
  detail: string | null;
  severity: TimelineEventSeverity;
  time: string | null;
  timestamp: string;
  href: string | null;
}

export interface TodayTimeline {
  events: TimelineEvent[];
  counts: { critical: number; notable: number; info: number };
  today: string;
}

export interface LiveTickerItem {
  id: string;
  source: string;
  title: string;
  severity: string;
  detectedAt: string;
}

export interface DailyBrief {
  brief: string;
  generatedAt: string;
  provider: string | null;
  model: string | null;
  empty: boolean;
}

export type ComingUpItemKind = 'hearing' | 'markup' | 'deadline' | 'meeting';

export interface ComingUpItem {
  id: string;
  kind: ComingUpItemKind;
  label: string;
  title: string;
  detail: string | null;
  severity: TimelineEventSeverity;
  date: string;
  time: string | null;
  href: string | null;
}

export interface ComingUpResult {
  items: ComingUpItem[];
  totalThisWeek: number;
}

export interface PortfolioSummary {
  activeClients: number;
  needAttention: number;
  ldaSpendQtd: number;
  billsTracked: number;
  activeRegulations: number;
}

/* ── Report Card (Feature 4.1) ─────────────────────────────────────────── */

export interface ReportCardData {
  client: { id: string; name: string; sectorTag: string | null };
  tenant: { name: string; logoS3Key: string | null };
  period: { start: string; end: string; label: string };
  activity: {
    meetings: number;
    /** GAI-29: distinct attendee roles engaged (derived from attendee.role), not offices. */
    uniqueRoles: string[];
    outreachSent: number;
    outreachOpenRate: number;
    tasksCompleted: number;
    debriefsFiled: number;
    mailThreads: number;
  };
  intelligence: {
    billsTracked: number;
    billsByStatus: Record<string, number>;
    competitorCount: number;
    lobbySpend: number;
    contractWins: number;
  };
  outcomes: Array<{
    title: string;
    fiscalYear: string;
    outcomeType: string;
    capability: string | null;
    notes: string | null;
  }>;
  healthTrend: Array<{ week: string; score: number }>;
  aiForwardLook: string;
  generatedAt: string;
}

/* ── Knowledge Graph (Feature 4.2) ─────────────────────────────────────── */

export interface GraphNode {
  id: string;
  type: 'client' | 'registrant' | 'lobbyist' | 'contractor' | 'bill' | 'pac' | 'agency';
  label: string;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  label: string;
}

export interface KnowledgeGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  resolutionQuality: {
    avgConfidence: number;
    confirmedCount: number;
    unconfirmedCount: number;
  };
}

/* ── Outreach Context (Feature 4.3) ────────────────────────────────────── */

export interface OutreachContextResult {
  context: string;
}
