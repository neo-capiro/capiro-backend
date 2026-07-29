import type { ClientIntelProfile } from '../../intelligence/types.js';

// ── Re-export intelligence types used by section components ──────────
export type {
  ClientIntelProfile,
  HealthScore,
  TrackedBillsResult,
  TrackedBill,
  IntelligenceChange,
  CommentAlert,
  FederalRegisterDoc,
  ExStaffersResult,
  ExStafferEntry,
  KnowledgeGraphData,
  GraphNode,
  GraphEdge,
} from '../../intelligence/types.js';

// ── Section identifiers and metadata ────────────────────────────────
export type SectionId =
  | 'snapshot'
  | 'financial-footprint'
  | 'funding-opportunities'
  | 'district-nexus'
  | 'legislative-regulatory';

export interface SectionMeta {
  id: SectionId;
  num: number;
  title: string;
  shortTitle: string;
}

export interface SectionNavMeta {
  syncedAt: string | null;
  sourceCount: number;
}

export const SECTION_ORDER: SectionMeta[] = [
  { id: 'snapshot', num: 1, title: 'Snapshot', shortTitle: 'Snapshot' },
  {
    id: 'financial-footprint',
    num: 2,
    title: 'Financial Footprint',
    shortTitle: 'Financial',
  },
  // Funding Opportunities sits BEFORE District Nexus deliberately. The two are
  // adjacent in a user's head and easy to conflate, and the order makes the
  // distinction: this section is future pursuits, the next one is money already
  // awarded into a district. It is a separate workflow, not a District Nexus
  // sub-panel.
  {
    id: 'funding-opportunities',
    num: 3,
    title: 'Funding Opportunities',
    shortTitle: 'Opportunities',
  },
  {
    id: 'district-nexus',
    num: 4,
    title: 'District Nexus',
    shortTitle: 'Districts',
  },
  {
    id: 'legislative-regulatory',
    num: 5,
    title: 'Legislative & Regulatory',
    shortTitle: 'Legislative',
  },
];

export function buildSectionNavMeta(
  profile: ClientIntelProfile | null | undefined,
): SectionNavMeta {
  const sourceCount = [
    profile?.lda?.matched,
    profile?.contracting?.matched,
    profile?.lobbyIntel?.matched,
  ].filter(Boolean).length;

  return {
    syncedAt: profile?.lastUpdated ?? null,
    sourceCount,
  };
}

export interface ClientProfileV1 {
  client: { id: string; name: string };
  generatedAt: string;
  meta?: {
    schema?: string;
    sectionOrder?: string[];
    hasSnapshot?: boolean;
    hasFinancialFootprint?: boolean;
    hasLegislativeRegulatory?: boolean;
    hasRelationships?: boolean;
    /** ISO timestamp matching top-level generatedAt */
    generatedAt?: string;
    /** Count of distinct confirmed intel sources (lda, contracting, lobby_intel) */
    sourceCount?: number;
    /** Count of unconfirmed/pending mappings for this client */
    unresolvedMappings?: number;
  };
  links: {
    changesInbox: string;
    mappingsAdmin: string;
    competitorIssuePage: string;
    billDetailBase: string;
    entityResolutionQueue: string;
  };
  sections: {
    snapshot: {
      trajectory: {
        label: string | null;
        growthRate: number | null;
        totalSpending: number | null;
        yearlySpend: Array<{ year: number; amount: number }>;
        model?: {
          label?: string | null;
          confidence?: number | null;
          score?: number | null;
          source?: 'model' | 'fallback' | string;
        } | null;
        fallback?: {
          label?: string | null;
        } | null;
      };
      health: {
        score: number;
        trend: 'improving' | 'stable' | 'declining';
      };
      topAlerts: Array<{
        id?: string;
        type: string;
        severity: string;
        title: string;
        subtitle: string;
        when: string;
        countdownDays?: number | null;
        countdownLabel?: string | null;
        href?: string | null;
        // Per-user worklist state. 'acknowledged' rows stay visible but
        // de-emphasized; dismissed/snoozed rows are filtered out server-side.
        state?: 'acknowledged' | null;
      }>;
      // How many MORE alerts exist beyond the top 5 shown on the card.
      alertsHiddenCount?: number;
      dailyBriefing?: {
        summary: string | null;
        highlights: Array<{
          label: string;
          value: string | number | null;
          tone: 'critical' | 'notable' | 'info' | 'neutral';
        }>;
        generatedAt: string;
        eventCount: number;
        ctaHref?: string;
      } | null;
      activity14d: Array<{
        date: string;
        meetings: number;
        emails: number;
        tasks: number;
        debriefs: number;
        // Optional for backward compatibility, older API responses did
        // not include outreach in the daily breakdown. SnapshotSection
        // treats `undefined` as 0 when summing.
        outreach?: number;
      }>;
      changes7dCount: number;
    };
    financialFootprint: {
      hero: {
        lobbyingTtm: number;
        obligationsTtm: number;
        returnRatio: number | null;
        gap: number;
        truthState?: 'normal' | 'zero_obligation' | 'no_activity';
      };
      series: {
        lobbying: Array<{ year: number; amount: number }>;
        obligations: Array<{ year: number; amount: number }>;
        quarterSeries: Array<{ label: string; lobbying: number; obligations: number }>;
      };
      fecMoneyFlow: {
        mappedEmployer: string | null;
        summary: {
          totalContributions: number;
          totalAmount: number;
          committeeCount: number;
          candidateCount: number;
          memberCount: number;
          billCount: number;
        };
        committees?: Array<{
          committeeId: string;
          committeeName: string;
          totalAmount: number;
          contributionCount: number;
          latestContributionDate: string | Date | null;
          candidates: Array<{
            candidateId?: string | null;
            candidateName: string;
            totalAmount: number;
            contributionCount: number;
            linkedMembers: Array<{ memberName: string; billCount: number }>;
          }>;
          bills: Array<{ billId: string; billTitle: string; sponsorName: string | null }>;
        }>;
        /** Discriminates the kind of money shown; individual employer-linked vs PAC. */
        contributionType?: 'individual_employer_linked';
        /** Client's own PAC giving (Schedule B). tracked:false until a committee is mapped. */
        pacGiving?: {
          tracked: boolean;
          committees: Array<{
            committeeId: string;
            committeeName: string | null;
            totalAmount: number;
            disbursementCount: number;
            recipients: Array<{
              recipientName: string;
              candidateName: string | null;
              totalAmount: number;
            }>;
          }>;
          summary?: { totalAmount: number; disbursementCount: number; recipientCount: number };
        };
        /** Legal/compliance disclaimer text, single source of truth from the API. */
        disclaimer?: string;
      };
      districtNexus: {
        topDistricts: Array<{
          district: string;
          jobs: number;
          capability: string;
          dataYear: number;
          spend?: number;
          awardCount?: number;
        }>;
        capabilities?: Array<{
          capabilityId: string;
          capabilityName: string;
          capabilitySector: string | null;
          districtNexus: string | null;
          districts: Array<{ district: string; jobs: number; stateName: string; dataYear: number }>;
          talkingPoints: string[];
          totalSupportedJobs: number | null;
        }>;
      };
    };
    legislativeRegulatory: {
      kanban: {
        total: number;
        issueCodes: string[];
        columns: Array<{
          id: 'introduced' | 'committee' | 'passed' | 'enacted';
          label: string;
          count: number;
          bills: Array<{
            identifier: string;
            title: string;
            latestActionDate: string | Date | null;
            latestActionText: string | null;
            probability?: number | null;
            isManual?: boolean;
          }>;
        }>;
      };
      regulatoryLifecycle: {
        totalLinkedBills?: number;
        totalRegulations?: number;
        rails: Array<{
          documentNumber: string;
          title: string;
          agencyNames: string[];
          linkedBills: string[];
          currentStage: string;
          deadline: string | Date | null;
          stages: Array<{ key: string; label: string }>;
        }>;
      };
      hearingsAndMarkups: Array<{
        id: string;
        committeeName: string;
        chamber: string;
        title: string;
        date: string | Date;
        time: string | null;
        type: string | null;
        linkedBills: string[];
        isTracked: boolean;
      }>;
    };
    relationships: {
      scopedGraph: {
        resolutionQuality: {
          avgConfidence: number;
          confirmedCount: number;
          unconfirmedCount: number;
        };
        meta: { lobbyistCount: number; memberCount: number; committeeCount: number };
      };
      officeRecommender: Array<{
        office: string;
        score: number;
        tags: string[];
        billCount: number;
        // Office Recommender v2 member-identity fields (optional for backward
        // compatibility with cached aggregates that predate the rewrite).
        memberId?: string;
        party?: 'R' | 'D' | 'I' | null;
        state?: string | null;
        chamber?: 'House' | 'Senate' | null;
        committee?: string | null;
      }>;
      exStafferCount: number;
    };
  };
}

export function minutesAgoLabel(isoDate: string | null | undefined): string {
  if (!isoDate) return 'Synced recently';
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return 'Synced recently';

  const mins = Math.max(1, Math.round((Date.now() - d.getTime()) / (1000 * 60)));
  if (mins < 60) return `Synced ${mins} min ago`;

  const hours = Math.round(mins / 60);
  if (hours < 24) return `Synced ${hours}h ago`;

  const days = Math.round(hours / 24);
  return `Synced ${days}d ago`;
}

// ── Shared data utilities ────────────────────────────────────────────

/** Compact dollar formatter, no external dep */
export function formatCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return '$0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}

/**
 * Humanize a congress.gov bill id slug for display.
 *
 * The backend `identifier` is the raw congress_bill.id, formatted
 * `{congress}-{billType}-{number}` (e.g. "119-hr-1742"). That slug is what the
 * drill-through href and the tracked-bill API expect, so callers must keep it
 * verbatim for those purposes — this helper is for DISPLAY ONLY (e.g.
 * "H.R. 1742"). The current congress prefix is dropped to keep the chip compact;
 * unknown formats are returned unchanged rather than mangled.
 */
const BILL_TYPE_LABELS: Record<string, string> = {
  hr: 'H.R.',
  s: 'S.',
  hres: 'H.Res.',
  sres: 'S.Res.',
  hjres: 'H.J.Res.',
  sjres: 'S.J.Res.',
  hconres: 'H.Con.Res.',
  sconres: 'S.Con.Res.',
};

export function formatBillIdentifier(identifier: string | null | undefined): string {
  const raw = (identifier ?? '').trim();
  const match = /^(\d+)-([a-z]+)-(\d+)$/i.exec(raw);
  if (!match) return raw;
  const [, , type, number] = match;
  const label = BILL_TYPE_LABELS[type!.toLowerCase()];
  return label ? `${label} ${number}` : raw;
}

/**
 * Format a return ratio (federal obligations ÷ lobbying spend) for display.
 *
 * The underlying ratio is unbounded: a defense prime with billions in
 * obligations against a few hundred thousand in LDA-mapped lobbying yields
 * five-figure ratios (e.g. 14275.9×). Rendering raw decimals on a number that
 * large reads as false precision, so we round and add thousands separators at
 * scale while keeping one decimal for small, meaningful ratios.
 */
export function formatRatio(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '-';
  const abs = Math.abs(ratio);
  if (abs >= 100) return `${Math.round(ratio).toLocaleString('en-US')}×`;
  return `${ratio.toFixed(1)}×`;
}

/** Short human date, "May 26, 2026" */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

/** Days until a deadline ISO date string (negative = past) */
export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

/**
 * Kanban stage from a bill's latest action text. Implementation now lives in
 * @capiro/shared (LegiWatch A4 — one canonical home); re-exported so existing
 * importers of this module keep their path.
 */
export { billStage, type BillStage } from '@capiro/shared';
