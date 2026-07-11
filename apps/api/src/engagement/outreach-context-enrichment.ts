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
  currentFunding,
  FUNDING_STAGE_LABEL,
  type FundingStageValues,
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

/** Compact money in $ millions — mirrors the web fmtMoneyM (canonical PE unit). */
export function fmtM(m: number | null | undefined, digits = 1): string {
  if (m == null || !Number.isFinite(m)) return '—';
  if (Math.abs(m) >= 1000) return `$${(m / 1000).toFixed(2)}B`;
  return `$${m.toFixed(digits)}M`;
}

/** Signed delta in $M with an explicit direction word (never ambiguous). */
function signedM(delta: number): string {
  const dir = delta > 0 ? 'above' : delta < 0 ? 'below' : 'equal to';
  if (delta === 0) return 'equal to the request';
  return `${fmtM(Math.abs(delta))} ${dir} the request`;
}

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
    lines.push(`- Canonical status: ${label}${bill.statusAt ? ` (as of ${ymd(bill.statusAt)})` : ''}`);
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
}

export interface PeTruth {
  peCode: string;
  title: string | null;
  service: string | null;
  budgetActivityName: string | null;
  /** The latest FY row that carries any funding signal, numbers coerced. */
  year: PeYearFunding | null;
}

/**
 * Build the AUTHORITATIVE PROGRAM ELEMENT FUNDING block. Shows the request and
 * EVERY congressional mark explicitly (so a chamber cut can't be silently
 * omitted), names the canonical "current" figure via the shared precedence, and
 * states the direction vs request in words (so "$112.9M current / $72.1M
 * request" can never be narrated as a reduction).
 */
export function formatPeTruth(pe: PeTruth): string {
  const head = [
    `PE ${pe.peCode}`,
    pe.title ? `— ${pe.title}` : '',
    pe.service ? `(${pe.service})` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const lines: string[] = [
    'AUTHORITATIVE PROGRAM ELEMENT FUNDING (Capiro database — $ in millions; cite exactly, do not infer direction):',
    `- ${head}`,
  ];

  const y = pe.year;
  if (!y) {
    lines.push(
      '- No structured funding rows on record for this PE. Do NOT state or estimate a dollar figure; say the funding detail is not available.',
    );
    return lines.join('\n');
  }

  lines.push(`- Fiscal year: FY${String(y.fy).slice(-2)}`);
  if (y.request != null) lines.push(`- President's request: ${fmtM(y.request)}`);

  const marks: Array<[keyof FundingStageValues, string]> = [
    ['hascMark', 'HASC'],
    ['sascMark', 'SASC'],
    ['hacDMark', 'HAC-D'],
    ['sacDMark', 'SAC-D'],
    ['conference', 'Conference'],
    ['enacted', 'Enacted'],
  ];
  const markParts = marks
    .filter(([k]) => y[k] != null)
    .map(([k, lbl]) => {
      const v = y[k] as number;
      const vsReq = y.request != null ? ` (${signedM(v - y.request)})` : '';
      return `${lbl} ${fmtM(v)}${vsReq}`;
    });
  if (markParts.length) {
    lines.push(`- Congressional marks: ${markParts.join(' · ')}`);
  } else {
    lines.push(
      '- No congressional marks on record yet (request only) — do not describe any congressional action on this line.',
    );
  }

  const cur = currentFunding({
    request: y.request,
    hascMark: y.hascMark,
    sascMark: y.sascMark,
    hacDMark: y.hacDMark,
    sacDMark: y.sacDMark,
    conference: y.conference,
    enacted: y.enacted,
  });
  if (cur.value != null && cur.stage !== 'none') {
    const stageLabel = FUNDING_STAGE_LABEL[cur.stage];
    const enacted = y.enacted != null;
    const vsReq =
      y.request != null && cur.stage !== 'request'
        ? ` — ${signedM(cur.value - y.request)}`
        : '';
    lines.push(
      `- Current authoritative figure: ${fmtM(cur.value)} (${stageLabel})${vsReq}. ${
        enacted ? 'This is the enacted level.' : 'NOT enacted; marks may differ by chamber.'
      }`,
    );
  }
  return lines.join('\n');
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
