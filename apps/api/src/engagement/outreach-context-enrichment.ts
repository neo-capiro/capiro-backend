// Outreach context enrichment (accuracy fix, 2026-07-11).
//
// WHY: when a user attaches a "bill" or "programElement" context item in the v2
// wizard, the only thing the client sends server-side is a single thin string
// (a bill's `latestActionText`, or a PE's two-figure "Current / Request" line).
// The LLM then narrates from that alone, which produced two real client-facing
// failure modes in prod drafts:
//   • Bills: a stale `latestActionText` read as "advancing / debate imminent"
//     when the bill's canonical status was actually `rule_failed` (stalled).
//   • PEs: "Current: $112.9M / Request: $72.1M" read chronologically as a
//     REDUCTION, when $112.9M is in fact a HAC-D plus-up ABOVE the $72.1M
//     request — direction reversed — and the HASC cut was invisible entirely.
//
// FIX: before the prompt is assembled, replace those thin bodies with an
// AUTHORITATIVE block built from our own tables (all global / non-RLS), reusing
// the canonical status + funding-precedence helpers from @capiro/shared so the
// numbers can never drift from what the finder/Meri surfaces show. These pure
// formatters take already-queried data (the EngagementService does the I/O), so
// they are deterministic and unit-testable.

import {
  billStatusLabel,
  fmtFundingMillions,
  renderPeFundingForModel,
  type FundingStageValues,
  type ModelFundingYear,
} from '@capiro/shared';

/** Context-item id → the CongressBill id it references, or null. */
export function billIdFromItemId(itemId: string): string | null {
  const m = /^bill-(.+)$/.exec(itemId);
  return m ? m[1]! : null;
}

/** Context-item id → the ProgramElement peCode it references, or null. */
export function peCodeFromItemId(itemId: string): string | null {
  const m = /^pe-(.+)$/.exec(itemId);
  return m ? m[1]! : null;
}

/**
 * Canonical $M formatter — re-exported from @capiro/shared (the one funding
 * money formatter) so existing callers/tests keep importing it from here.
 */
export const fmtM = fmtFundingMillions;

function ymd(d: Date | string | null | undefined): string {
  if (!d) return '';
  const s = typeof d === 'string' ? d : d.toISOString();
  return s.slice(0, 10);
}

export interface BillVoteRow {
  chamber: string | null;
  rollNumber: number | null;
  question: string | null;
  result: string | null;
  yeas: number | null;
  nays: number | null;
  voteDate: Date | string | null;
}

export interface GoverningRuleRow {
  ruleBillId: string;
  ruleStatus: string | null;
  ruleLatestAction: string | null;
  ruleVotes: BillVoteRow[];
}

export interface BillTruth {
  id: string;
  title: string | null;
  status: string | null;
  statusAt: Date | string | null;
  latestActionText: string | null;
  latestActionDate: Date | string | null;
  sponsorName: string | null;
  sponsorParty: string | null;
  sponsorState: string | null;
  cosponsorsCount: number | null;
  committees: string[];
  votes: BillVoteRow[];
  governingRules: GoverningRuleRow[];
}

function voteLine(v: BillVoteRow): string {
  const chamber = v.chamber ? v.chamber.charAt(0).toUpperCase() + v.chamber.slice(1) : '';
  const roll = v.rollNumber != null ? ` Roll ${v.rollNumber}` : '';
  const tally = v.yeas != null && v.nays != null ? ` ${v.yeas}–${v.nays}` : '';
  const date = v.voteDate ? ` (${ymd(v.voteDate)})` : '';
  const q = v.question ? ` on "${v.question}"` : '';
  return `${chamber}${roll}: ${v.result ?? 'result unknown'}${tally}${date}${q}`.trim();
}

/**
 * Build the AUTHORITATIVE BILL STATUS block. Mirrors MeriToolsService.getBillStatus'
 * honesty rules: the canonical status is stated plainly, a `rule_failed` bill is
 * explicitly flagged as stalled, and the absence of a vote is never read as passage.
 */
export function formatBillTruth(bill: BillTruth): string {
  const lines: string[] = [];
  const label = bill.status ? billStatusLabel(bill.status) : null;
  lines.push(
    'AUTHORITATIVE BILL STATUS (Capiro database — treat as source of truth; do not infer beyond it):',
  );
  if (bill.title) lines.push(`- Bill: ${bill.title}`);
  if (label) {
    lines.push(
      `- Canonical status: ${label}${bill.statusAt ? ` (as of ${ymd(bill.statusAt)})` : ''}`,
    );
  }
  if (bill.latestActionText) {
    lines.push(
      `- Latest action: ${bill.latestActionText}${bill.latestActionDate ? ` (${ymd(bill.latestActionDate)})` : ''}`,
    );
  }
  if (bill.sponsorName) {
    const ps = [bill.sponsorParty, bill.sponsorState].filter(Boolean).join('-');
    lines.push(
      `- Sponsor: ${bill.sponsorName}${ps ? ` (${ps})` : ''}${
        bill.cosponsorsCount != null ? `; cosponsors: ${bill.cosponsorsCount}` : ''
      }`,
    );
  }
  if (bill.committees.length) {
    lines.push(`- Committees of referral: ${bill.committees.join('; ')}`);
  }
  if (bill.votes.length) {
    lines.push(`- Roll-call votes on the bill itself: ${bill.votes.map(voteLine).join(' | ')}`);
  }
  for (const r of bill.governingRules) {
    const rLabel = r.ruleStatus ? billStatusLabel(r.ruleStatus) : null;
    const rv = r.ruleVotes.length ? ` — ${r.ruleVotes.map(voteLine).join(' | ')}` : '';
    lines.push(
      `- Governing rule ${r.ruleBillId.replace(/^\d+-/, '').toUpperCase()}: ${rLabel ?? 'status unknown'}${rv}`,
    );
  }
  const notes: string[] = [];
  if (bill.status === 'rule_failed') {
    notes.push(
      'The rule governing this bill FAILED — the bill did NOT advance to the floor under that rule; it is stalled, not pending passage. Do not describe floor debate or amendment windows as active.',
    );
  }
  if (!bill.votes.length) {
    notes.push(
      'No recorded roll-call vote on the bill itself — do NOT infer that it passed or failed a chamber from the absence of a vote.',
    );
  }
  if (notes.length) lines.push(`- NOTE: ${notes.join(' ')}`);
  return lines.join('\n');
}

export interface PeYearFunding extends FundingStageValues {
  fy: number;
  /** NDAA (authorization) conference report — outside the appropriations ladder. */
  ndaaConference?: number | null;
}

export interface PeTruth {
  peCode: string;
  title: string | null;
  service: string | null;
  budgetActivityName: string | null;
  /** Human exhibit noun (R-1 PE vs P-1 procurement line), if the caller resolved it. */
  budgetExhibitType?: string | null;
  /** Latest mark-bearing FY; the shared renderer derives it when omitted. */
  currentCycleFy?: number | null;
  /** The FULL fiscal-year series (historical → current cycle → outyears), numbers coerced. */
  years: PeYearFunding[];
}

/**
 * Build the AUTHORITATIVE PROGRAM ELEMENT FUNDING block. Delegates to the shared
 * renderPeFundingForModel so every LLM surface renders the identical, fully
 * labeled series — FY + stage + authorization/appropriations vehicle + signed
 * direction vs the request, the NDAA conference report as a distinct
 * authorization figure, and the current authoritative figure per FY. The
 * direction can never be inverted, a chamber cut can never be silently dropped,
 * and an outyear projection can never be quoted as "the request".
 */
export function formatPeTruth(pe: PeTruth): string {
  return renderPeFundingForModel({
    peCode: pe.peCode,
    title: pe.title,
    service: pe.service,
    budgetExhibitType: pe.budgetExhibitType ?? null,
    currentCycleFy: pe.currentCycleFy ?? null,
    years: pe.years.map(
      (y): ModelFundingYear => ({
        fy: y.fy,
        request: y.request,
        hascMark: y.hascMark,
        sascMark: y.sascMark,
        hacDMark: y.hacDMark,
        sacDMark: y.sacDMark,
        conference: y.conference,
        ndaaConference: y.ndaaConference ?? null,
        enacted: y.enacted,
      }),
    ),
  });
}

// ── Client relationship snapshot (v2 regression fix, 2026-07-11) ─────────────
// The client aggregate (recent meetings/threads, scored key contacts, open
// tasks) is resolved once per campaign and passed as context.clientContext, but
// PromptSpec v2 only renders STRING context values (nonEmptyStr) — an object was
// silently dropped, so turning v2 on removed this channel that v1 had shown via
// its raw JSON dump. This renders the aggregate to a compact, bounded, LABELED
// string (strictly better than the old dump: no uuids/tenantId, capped, tiered).
// Recipient-invariant; pure so it's unit-testable.

export interface ClientRelationshipContext {
  keyStakeholders?: Array<{
    fullName?: string | null;
    title?: string | null;
    organization?: string | null;
    source?: string | null;
  }> | null;
  recentActivity?: Array<{
    type?: string | null;
    title?: string | null;
    date?: Date | string | null;
  }> | null;
  openTasks?: Array<{ title?: string | null; dueDate?: Date | string | null }> | null;
}

const activityLabel = (t: string | null | undefined): string =>
  t === 'mail_thread' ? 'email' : t === 'meeting' ? 'meeting' : t || 'activity';

export function renderClientRelationshipSnapshot(
  cc: ClientRelationshipContext | null | undefined,
): string | null {
  if (!cc) return null;
  const lines: string[] = [];

  const contacts = (cc.keyStakeholders ?? [])
    .filter((s) => s && (s.fullName || s.organization))
    .slice(0, 12)
    .map((s) => {
      const paren = [s.title, s.organization].filter(Boolean).join(', ');
      const src = s.source ? ` [${s.source}]` : '';
      return `${s.fullName ?? 'Unknown'}${paren ? ` (${paren})` : ''}${src}`;
    });
  if (contacts.length) lines.push(`- Key contacts: ${contacts.join('; ')}`);

  const activity = (cc.recentActivity ?? [])
    .filter((a) => a && a.title)
    .slice(0, 6)
    .map((a) => `${activityLabel(a.type)} "${a.title}"${a.date ? ` (${ymd(a.date)})` : ''}`);
  if (activity.length) lines.push(`- Recent activity: ${activity.join('; ')}`);

  const tasks = (cc.openTasks ?? []).filter((t) => t && t.title);
  if (tasks.length) {
    const titles = tasks.slice(0, 3).map((t) => `"${t.title}"`);
    lines.push(`- Open tasks (${tasks.length}): ${titles.join('; ')}`);
  }

  if (!lines.length) return null;
  return [
    'CLIENT RELATIONSHIP SNAPSHOT (recipient-invariant — who this client already works with and recent engagement activity; use for warm framing, do NOT assert these as new facts to the recipient):',
    ...lines,
  ].join('\n');
}

// ── Client profile blocks (OUTREACH_CLIENT_PROFILE, 2026-07-11) ──────────────
// Recipient-invariant blocks that ride the cached v2 prefix (paid ~once per
// batch). All are bounded + relevance-filtered here (there is NO global input
// truncation) and framed as SUPPORTING INTELLIGENCE, never citable facts.

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface ClientPersonLite {
  name?: string | null;
  title?: string | null;
  role?: string | null;
  notes?: string | null;
  lastContact?: Date | string | null;
}

/** "People this client works with" roster (client_people). Warm-intro framing. */
export function renderClientPeopleRoster(people: ClientPersonLite[]): string | null {
  const rows = (people ?? [])
    .filter((p) => p && p.name)
    .slice(0, 15)
    .map((p) => {
      const meta = [p.title, p.role].filter(Boolean).join(', ');
      const last = p.lastContact ? `last contact ${ymd(p.lastContact)}` : '';
      const note = p.notes ? trunc(p.notes.trim(), 120) : '';
      const tail = [last, note].filter(Boolean).join('; ');
      return `- ${p.name}${meta ? ` (${meta})` : ''}${tail ? ` — ${tail}` : ''}`;
    });
  if (!rows.length) return null;
  return [
    "PEOPLE THIS CLIENT WORKS WITH (recipient-invariant — the client's known contacts/relationships; use for warm-intro framing only, do NOT claim a relationship the recipient has not confirmed):",
    ...rows,
  ].join('\n');
}

export interface TargetOfficeLite {
  memberId?: string | null;
  office?: string | null;
  party?: string | null;
  state?: string | null;
  chamber?: string | null;
  committee?: string | null;
  billCount?: number | null;
  /** true = the team's explicit ClientTarget pick (vs. a Meri recommendation). */
  explicit?: boolean;
}

/**
 * The client's coordinated TARGET-OFFICE map (ClientTarget ∪ OfficeRecommendation),
 * so the model knows a recipient is one of a planned set — not an isolated ask.
 * Explicit team picks first, then recommendations; capped.
 */
export function renderClientTargetOffices(offices: TargetOfficeLite[]): string | null {
  const rows = (offices ?? [])
    .filter((o) => o && (o.office || o.memberId))
    .slice(0, 12)
    .map((o) => {
      const ps = [o.party, o.state].filter(Boolean).join('-');
      const bits = [
        o.committee ? `${o.committee}` : null,
        o.billCount ? `${o.billCount} tracked bill${o.billCount === 1 ? '' : 's'}` : null,
        o.explicit ? 'team target' : 'suggested',
      ].filter(Boolean);
      return `- ${o.office ?? o.memberId}${ps ? ` (${ps})` : ''}${
        bits.length ? ` — ${bits.join('; ')}` : ''
      }`;
    });
  if (!rows.length) return null;
  return [
    'CLIENT TARGET OFFICES (recipient-invariant — the offices this client is coordinating outreach across; use to frame this recipient as part of a broader strategy, not to invent positions):',
    ...rows,
  ].join('\n');
}
