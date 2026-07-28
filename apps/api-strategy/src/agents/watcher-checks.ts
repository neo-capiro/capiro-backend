/*
 * Stage F (F1): the Strategy Watcher's deterministic checks. PURE module — no
 * Nest, no Prisma, no clock reads (the caller supplies `today`) — so every
 * check is unit-testable in isolation and the WatcherService stays a thin
 * load-and-persist shell. NO LLM anywhere in this file: the plan's bounded
 * LLM interpretation pass for context-comparison findings is a DEFERRED seam
 * (see WatcherService docs); F1 is fully deterministic.
 *
 * The realism verifier is NOT reimplemented here — the service runs
 * @capiro/strategy-verifier's verifyPlan (consumer 4, after the orchestrator
 * repair loop, the write gate and change-set apply) and hands the violations
 * in; check (a) merely FOLDS them into the Finding shape.
 *
 * Phase 3 (Watch consistency backend): every Finding now also carries
 * server-safe PRESENTATION metadata (category/title/sourceLabel/sourceDate/
 * impact/whyCompared/sortRank) — Phase 4's card UI reads these instead of
 * re-deriving them from `message`, and getState's display order is a plain
 * sort on sortRank (then source date, then id). Raw template keys / internal
 * field names never leak into these strings — they read the same as `message`
 * always has: plain language naming the real node/date/label involved.
 */

import { fyOfIso, validIso, type Violation } from '@capiro/strategy-verifier';
import type { PlanEdit } from '../meri/meri.types.js';

export const FINDING_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * Presentation bucket for a finding's card. `dependency` is reserved for the
 * Watcher's OWN actionable ordering check (checkDependencySlippage) and its
 * structural cousin (checkGatePrereq) — a verifier-folded dep-order violation
 * stays `verifier` even though it can describe the same edge; dedupeDependencyFold
 * below removes the redundant verifier card when an actionable one covers the
 * same (node, dependency) pair, so the category split never produces two
 * visible cards for one problem.
 */
export const FINDING_CATEGORIES = [
  'dependency',
  'calendar',
  'deadline',
  'context',
  'ownership',
  'artifact',
  'verifier',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/**
 * Display-order rank (ascending; lower sorts first). The plan's acceptance
 * criterion is specific: dependency-order findings must be actionable and
 * sort ABOVE calendar/deadline findings. The remaining tiers are otherwise
 * unconstrained but kept distinct so the order is stable and greppable rather
 * than an accident of check-function iteration order.
 */
const CATEGORY_SORT_RANK: Record<FindingCategory, number> = {
  dependency: 0,
  calendar: 1,
  deadline: 2,
  ownership: 3,
  context: 4,
  artifact: 5,
  verifier: 6,
};

/**
 * One Watcher observation. `proposedOps` (PlanEdit[], the Meri assistant op
 * shape) makes a finding ACTIONABLE — the service turns each such finding into
 * one proposed sp_change_set. `null`/absent = advisory only.
 *
 * Phase 3 presentation fields are populated by every check below (never left
 * for a caller to backfill): `category`/`sortRank` drive display grouping and
 * order; `title`/`impact` are short, plain-language card text distinct from
 * the fuller `message`; `whyCompared` names the concrete inputs the check
 * used (audit/debugging, not shown verbatim as prose); `sourceLabel`/
 * `sourceDate` are set only when the finding is anchored to an external
 * reference row or another node (a bare self/today comparison has no
 * "source" to name).
 */
export interface Finding {
  code: string;
  severity: FindingSeverity;
  nodeIds: string[];
  message: string;
  suggestion?: string;
  proposedOps?: PlanEdit[] | null;
  category: FindingCategory;
  title: string;
  sourceLabel?: string;
  sourceDate?: string | null;
  impact: string;
  whyCompared: string[];
  sortRank: number;
}

/** A plan step as the service serializes it (dates already YYYY-MM-DD). */
export interface WatcherNode {
  id: string;
  kind: string;
  subject: string;
  title: string;
  startsOn: string;
  endsOn: string | null;
  status: string;
  ownerUserId: string | null;
  dependsOnIds: string[];
  provenance?: unknown;
}

/** Reference-calendar row (matches MeriService grounding's RefRowLite). */
export interface WatcherRefRow {
  label: string;
  fy: number | null;
  startsOn: string | null;
  endsOn: string | null;
}

/** The slice of StewardService.health() the stale-context check consumes. */
export interface WatcherStewardHealth {
  status: 'ok' | 'degraded' | 'conflicted';
  missingRequired?: string[];
  openMaterialConflicts?: Array<{ factA: string; factB: string }>;
  staleDocs?: Array<{ title: string }>;
}

export interface WatcherCheckInput {
  strategy: { id: string; type: string; title?: string };
  nodes: WatcherNode[];
  /** YYYY-MM-DD "now" — injected so the checks are clock-free and replayable. */
  today: string;
  /** Congressional reference rows (from ReferenceService.getCalendars via grounding). */
  congress: WatcherRefRow[];
  stewardHealth: WatcherStewardHealth;
  /** verifyPlan output for THIS plan — computed by the service (consumer 4). */
  verifierViolations: Violation[];
  /**
   * SEAM (check h): node ids whose linked sp_node_artifact no longer lines up
   * (orphaned back-link or regressed node status). Precomputed by the service —
   * artifact refs point at OTHER services' rows (ws_draft / outreach_records)
   * which this module must not know how to resolve.
   */
  artifactMismatches?: string[];
}

/** A submission/ask starting inside this many days of a markup is at risk. */
const HARD_DEADLINE_WINDOW_DAYS = 14;

// --- pure date helpers (ISO YYYY-MM-DD; lexicographic order === chronological) --

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `b` to `a` (a - b; negative when a precedes b). */
function diffDaysIso(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/** A dependency's effective completion date (end, or start for a point event). */
function effectiveEnd(n: WatcherNode): string {
  return n.endsOn && validIso(n.endsOn) ? n.endsOn : n.startsOn;
}

/** Stable dedup identity: (code + sorted nodeIds). Also the change-set dedup
 *  marker key the service embeds in proposal summaries. */
export function findingKey(f: Pick<Finding, 'code' | 'nodeIds'>): string {
  return `${f.code}:${[...f.nodeIds].sort().join('+')}`;
}

// --- verifier-code presentation lookup ------------------------------------------

/** Short card titles for the shared verifier's codes; unlisted codes fall
 *  back to a plain humanization so a future verifier check never surfaces
 *  raw-code text. */
const VERIFIER_TITLES: Record<string, string> = {
  dates: 'Invalid date',
  'dep-self': 'Self-dependency',
  'dep-missing': 'Missing dependency',
  'dep-cycle': 'Dependency cycle',
  'dep-order': 'Out of order',
  'gate-before-dependents': 'Gate not cleared',
  'dep-overlap': 'Overlaps its dependency',
  'submission-before-markup': 'Submission timing risk',
  recess: 'Scheduled during a recess',
  window: 'Outside the planning window',
  'focal-fy-appropriations': 'No focal-year ask',
};

function humanizeCode(code: string): string {
  const words = code.replace(/^verifier:/, '').replace(/[-_]/g, ' ');
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

function verifierTitle(code: string): string {
  return VERIFIER_TITLES[code] ?? humanizeCode(code);
}

// --- checks (each pure; silent on a clean plan) --------------------------------

/**
 * (a) 'verifier' — fold shared-verifier violations into Findings. The Watcher
 * is suggest-only, so severities DEMOTE one notch (error→warning, warning→info):
 * the write-time gate already blocked anything truly impossible, and a check
 * run must never read louder than the gate that let the plan persist.
 * proposedOps stays null (advisory) — the repair belongs to Meri/the user.
 * The verifier's own code is preserved (`verifier:<code>`) so distinct
 * violations on the same node don't dedup into one finding.
 *
 * Category is always 'verifier' (never 'dependency', even for dep-order/
 * dep-cycle/etc.) — dedupeDependencyFold below is what keeps a verifier fold
 * from duplicating an actionable dependency-slippage card for the same edge;
 * splitting these into the 'dependency' bucket would defeat that dedup's
 * purpose of picking exactly one visible card per real problem.
 */
function foldVerifier(violations: Violation[]): Finding[] {
  return violations.map((v) => ({
    code: `verifier:${v.code}`,
    severity: (v.severity === 'error' ? 'warning' : 'info') as FindingSeverity,
    nodeIds: [...v.nodeIds],
    message: v.message,
    ...(v.suggestion ? { suggestion: v.suggestion } : {}),
    proposedOps: null,
    category: 'verifier',
    title: verifierTitle(v.code),
    impact: v.message,
    whyCompared: [`strategy-verifier:${v.code}`],
    sortRank: CATEGORY_SORT_RANK.verifier,
  }));
}

/**
 * (b) 'overdue' — a step whose end has passed while its status is anything but
 * 'active'. Proposes a concrete retime: same duration, restarted TOMORROW
 * (today + 1 — strictly in the future, never a date already in the past).
 *
 * "Tomorrow" is anchored to the RUN-day `today`, so the guarantee only holds
 * while the proposal is fresh: a change-set left open for days would drift
 * into the past and, applied late (head unmoved, so no stale 409), retime the
 * node into an already-past window the next run re-flags — a loop. The
 * service closes that gap: each re-check REWRITES a still-'proposed'
 * change-set whose recomputed ops differ (WatcherService.proposeChangeSets ->
 * ChangeSetsService.refreshProposedOps), keeping the open proposal's dates
 * current until it is approved or applied.
 */
function checkOverdue(nodes: WatcherNode[], today: string): Finding[] {
  const out: Finding[] = [];
  for (const n of nodes) {
    if (!validIso(n.endsOn) || !validIso(n.startsOn)) continue;
    if (n.endsOn >= today || n.status === 'active') continue;
    const duration = Math.max(0, diffDaysIso(n.endsOn, n.startsOn));
    const newStartsOn = addDaysIso(today, 1);
    const newEndsOn = addDaysIso(newStartsOn, duration);
    out.push({
      code: 'overdue',
      severity: 'warning',
      nodeIds: [n.id],
      message: `"${n.title}" ended ${n.endsOn} and is still ${n.status.replace('_', ' ')}.`,
      suggestion: `Restart it ${newStartsOn}–${newEndsOn}, or mark it active if the work is done.`,
      proposedOps: [{ op: 'retime', nodeId: n.id, startsOn: newStartsOn, endsOn: newEndsOn }],
      category: 'calendar',
      title: 'Overdue',
      impact: `"${n.title}" is still open past its planned end date.`,
      whyCompared: ['today', 'endsOn', 'status'],
      sortRank: CATEGORY_SORT_RANK.calendar,
    });
  }
  return out;
}

/** (c) 'missing-owner' — a step nobody owns (info; one finding per node so the
 *  message can name it and dedup stays per-node). */
function checkMissingOwner(nodes: WatcherNode[]): Finding[] {
  return nodes
    .filter((n) => !n.ownerUserId)
    .map((n) => ({
      code: 'missing-owner',
      severity: 'info' as FindingSeverity,
      nodeIds: [n.id],
      message: `"${n.title}" has no owner.`,
      suggestion: 'Assign an owner so the step has someone accountable.',
      category: 'ownership' as const,
      title: 'No owner',
      impact: `No one is accountable for "${n.title}".`,
      whyCompared: ['ownerUserId'],
      sortRank: CATEGORY_SORT_RANK.ownership,
    }));
}

/**
 * (d) 'dependency-slippage' — recomputed from dependsOnIds: a step that starts
 * before a dependency's effective end has slipped. Proposes a retime to the
 * LATEST slipped dependency's end, clamped to TOMORROW — the same strictly-
 * in-the-future floor as checkOverdue, so a dependency that already ended can
 * never drag the target into the past (which would leave the node instantly
 * overdue again after apply, and contradict the overdue proposal fired on the
 * same node in the same run). Duration preserved; point events keep no end.
 * Overlaps the verifier's dep-overlap warning by design — this one is
 * ACTIONABLE (carries the retime op the verifier only suggests in prose).
 *
 * The actionable dependency-order check: category 'dependency', top sortRank.
 * sourceLabel/sourceDate name the dependency actually driving the retime (the
 * latest-finishing slipped predecessor), matching the message/suggestion.
 */
function checkDependencySlippage(nodes: WatcherNode[], today: string): Finding[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: Finding[] = [];
  for (const n of nodes) {
    if (!validIso(n.startsOn)) continue;
    const slipped = (n.dependsOnIds ?? [])
      .map((id) => byId.get(id))
      .filter((d): d is WatcherNode => !!d && d.id !== n.id && validIso(d.startsOn))
      .filter((d) => n.startsOn < effectiveEnd(d));
    if (slipped.length === 0) continue;
    const depEnd = slipped.map(effectiveEnd).sort().pop()!;
    const latest = slipped.find((d) => effectiveEnd(d) === depEnd)!;
    const tomorrow = addDaysIso(today, 1);
    const newStartsOn = depEnd < tomorrow ? tomorrow : depEnd;
    const duration =
      n.endsOn && validIso(n.endsOn) ? Math.max(0, diffDaysIso(n.endsOn, n.startsOn)) : null;
    out.push({
      code: 'dependency-slippage',
      severity: 'warning',
      nodeIds: [n.id, ...slipped.map((d) => d.id)],
      message: `"${n.title}" starts ${n.startsOn}, before "${latest.title}" finishes (${depEnd}).`,
      suggestion: `Move "${n.title}" to start on or after ${newStartsOn}.`,
      proposedOps: [
        {
          op: 'retime',
          nodeId: n.id,
          startsOn: newStartsOn,
          // Point events (no end) stay point events — omit endsOn entirely so
          // the apply pipeline leaves it untouched (endsOn:null would CLEAR it).
          ...(duration !== null ? { endsOn: addDaysIso(newStartsOn, duration) } : {}),
        },
      ],
      category: 'dependency',
      title: 'Out of order',
      sourceLabel: latest.title,
      sourceDate: depEnd,
      impact: `"${n.title}" starts before "${latest.title}" is done.`,
      whyCompared: ['startsOn', 'dependency effective end'],
      sortRank: CATEGORY_SORT_RANK.dependency,
    });
  }
  return out;
}

/** (e) 'gate-prereq' — a gate/decision other steps wait on that itself has no
 *  prerequisites: probably an unmodelled input (info, advisory). Structural
 *  dependency shape, not a calendar/ownership/context matter, so it shares
 *  the 'dependency' category (not the top sortRank tier for actionability —
 *  it carries no proposedOps — but the same grouping bucket). */
function checkGatePrereq(nodes: WatcherNode[]): Finding[] {
  const dependedOn = new Set(nodes.flatMap((n) => n.dependsOnIds ?? []));
  return nodes
    .filter(
      (n) =>
        (n.kind === 'gate' || n.kind === 'decision') &&
        (n.dependsOnIds ?? []).length === 0 &&
        dependedOn.has(n.id),
    )
    .map((n) => ({
      code: 'gate-prereq',
      severity: 'info' as FindingSeverity,
      nodeIds: [n.id],
      message: `${n.kind === 'gate' ? 'Gate' : 'Decision'} "${n.title}" has steps depending on it but no prerequisites of its own.`,
      suggestion: 'Link the inputs this gate actually waits on so slippage propagates.',
      category: 'dependency' as const,
      title: 'No prerequisite',
      impact: `Slippage upstream of "${n.title}" will not propagate to it.`,
      whyCompared: ['dependsOnIds'],
      sortRank: CATEGORY_SORT_RANK.dependency,
    }));
}

/**
 * (f) 'hard-deadline-risk' — a submission/ask starting within 14 days BEFORE
 * (or on the day of) a congress row matching /markup/i in the SAME fiscal
 * year. Starting AFTER a markup is deliberately NOT flagged: post-markup asks
 * (floor amendments, conference) are normal, and warning on them against the
 * default multi-month markup bands would make every clean same-FY plan noisy
 * forever — for submissions the verifier's submission-before-markup finding
 * (folded by check (a)) already covers that case. Rows with no concrete
 * startsOn are skipped (proximity needs a date; the FY-only case is likewise
 * the verifier's territory).
 */
function checkHardDeadlineRisk(nodes: WatcherNode[], congress: WatcherRefRow[]): Finding[] {
  const markups = congress
    .filter((r) => /markup/i.test(r.label) && validIso(r.startsOn))
    .sort((a, b) => (a.startsOn! < b.startsOn! ? -1 : 1));
  if (markups.length === 0) return []; // data-gap guard
  const out: Finding[] = [];
  for (const n of nodes) {
    if ((n.subject !== 'submission' && n.subject !== 'ask') || !validIso(n.startsOn)) continue;
    const nodeFy = fyOfIso(n.startsOn);
    // Nearest UPCOMING same-FY markup within the risk window (0..14 days out).
    // The lower bound keeps earlier markups from misattributing nodes that
    // legitimately target a later one.
    const hit = markups.find((r) => {
      if (fyOfIso(r.startsOn!) !== nodeFy) return false;
      const days = diffDaysIso(r.startsOn!, n.startsOn);
      return days >= 0 && days <= HARD_DEADLINE_WINDOW_DAYS;
    });
    if (!hit) continue;
    const days = diffDaysIso(hit.startsOn!, n.startsOn);
    out.push({
      code: 'hard-deadline-risk',
      severity: 'warning',
      nodeIds: [n.id],
      message: `"${n.title}" starts only ${days} day${days === 1 ? '' : 's'} before ${hit.label} (${hit.startsOn}).`,
      suggestion: `Start "${n.title}" more than ${HARD_DEADLINE_WINDOW_DAYS} days ahead of ${hit.label}.`,
      category: 'deadline',
      title: 'Deadline risk',
      sourceLabel: hit.label,
      sourceDate: hit.startsOn,
      impact: `Only ${days} day${days === 1 ? '' : 's'} of runway before ${hit.label}.`,
      whyCompared: ['startsOn', 'congress calendar'],
      sortRank: CATEGORY_SORT_RANK.deadline,
    });
  }
  return out;
}

/** (g) 'stale-context' — the Steward's grounding health is degraded/conflicted;
 *  the message NAMES what is missing or which facts collide (plan-level). */
function checkStaleContext(health: WatcherStewardHealth): Finding[] {
  if (health.status !== 'degraded' && health.status !== 'conflicted') return [];
  const parts: string[] = [];
  let sourceLabel: string | undefined;
  if (health.status === 'conflicted') {
    const c = health.openMaterialConflicts?.[0];
    const extra = (health.openMaterialConflicts?.length ?? 0) - 1;
    parts.push(
      c
        ? `conflicting facts: "${c.factA}" vs "${c.factB}"${extra > 0 ? ` (+${extra} more)` : ''}`
        : 'open material fact conflicts',
    );
  }
  if (health.missingRequired?.length) {
    parts.push(`missing required context: ${health.missingRequired.join(', ')}`);
  }
  if (health.staleDocs?.length) {
    parts.push(`stale documents: ${health.staleDocs.map((d) => d.title).join(', ')}`);
    sourceLabel = health.staleDocs[0]!.title;
  }
  return [
    {
      code: 'stale-context',
      severity: 'warning',
      nodeIds: [],
      message: `Client grounding is ${health.status} — ${parts.join('; ') || 'see the Context Steward'}.`,
      suggestion: 'Resolve the Steward review queue before trusting plan suggestions.',
      category: 'context',
      title: 'Context needs review',
      ...(sourceLabel ? { sourceLabel } : {}),
      impact: 'Plan suggestions may rely on incomplete or conflicting client information.',
      whyCompared: ['steward health'],
      sortRank: CATEGORY_SORT_RANK.context,
    },
  ];
}

/** (h) 'linked-artifact-mismatch' — fold the service-precomputed mismatch node
 *  ids (see WatcherCheckInput.artifactMismatches seam) to info findings. */
function checkArtifactMismatch(nodes: WatcherNode[], mismatches: string[]): Finding[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return mismatches.map((nodeId) => {
    const n = byId.get(nodeId);
    return {
      code: 'linked-artifact-mismatch',
      severity: 'info' as FindingSeverity,
      nodeIds: [nodeId],
      message: n
        ? `"${n.title}" has a linked artifact that no longer matches its state (${n.status.replace('_', ' ')}).`
        : 'A linked artifact references a step that is no longer in this plan.',
      suggestion: 'Re-check the workspace/outreach back-link for this step.',
      category: 'artifact' as const,
      title: 'Linked artifact mismatch',
      impact: n
        ? `The linked draft/record for "${n.title}" may no longer reflect its real state.`
        : 'A linked draft/record no longer has a matching step in this plan.',
      whyCompared: ['node status', 'linked artifact'],
      sortRank: CATEGORY_SORT_RANK.artifact,
    };
  });
}

/**
 * Drop a folded `verifier:dep-order` finding when an ACTIONABLE
 * `dependency-slippage` finding already covers the same (node, dependency)
 * edge — the plan's own instruction: "the actionable finding wins". Both
 * checks can legitimately fire on the same edge (dep-order: starts before the
 * dependency STARTS; dependency-slippage: starts before it EFFECTIVELY ENDS),
 * so without this a genuinely out-of-order pair would show two cards for one
 * problem. Matching is per-pair, not per-node: a node with several slipped
 * dependencies only suppresses the verifier folds for the specific pairs its
 * dependency-slippage finding actually names.
 */
function dedupeDependencyFold(findings: Finding[]): Finding[] {
  const actionableEdges = new Set<string>();
  for (const f of findings) {
    if (f.code !== 'dependency-slippage') continue;
    const [nodeId, ...depIds] = f.nodeIds;
    for (const depId of depIds) actionableEdges.add(`${nodeId}|${depId}`);
  }
  if (actionableEdges.size === 0) return findings;
  return findings.filter((f) => {
    if (f.code !== 'verifier:dep-order') return true;
    const [nodeId, depId] = f.nodeIds;
    return !actionableEdges.has(`${nodeId}|${depId}`);
  });
}

/**
 * Run every deterministic check and dedup on (code + sorted nodeIds) — the
 * same identity the service uses to avoid re-proposing an already-open
 * change-set. Order: verifier fold first (plan-integrity context), then the
 * Watcher-specific checks, then the dependency/verifier edge dedup (Phase 3).
 */
export function runWatcherChecks(input: WatcherCheckInput): Finding[] {
  const nodes = input.nodes ?? [];
  const all: Finding[] = [
    ...foldVerifier(input.verifierViolations ?? []),
    ...checkOverdue(nodes, input.today),
    ...checkMissingOwner(nodes),
    ...checkDependencySlippage(nodes, input.today),
    ...checkGatePrereq(nodes),
    ...checkHardDeadlineRisk(nodes, input.congress ?? []),
    ...checkStaleContext(input.stewardHealth),
    ...checkArtifactMismatch(nodes, input.artifactMismatches ?? []),
  ];
  const seen = new Set<string>();
  const deduped: Finding[] = [];
  for (const f of all) {
    const key = findingKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }
  return dedupeDependencyFold(deduped);
}
