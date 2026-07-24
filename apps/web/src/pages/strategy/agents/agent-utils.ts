/*
 * Stage F agent-surface pure helpers: tolerant response normalizers for
 * /strategy-api/agents rows (change-sets / missions / runs / run-check), the
 * risk-badge palette, the RiskRouter impact-summary rule, the op → readable
 * diff projector the review queue renders, and the run-findings flattener.
 * All pure (vitest-covered, no React/network) — same idiom as
 * context/context-utils.ts.
 */
import { errorMessage } from '../../../lib/error-message.js';
import type {
  AgentMission,
  AgentRun,
  ChangeSet,
  ChangeSetOp,
  ChangeSetRisk,
  ChangeSetStatus,
  ExecutionRun,
  ExecutionTask,
  ExecutionTaskStatus,
  ExecutionTaskType,
  MissionState,
  RunCheckResult,
  RunFinding,
  RunState,
  SendApprovalPreview,
  StrategyNode,
} from '../types.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

// ---- risk ladder ------------------------------------------------------------

export const CHANGE_SET_RISKS: readonly ChangeSetRisk[] = ['low', 'medium', 'high', 'critical'];

/**
 * Risk-badge palette: low green / medium amber / high orange / critical red.
 * The shared Chip has no orange tone, so high reuses the editor's amber-red
 * conflict-banner literals; the rest ride the sp-root tokens.
 */
export function riskColors(risk: ChangeSetRisk): { bg: string; fg: string } {
  switch (risk) {
    case 'low':
      return { bg: 'var(--success-soft)', fg: 'var(--success)' };
    case 'medium':
      return { bg: 'var(--notable-soft)', fg: 'var(--notable)' };
    case 'high':
      return { bg: '#FCEDE6', fg: '#A14D12' };
    case 'critical':
      return { bg: 'var(--critical-soft)', fg: 'var(--critical)' };
  }
}

/**
 * RiskRouter.requiresImpactSummary (13_agent_permissions risk ladder):
 * critical rows — outreach sends, firm-wide calendar/phase edits — take an
 * explicit confirmation WITH an impact summary before approval. Lower risks
 * approve directly (the server still enforces its own ladder).
 */
export function requiresImpactSummary(risk: ChangeSetRisk): boolean {
  return risk === 'critical';
}

/**
 * The RiskRouter classification a check run persisted on its findings JSON
 * (`riskClassification.risk` — WatcherService / the F2 firm placeholder write
 * it on the ready_for_review transition). Unknown or absent degrades UP to
 * critical, mirroring normalizeChangeSets — a firm-level run with an
 * unreadable classification must never render as low-risk.
 */
export function runRiskLevel(findings: Record<string, unknown> | null): ChangeSetRisk {
  const rc = findings?.riskClassification;
  const risk = isRecord(rc) ? rc.risk : null;
  return CHANGE_SET_RISKS.includes(risk as ChangeSetRisk) ? (risk as ChangeSetRisk) : 'critical';
}

// ---- tolerant normalizers ---------------------------------------------------

const CHANGE_SET_STATUSES: readonly ChangeSetStatus[] = [
  'proposed',
  'approved',
  'applied',
  'rejected',
  'stale',
  'undone',
];
const MISSION_STATES: readonly MissionState[] = [
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'canceled',
];
const RUN_STATES: readonly RunState[] = [
  'queued',
  'planning',
  'waiting_for_input',
  'executing',
  'ready_for_review',
  'completed',
  'failed',
  'canceled',
];

function opsArray(v: unknown): ChangeSetOp[] {
  return Array.isArray(v) ? (v.filter(isRecord) as unknown as ChangeSetOp[]) : [];
}

/** Accepts `[…]` or `{ changeSets: […] }` / `{ items: […] }`. */
export function normalizeChangeSets(data: unknown): ChangeSet[] {
  const raw = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.changeSets)
      ? data.changeSets
      : isRecord(data) && Array.isArray(data.items)
        ? data.items
        : [];
  const out: ChangeSet[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.strategyId !== 'string') {
      continue;
    }
    out.push({
      id: item.id,
      strategyId: item.strategyId,
      runId: str(item.runId),
      summary: str(item.summary) ?? '',
      ops: opsArray(item.ops),
      approvedOps: Array.isArray(item.approvedOps) ? opsArray(item.approvedOps) : null,
      // Unknown risk degrades UP to critical (forces the impact-summary
      // confirmation) — never down to a friction-free approve.
      risk: CHANGE_SET_RISKS.includes(item.risk as ChangeSetRisk)
        ? (item.risk as ChangeSetRisk)
        : 'critical',
      status: CHANGE_SET_STATUSES.includes(item.status as ChangeSetStatus)
        ? (item.status as ChangeSetStatus)
        : 'proposed',
      strategyVersionId: str(item.strategyVersionId) ?? '',
      appliedVersionId: str(item.appliedVersionId),
      approvedByUserId: str(item.approvedByUserId),
      approvedAt: str(item.approvedAt),
      rejectedByUserId: str(item.rejectedByUserId),
      rejectedAt: str(item.rejectedAt),
      appliedByUserId: str(item.appliedByUserId),
      appliedAt: str(item.appliedAt),
      undoneByUserId: str(item.undoneByUserId),
      undoneAt: str(item.undoneAt),
      createdByUserId: str(item.createdByUserId),
      createdAt: str(item.createdAt) ?? '',
      updatedAt: str(item.updatedAt) ?? str(item.createdAt) ?? '',
    });
  }
  return out;
}

/** One mission row (create/PATCH responses return the bare row). */
export function normalizeMission(item: unknown): AgentMission | null {
  if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') return null;
  const cadence = item.cadence === 'daily' || item.cadence === 'weekly' ? item.cadence : null;
  return {
    id: item.id,
    strategyId: str(item.strategyId),
    clientId: str(item.clientId),
    name: item.name,
    description: str(item.description),
    state: MISSION_STATES.includes(item.state as MissionState)
      ? (item.state as MissionState)
      : 'draft',
    cadence,
    nextRunAt: str(item.nextRunAt),
    createdByUserId: str(item.createdByUserId) ?? '',
    createdAt: str(item.createdAt) ?? '',
    updatedAt: str(item.updatedAt) ?? str(item.createdAt) ?? '',
  };
}

/** Accepts `[…]` or `{ missions: […] }` / `{ items: […] }`. */
export function normalizeMissions(data: unknown): AgentMission[] {
  const raw = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.missions)
      ? data.missions
      : isRecord(data) && Array.isArray(data.items)
        ? data.items
        : [];
  const out: AgentMission[] = [];
  for (const item of raw) {
    const m = normalizeMission(item);
    if (m) out.push(m);
  }
  return out;
}

/** One run row (or null when the value is not run-shaped). */
export function normalizeRun(item: unknown): AgentRun | null {
  if (!isRecord(item) || typeof item.id !== 'string') return null;
  return {
    id: item.id,
    missionId: str(item.missionId) ?? '',
    strategyId: str(item.strategyId),
    state: RUN_STATES.includes(item.state as RunState) ? (item.state as RunState) : 'queued',
    trigger: str(item.trigger) ?? 'manual',
    findings: isRecord(item.findings) ? item.findings : null,
    waitingReason: str(item.waitingReason),
    error: str(item.error),
    startedAt: str(item.startedAt),
    finishedAt: str(item.finishedAt),
    createdAt: str(item.createdAt) ?? '',
  };
}

/** Accepts `[…]` or `{ runs: […] }` / `{ items: […] }` (same idiom as normalizeMissions). */
export function normalizeRuns(data: unknown): AgentRun[] {
  const raw = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.runs)
      ? data.runs
      : isRecord(data) && Array.isArray(data.items)
        ? data.items
        : [];
  const out: AgentRun[] = [];
  for (const item of raw) {
    const r = normalizeRun(item);
    if (r) out.push(r);
  }
  return out;
}

/**
 * POST /agents/missions/:id/run-check response → RunCheckResult. Tolerates a
 * bare run row, or a `{ run, findings?, changeSets?/changeSetIds? }` envelope
 * (the Stage F endpoint ships alongside this UI — keep both shapes working).
 * The shipped Stage F endpoint (WatcherService.runCheckNow, returned verbatim
 * by the controller) is `{ runId, findings, changeSetsProposed }`: no run ROW,
 * just its id — lift `runId` into a minimal run so the rail still gets
 * `run.id` (the row's other fields take normalizeRun's defaults; nothing
 * renders them off this path).
 */
export function normalizeRunCheck(data: unknown): RunCheckResult {
  const d = isRecord(data) ? data : {};
  const runId = str(d.runId);
  const run = isRecord(d.run)
    ? normalizeRun(d.run)
    : (normalizeRun(data) ?? (runId ? normalizeRun({ ...d, id: runId }) : null));
  const findings = extractRunFindings(d.findings !== undefined ? d.findings : run?.findings);
  const changeSetIds: string[] = [];
  const idArray = Array.isArray(d.changeSetIds)
    ? d.changeSetIds
    : Array.isArray(d.changeSetsProposed)
      ? d.changeSetsProposed
      : null;
  if (idArray) {
    for (const id of idArray) if (typeof id === 'string') changeSetIds.push(id);
  } else if (Array.isArray(d.changeSets)) {
    for (const cs of d.changeSets) {
      if (isRecord(cs) && typeof cs.id === 'string') changeSetIds.push(cs.id);
    }
  }
  return { run, findings, changeSetIds };
}

// ---- run findings -----------------------------------------------------------

function findingItem(v: unknown, code: string | null): RunFinding | null {
  if (typeof v === 'string' && v.trim() !== '') {
    return { code, severity: 'info', message: v.trim() };
  }
  if (!isRecord(v)) return null;
  const message = str(v.message) ?? str(v.text) ?? str(v.summary);
  if (!message) return null;
  const finding: RunFinding = {
    code: str(v.code) ?? code,
    // Verifier Violations use 'error'|'warning'; watcher findings use
    // 'info'|'warning'|'critical'. Fold 'critical' into the top display tier
    // so it keeps the critical-red dot instead of degrading to a gray info.
    severity:
      v.severity === 'error' || v.severity === 'critical'
        ? 'error'
        : v.severity === 'warning'
          ? 'warning'
          : 'info',
    message,
  };
  const suggestion = str(v.suggestion);
  if (suggestion) finding.suggestion = suggestion;
  if (Array.isArray(v.nodeIds)) {
    finding.nodeIds = v.nodeIds.filter((n): n is string => typeof n === 'string');
  }
  return finding;
}

/**
 * Flattens a run's findings JSON (sp_agent_run.findings — a free-shape object
 * the checks accumulate keys onto) into display-ready rows. Handles: a bare
 * array of verifier-Violation-shaped items, an object whose values are arrays
 * of items, and plain string values (rendered as info notes keyed by field).
 * `checkedOn` is envelope metadata (WatcherService persists
 * `{ checkedOn: 'YYYY-MM-DD', findings: […] }`), not a finding — skipped so a
 * bare date never renders as a stray info row.
 */
export function extractRunFindings(findings: unknown): RunFinding[] {
  const out: RunFinding[] = [];
  if (Array.isArray(findings)) {
    for (const v of findings) {
      const f = findingItem(v, null);
      if (f) out.push(f);
    }
    return out;
  }
  if (!isRecord(findings)) return out;
  for (const [key, value] of Object.entries(findings)) {
    if (key === 'checkedOn') continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        const f = findingItem(v, key);
        if (f) out.push(f);
      }
    } else {
      const f = findingItem(value, key);
      if (f) out.push(f);
    }
  }
  return out;
}

// ---- op → readable diff -----------------------------------------------------

export interface OpDiffChange {
  field: string;
  before: string | null;
  after: string;
}

export interface OpDiffView {
  verb: string;
  nodeTitle: string;
  /** op.nodeId set but absent from the CURRENT plan (moved since proposal). */
  unknownNode: boolean;
  changes: OpDiffChange[];
}

const OP_VERB: Record<string, string> = {
  add: 'Add step',
  update: 'Update',
  remove: 'Remove',
  retime: 'Re-time',
};

/** Field → display label, in render order. */
const DIFF_FIELDS: ReadonlyArray<[keyof ChangeSetOp, string]> = [
  ['title', 'Title'],
  ['kind', 'Type'],
  ['subject', 'Subject'],
  ['status', 'Status'],
  ['ownerUserId', 'Owner'],
  ['startsOn', 'Starts'],
  ['endsOn', 'Ends'],
  ['openEnded', 'Ongoing'],
  ['note', 'Notes'],
  ['dependsOn', 'Depends on'],
];

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return `${v.length} dependenc${v.length === 1 ? 'y' : 'ies'}`;
  const s = String(v);
  // Date-times → the date part (op dates are already YYYY-MM-DD).
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s;
}

/** The node's current value for an op field (before-side of the diff). */
function nodeValue(node: StrategyNode, field: keyof ChangeSetOp): unknown {
  switch (field) {
    case 'dependsOn':
      return node.dependsOnIds;
    default:
      return (node as unknown as Record<string, unknown>)[field];
  }
}

/**
 * Projects one proposed op onto a readable diff: verb + target step title +
 * field changes with before/after WHERE DERIVABLE. Before-values come from the
 * CURRENT plan's node (nodesById) — the proposal was pinned to an older head,
 * so a node that has since been deleted renders with unknownNode=true and no
 * before-side. Unchanged fields (op value === current value) are elided on
 * update/retime so the diff shows only what would actually move.
 */
export function opDiff(op: ChangeSetOp, nodesById: ReadonlyMap<string, StrategyNode>): OpDiffView {
  const node = op.nodeId ? nodesById.get(op.nodeId) : undefined;
  const isAdd = op.op === 'add';
  const changes: OpDiffChange[] = [];
  if (op.op !== 'remove') {
    for (const [field, label] of DIFF_FIELDS) {
      const v = op[field];
      if (v === undefined) continue;
      const after = fmt(v);
      if (isAdd || !node) {
        changes.push({ field: label, before: null, after });
        continue;
      }
      const before = fmt(nodeValue(node, field));
      if (before !== after) changes.push({ field: label, before, after });
    }
  }
  return {
    verb: OP_VERB[op.op] ?? op.op,
    nodeTitle: node?.title ?? op.title ?? 'Unknown step',
    unknownNode: Boolean(op.nodeId) && !node,
    changes,
  };
}

// ---- misc -------------------------------------------------------------------

/** HTTP status off a (duck-typed) axios error; null when absent. */
export function httpStatus(err: unknown): number | null {
  const s = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof s === 'number' ? s : null;
}

/**
 * True only for apply's STALE-HEAD 409. ChangeSetsService.apply 409s for two
 * DIFFERENT reasons: the version head moved since the proposal was pinned
 * ('plan changed since this was proposed — regenerate', or the already-marked
 * 'Change-set is stale — …' on a later attempt) vs. a concurrent reviewer
 * winning the race ('Change-set is applied/rejected — approve it before
 * applying'). Showing the Regenerate hint for the latter sends the loser off
 * to re-run a check against a plan that ALREADY contains the changes — so the
 * branch keys on the response BODY (the server's literals), not the status
 * code alone. A 409 whose body carries neither marker (proxy-stripped, older
 * server) falls through to the server's own message, never the stale hint.
 */
export function isStaleApplyConflict(err: unknown): boolean {
  return httpStatus(err) === 409 && /\bstale\b|plan changed/i.test(errorMessage(err, ''));
}

/**
 * Stage F Watch-rail visibility contract (same idiom as Stage E's
 * canExtractContextFacts). The Watch surface is gated server-side on BOTH
 * agenticMeri (class-level AgenticGuard on the missions routes) AND the
 * watcher-specific strategyWatcher flag (method-level StrategyWatcherGuard on
 * run-check, plus the F2 scheduler's per-occurrence flag check that skips
 * quietly). Rendering the rail on agenticMeri alone therefore yields a toggle
 * that flips a mission to "Watching" while every scheduled check silently
 * skips and every "Run check now" click 403s. Both feature bits are optional
 * (older cached /me shape) and degrade to hidden.
 */
export function canShowWatchRail(
  features: { agenticMeri?: boolean; strategyWatcher?: boolean } | undefined,
): boolean {
  return Boolean(features?.agenticMeri) && Boolean(features?.strategyWatcher);
}

/** The default per-strategy Watch mission name (create-if-absent contract). */
export const WATCH_MISSION_NAME = 'Keep this strategy on track';

/**
 * The default per-strategy Execution mission name (Stage G create-if-absent
 * contract). An execution run belongs to a mission (RunsService), so the editor
 * node-agent affordances provision this dedicated mandate on demand. It is
 * DISTINCT from WATCH_MISSION_NAME so the two finders never cross-match — a
 * strategy can carry both a Watch and an Execution mission at once.
 */
export const EXECUTION_MISSION_NAME = 'Execute this strategy';

/** A mission still open (not in a terminal state). */
function isLiveMission(m: AgentMission): boolean {
  return m.state !== 'canceled' && m.state !== 'completed' && m.state !== 'failed';
}

/**
 * The strategy's Watch mission: newest non-terminal mission pointing at it that
 * carries the Watch name. NAME-SCOPED so a Stage G Execution mission on the same
 * strategy is never mistaken for the Watch mission — without the name predicate
 * the Watch rail could pause / run-check the execution mandate. Every Watch
 * mission the rail mints uses WATCH_MISSION_NAME, so this is behaviour-preserving.
 */
export function findWatchMission(
  missions: readonly AgentMission[],
  strategyId: string,
): AgentMission | null {
  return (
    missions.find(
      (m) => m.strategyId === strategyId && m.name === WATCH_MISSION_NAME && isLiveMission(m),
    ) ?? null
  );
}

/**
 * The strategy's Execution mission: newest non-terminal mission pointing at it
 * that carries the Execution name (mirror of findWatchMission). The editor's
 * node-agent affordance resolves this, creating + activating one when absent so
 * the execution run has an active mission to anchor to.
 */
export function findExecutionMission(
  missions: readonly AgentMission[],
  strategyId: string,
): AgentMission | null {
  return (
    missions.find(
      (m) => m.strategyId === strategyId && m.name === EXECUTION_MISSION_NAME && isLiveMission(m),
    ) ?? null
  );
}

// ---- Stage G: execution runs ------------------------------------------------

const EXECUTION_TASK_TYPES: readonly ExecutionTaskType[] = [
  'workspace_draft',
  'outreach_record',
  'await_send_approval',
];
const EXECUTION_TASK_STATUSES: readonly ExecutionTaskStatus[] = [
  'planned',
  'staged',
  'awaiting_approval',
  'blocked',
  'done',
  'skipped',
];

/**
 * The Execution service stages per-task OUTCOME under findings.results[`nodeId:type`]
 * with its own status vocabulary (execution.service.ts runExecuting): a fresh
 * or idempotent stage is 'staged'/'already_staged', a parked send is
 * 'awaiting_send_approval', a do-not-contact block is 'blocked', and a
 * send skipped behind a blocked outreach is 'skipped'. Map those onto the
 * display statuses (both 'staged'/'already_staged' → the terminal 'staged').
 */
const RESULT_STATUS: Record<string, ExecutionTaskStatus> = {
  staged: 'staged',
  already_staged: 'staged',
  awaiting_send_approval: 'awaiting_approval',
  blocked: 'blocked',
  skipped: 'skipped',
  done: 'done',
};

/** A backend result-status OR an already-display status → display status | null. */
function coerceTaskStatus(v: unknown): ExecutionTaskStatus | null {
  if (typeof v !== 'string') return null;
  return (
    RESULT_STATUS[v] ??
    (EXECUTION_TASK_STATUSES.includes(v as ExecutionTaskStatus)
      ? (v as ExecutionTaskStatus)
      : null)
  );
}

/** Coerce a recipients value (string[] or {name|email}[] or a string) → string[]. */
function normalizeRecipients(v: unknown): string[] {
  const out: string[] = [];
  if (typeof v === 'string' && v.trim() !== '') {
    return v
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(v)) return out;
  for (const item of v) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item.trim());
    else if (isRecord(item)) {
      const label = str(item.name) ?? str(item.email) ?? str(item.label) ?? str(item.id);
      if (label) out.push(label);
    }
  }
  return out;
}

/** The staged send preview on an await_send_approval task (tolerant of shape). */
function normalizeSendPreview(v: unknown): SendApprovalPreview | null {
  if (!isRecord(v)) return null;
  return {
    subject: str(v.subject),
    body: str(v.body) ?? str(v.content) ?? str(v.html),
    recipients: normalizeRecipients(v.recipients),
    ask: str(v.ask),
    window: str(v.window) ?? str(v.sendWindow),
    approvalToken: str(v.approvalToken) ?? str(v.token),
    contentHash: str(v.contentHash),
    approvedContentHash: str(v.approvedContentHash),
  };
}

/**
 * The staged send preview as the Execution service actually parks it on
 * findings.sendApproval (execution.service.ts computeSendApproval): the
 * SendTokenInput lives under `input` (message / recipients / ask / windowStart
 * / windowEnd) alongside the run-bound `token` — NOT the flat subject/body/
 * window shape normalizeSendPreview accepts. The Stage-G shell stages a single
 * deterministic descriptor as `input.message` (real prose is the deferred Meri
 * seam), which we surface as the staged body; the two window bounds join into
 * one display range, and the sha256 `token` doubles as the content hash (no
 * prior approval exists in Stage G, so there is nothing to compare it against).
 */
function sendPreviewFromApproval(sa: Record<string, unknown>): SendApprovalPreview {
  const input = isRecord(sa.input) ? sa.input : {};
  const token = str(sa.token) ?? str(sa.approvalToken);
  const start = str(input.windowStart);
  const end = str(input.windowEnd);
  const window = start && end ? `${start} – ${end}` : (start ?? end);
  return {
    subject: str(input.subject),
    body: str(input.message) ?? str(input.body),
    recipients: normalizeRecipients(input.recipients),
    ask: str(input.ask),
    window,
    approvalToken: token,
    contentHash: str(sa.contentHash) ?? token,
    approvedContentHash: str(sa.approvedContentHash),
  };
}

/**
 * One execution task off the findings JSON; null when it is not task-shaped.
 * The reviewed plan item the backend parks is only `{ type, nodeId, detail }`
 * (execution.service.ts buildTasks) — the per-task OUTCOME (status /
 * artifactRef / blocked-reason) is staged separately under
 * findings.results[`nodeId:type`], and a pending send's preview under
 * findings.sendApproval. This reads those first, falling back to any INLINE
 * fields (title/status/artifactRef/send) so the tolerant shape the specs also
 * exercise keeps working.
 */
function normalizeExecutionTask(
  v: unknown,
  index: number,
  results: Record<string, unknown>,
  sendApproval: Record<string, unknown> | null,
): ExecutionTask | null {
  if (!isRecord(v)) return null;
  const type = EXECUTION_TASK_TYPES.includes(v.type as ExecutionTaskType)
    ? (v.type as ExecutionTaskType)
    : null;
  if (!type) return null;

  const nodeId = str(v.nodeId);
  const detail = isRecord(v.detail) ? v.detail : {};
  const resultVal = nodeId ? results[`${nodeId}:${type}`] : undefined;
  const result = isRecord(resultVal) ? resultVal : null;

  // await_send_approval preview: prefer the run-level findings.sendApproval the
  // backend actually stages; fall back to an inline send/outreach shape.
  const send =
    type === 'await_send_approval'
      ? sendApproval
        ? sendPreviewFromApproval(sendApproval)
        : normalizeSendPreview(v.send ?? v.outreach)
      : null;

  return {
    id: str(v.id) ?? `task-${index}`,
    type,
    nodeId,
    title:
      str(v.title) ??
      str(detail.docTitle) ??
      str(detail.title) ??
      str(detail.subject) ??
      str(send?.subject) ??
      'Untitled task',
    // Prefer the staged result status; unknown/absent degrades to 'planned'
    // (never a friction-free 'done').
    status: coerceTaskStatus(result?.status) ?? coerceTaskStatus(v.status) ?? 'planned',
    artifactRef: str(result?.artifactRef) ?? str(v.artifactRef) ?? str(v.ref),
    blockedReason: str(result?.reason) ?? str(v.blockedReason),
    send,
  };
}

/**
 * Flattens a run's findings JSON into the execution TASK list. Accepts a bare
 * `[…]` of tasks, or a `{ tasks: [...] }` / `{ items: [...] }` envelope (the
 * shape the Execution service parks on sp_agent_run.findings). Non-task values
 * are dropped — a Watcher run's finding rows never surface here.
 */
export function extractExecutionTasks(findings: unknown): ExecutionTask[] {
  const raw = Array.isArray(findings)
    ? findings
    : isRecord(findings) && Array.isArray(findings.tasks)
      ? findings.tasks
      : isRecord(findings) && Array.isArray(findings.items)
        ? findings.items
        : [];
  // The reviewed task list carries only { type, nodeId, detail }; the per-task
  // outcome is staged under findings.results and a pending send's preview under
  // findings.sendApproval — lift both so each task renders its REAL staged
  // state instead of a placeholder 'planned'/'Untitled task'.
  const results = isRecord(findings) && isRecord(findings.results) ? findings.results : {};
  const sendApproval =
    isRecord(findings) && isRecord(findings.sendApproval) ? findings.sendApproval : null;
  const out: ExecutionTask[] = [];
  raw.forEach((item, i) => {
    const t = normalizeExecutionTask(item, i, results, sendApproval);
    if (t) out.push(t);
  });
  return out;
}

/** The one-line execution summary the run parks alongside its tasks (if any). */
function executionRunSummary(findings: Record<string, unknown> | null): string | null {
  return str(findings?.summary) ?? str(findings?.plan);
}

/** One execution run: an AgentRun row projected with its tasks lifted out of findings. */
export function normalizeExecutionRun(item: unknown): ExecutionRun | null {
  const base = normalizeRun(item);
  if (!base) return null;
  return {
    id: base.id,
    missionId: base.missionId,
    strategyId: base.strategyId,
    state: base.state,
    trigger: base.trigger,
    waitingReason: base.waitingReason,
    error: base.error,
    summary: executionRunSummary(base.findings),
    tasks: extractExecutionTasks(base.findings),
    startedAt: base.startedAt,
    finishedAt: base.finishedAt,
    createdAt: base.createdAt,
  };
}

/** Accepts `[…]` or `{ runs: […] }` / `{ items: […] }` (same idiom as normalizeRuns). */
export function normalizeExecutionRuns(data: unknown): ExecutionRun[] {
  const raw = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.runs)
      ? data.runs
      : isRecord(data) && Array.isArray(data.items)
        ? data.items
        : [];
  const out: ExecutionRun[] = [];
  for (const item of raw) {
    const r = normalizeExecutionRun(item);
    if (r) out.push(r);
  }
  return out;
}

/**
 * A parked-run's waiting_for_input reason, classified for a CLEAR blocked state
 * (never a generic error). `sendApproval` is the safety-gate park (the staged
 * outreach awaits the — inert — send approval); the rest are eligibility
 * blockers the plan enumerates: version drift, ineligible node, an open
 * material Steward conflict, or a bearerless/system run that needs a human
 * session. The raw `reason` is always carried through verbatim for display.
 */
export type ExecutionBlockKind =
  | 'send_approval'
  | 'version_drift'
  | 'ineligible'
  | 'material_conflict'
  | 'interactive_session'
  | 'other';

export interface ExecutionBlock {
  kind: ExecutionBlockKind;
  /** Short label for the badge/heading. */
  label: string;
  /** The server's verbatim reason (falls back to a per-kind default). */
  reason: string;
}

export function classifyWaitingReason(reason: string | null): ExecutionBlock {
  const r = (reason ?? '').trim();
  const lc = r.toLowerCase();
  if (/awaiting send approval|send approval|await_send_approval/.test(lc)) {
    return { kind: 'send_approval', label: 'Awaiting send approval', reason: r };
  }
  if (/interactive session|requires.*session|needs a human|no bearer|bearerless/.test(lc)) {
    return {
      kind: 'interactive_session',
      label: 'Needs an interactive session',
      reason: r || 'Execution requires an interactive session.',
    };
  }
  if (/material conflict|steward conflict|open conflict|conflict/.test(lc)) {
    return {
      kind: 'material_conflict',
      label: 'Blocked by a material conflict',
      reason: r || 'An open material context conflict blocks execution.',
    };
  }
  if (/version|drift|changed since|stale plan|plan changed/.test(lc)) {
    return {
      kind: 'version_drift',
      label: 'Plan changed since planning',
      reason: r || 'The plan changed since this was planned.',
    };
  }
  if (/ineligible|not eligible|eligibility/.test(lc)) {
    return {
      kind: 'ineligible',
      label: 'Node is not execution-eligible',
      reason: r || 'This step is not eligible for execution.',
    };
  }
  return { kind: 'other', label: 'Waiting for input', reason: r || 'Waiting for input.' };
}

/** True when a run parked specifically on the (inert) send-approval gate. */
export function isAwaitingSendApproval(run: ExecutionRun): boolean {
  return (
    run.state === 'waiting_for_input' &&
    classifyWaitingReason(run.waitingReason).kind === 'send_approval'
  );
}

/** The await_send_approval task carrying the staged preview (first one wins). */
export function sendApprovalTask(run: ExecutionRun): ExecutionTask | null {
  return run.tasks.find((t) => t.type === 'await_send_approval' && t.send) ?? null;
}

/**
 * Whether a prior approval on a staged send is now INVALID because the content
 * changed since it was approved (the approval binds to a content hash). True
 * only when a prior approval existed AND the current hash differs — the Stage-H
 * re-approval trigger, surfaced today as a warning even though the control is
 * inert.
 */
export function isPriorApprovalInvalidated(send: SendApprovalPreview | null): boolean {
  return Boolean(
    send &&
      send.approvedContentHash &&
      send.contentHash &&
      send.approvedContentHash !== send.contentHash,
  );
}
