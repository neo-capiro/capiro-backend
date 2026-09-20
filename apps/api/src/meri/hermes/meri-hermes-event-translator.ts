/**
 * Translate Hermes `/v1/runs/{id}/events` wire frames (pinned build v2026.9.14)
 * into (a) Meri's durable sequenced run events and (b) the SSE frames the
 * existing Meri web client already understands (`SseEvent` union in
 * apps/web/src/components/chat/useMeriChatController.ts).
 *
 * Rules:
 *  - Private reasoning is NEVER forwarded (`reasoning.available` is dropped).
 *  - Tool previews are already secret-redacted by Hermes; they are still
 *    truncated here and never persisted as authoritative results.
 *  - Native approvals become `pending_approval` frames marked `runtime: 'hermes'`
 *    so the dev harness / a Phase 1 UI can route the decision to
 *    POST /api/clio/hermes/runs/:runId/approval. They are NOT MeriActionProposal
 *    rows; that mapping is Phase 1 work (see contracts.md).
 *  - Terminal wire events produce a Meri terminal status; the adapter decides
 *    what to persist.
 *  - Record-level CITATIONS are translated from the run's own durable
 *    `memory.recalled` events, not from wire frames — see the A8 section at the
 *    bottom of this file.
 */
import type { MeriCitation } from '@capiro/shared';
import {
  HERMES_WIRE_TERMINAL_STATUSES,
  type HermesWireEvent,
  type MeriHermesFinishReason,
  type MeriHermesRunEventKind,
  type MeriHermesRunStatus,
  type MeriHermesUsage,
  type MeriSseFrame,
} from './hermes-runtime.contracts.js';

export interface HermesTranslationContext {
  meriRunId: string;
  /** Wall-clock for approval expiry defaults (Hermes approvals.timeout, default 300s). */
  approvalTimeoutSeconds?: number;
  now?: () => Date;
}

export interface HermesTranslation {
  /** Meri durable event to append (null = ignore the wire frame entirely). */
  event: {
    kind: MeriHermesRunEventKind;
    visibility: 'public' | 'internal';
    payload: Record<string, unknown>;
  } | null;
  /** Browser-facing frames (may be empty). */
  frames: MeriSseFrame[];
  status: MeriHermesRunStatus | null;
  terminal: {
    finishReason: MeriHermesFinishReason;
    partial: boolean;
    output: string | null;
    error: string | null;
  } | null;
  usage: MeriHermesUsage | null;
  /** Text delta to accumulate into the assistant body. */
  textDelta: string | null;
  pendingInteraction: {
    requestId: string;
    prompt: string;
    choices: string[];
    expiresAt: string | null;
  } | null;
}

const PREVIEW_MAX = 500;

function str(value: unknown, max = PREVIEW_MAX): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function toolLabel(tool: string): string {
  return tool.replace(/[_-]+/g, ' ').trim() || 'tool';
}

const empty = (): HermesTranslation => ({
  event: null,
  frames: [],
  status: null,
  terminal: null,
  usage: null,
  textDelta: null,
  pendingInteraction: null,
});

export function translateHermesWireEvent(
  wire: HermesWireEvent,
  ctx: HermesTranslationContext,
): HermesTranslation {
  const out = empty();
  const name = wire.event;
  switch (name) {
    case 'message.delta': {
      const delta = typeof wire.delta === 'string' ? wire.delta : '';
      if (!delta) return out;
      out.textDelta = delta;
      out.frames.push({ type: 'text', text: delta });
      out.event = { kind: 'message.delta', visibility: 'public', payload: { delta } };
      return out;
    }
    case 'tool.started': {
      const tool = str(wire.tool, 120) || 'tool';
      out.frames.push({ type: 'tool_call', tool, label: toolLabel(tool) });
      out.event = {
        kind: 'tool.started',
        visibility: 'public',
        payload: { tool, preview: str(wire.preview) },
      };
      out.status = 'running';
      return out;
    }
    case 'tool.completed': {
      const tool = str(wire.tool, 120) || 'tool';
      const isError = wire.error === true;
      out.frames.push({
        type: 'sources',
        sources: [
          {
            tool,
            label: toolLabel(tool),
            count: null,
            summary: isError
              ? 'Tool reported an error.'
              : `Completed in ${Number(wire.duration ?? 0)}s.`,
            confidence: isError ? 'low' : 'high',
          },
        ],
      });
      out.event = {
        kind: 'tool.completed',
        visibility: 'public',
        payload: {
          tool,
          durationSeconds: Number(wire.duration ?? 0),
          error: isError,
          preview: str(wire.preview),
        },
      };
      return out;
    }
    case 'subagent.start': {
      out.frames.push({ type: 'tool_call', tool: 'delegate_task', label: 'delegate task' });
      out.event = {
        kind: 'subagent.started',
        visibility: 'public',
        payload: {
          goal: str(wire.goal),
          taskCount: wire.task_count ?? null,
          subagentId: wire.subagent_id ?? null,
        },
      };
      return out;
    }
    case 'subagent.complete': {
      out.frames.push({
        type: 'sources',
        sources: [
          {
            tool: 'delegate_task',
            label: 'delegate task',
            count: null,
            summary: str(wire.summary, 240) || 'Subagent finished.',
            confidence: wire.status === 'failed' ? 'low' : 'high',
          },
        ],
      });
      out.event = {
        kind: 'subagent.completed',
        visibility: 'public',
        payload: {
          status: wire.status ?? null,
          summary: str(wire.summary),
          durationSeconds: wire.duration_seconds ?? null,
          inputTokens: wire.input_tokens ?? null,
          outputTokens: wire.output_tokens ?? null,
          costUsd: wire.cost_usd ?? null,
        },
      };
      return out;
    }
    case 'reasoning.available':
      // Private reasoning never leaves the runtime boundary.
      return out;
    case 'approval.request': {
      const requestId = str(wire.request_id, 200) || `hermes-approval-${Date.now()}`;
      const description =
        str(wire.description, 300) || 'Hermes requests approval for a guarded action.';
      const command = str(wire.command, 400);
      const choices = Array.isArray(wire.choices)
        ? wire.choices.map((c) => String(c))
        : ['once', 'deny'];
      const now = (ctx.now ?? (() => new Date()))();
      const expiresAt = new Date(
        now.getTime() + (ctx.approvalTimeoutSeconds ?? 300) * 1000,
      ).toISOString();
      const proposalId = `hermes:${ctx.meriRunId}:${requestId}`;
      out.frames.push({
        type: 'pending_approval',
        runtime: 'hermes',
        tool: 'terminal',
        label: description,
        proposalId,
        status: 'proposed',
        reason: description,
        expiresAt,
        riskTier: 'native_hermes_approval',
        policyCode: 'HERMES_NATIVE_APPROVAL',
        ruleId: null,
        policy: {
          source: 'hermes',
          mode: 'native',
          packKey: 'hermes-native',
          packVersion: 'v2026.9.14',
          binding: 'run',
          decisionHash: '',
          contextHash: '',
          decision: 'WARN',
          jurisdiction: 'worker',
          channel: 'terminal',
          recipientType: null,
        },
        preview: {
          label: description,
          riskTier: 'native_hermes_approval',
          leavesFirm: false,
          reversible: false,
          fields: command ? { command } : {},
          counts: {},
          reason: description,
        },
        interaction: { requestId, choices, continuation: 'live_process' },
      });
      out.status = 'waiting_for_approval';
      out.pendingInteraction = {
        requestId,
        prompt: command ? `${description}\n\n${command}` : description,
        choices,
        expiresAt,
      };
      out.event = {
        kind: 'approval.requested',
        visibility: 'public',
        payload: { requestId, description, command, choices, expiresAt },
      };
      return out;
    }
    case 'approval.responded': {
      out.status = 'running';
      out.event = {
        kind: 'approval.resolved',
        visibility: 'public',
        payload: {
          requestId: wire.request_id ?? null,
          choice: wire.choice ?? null,
          resolved: wire.resolved ?? null,
        },
      };
      return out;
    }
    case 'run.steered': {
      out.event = {
        kind: 'steer.accepted',
        visibility: 'internal',
        payload: { accepted: wire.accepted === true },
      };
      return out;
    }
    case 'run.stopping': {
      out.status = 'cancelling';
      out.event = { kind: 'run.status', visibility: 'public', payload: { status: 'cancelling' } };
      return out;
    }
    case 'run.completed': {
      const usage = readUsage(wire.usage);
      const output = typeof wire.output === 'string' ? wire.output : null;
      out.status = 'completed';
      out.usage = usage;
      out.terminal = { finishReason: 'stop', partial: false, output, error: null };
      if (usage) {
        out.frames.push({
          type: 'usage',
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          },
        });
      }
      out.event = {
        kind: 'run.completed',
        visibility: 'public',
        payload: {
          usage,
          outputChars: output?.length ?? 0,
          pendingSteer: wire.pending_steer ?? null,
        },
      };
      return out;
    }
    case 'run.failed': {
      const error = str(wire.error, 600) || 'Hermes run failed.';
      out.status = 'failed';
      out.terminal = { finishReason: 'error', partial: true, output: null, error };
      out.frames.push({ type: 'error', message: error });
      out.event = { kind: 'run.failed', visibility: 'public', payload: { error } };
      return out;
    }
    case 'run.cancelled': {
      out.status = 'cancelled';
      out.terminal = { finishReason: 'aborted', partial: true, output: null, error: null };
      out.event = { kind: 'run.cancelled', visibility: 'public', payload: {} };
      return out;
    }
    case 'run.interrupted': {
      out.status = 'interrupted';
      out.terminal = {
        finishReason: 'interrupted',
        partial: true,
        output: null,
        error: 'Hermes worker was interrupted.',
      };
      out.event = { kind: 'run.interrupted', visibility: 'public', payload: {} };
      return out;
    }
    default:
      // Unknown frames are recorded internally so a build upgrade is visible
      // in the run log, but never invented into UI progress.
      out.event = {
        kind: 'run.status',
        visibility: 'internal',
        payload: { unknownWireEvent: name },
      };
      return out;
  }
}

export function isHermesTerminalStatus(status: string | undefined): boolean {
  return Boolean(status && HERMES_WIRE_TERMINAL_STATUSES.has(status));
}

export function readUsage(raw: unknown): MeriHermesUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const total = num(u.total_tokens) || input + output;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    costUsd: typeof u.cost_usd === 'number' ? u.cost_usd : null,
  };
}

// ---------------------------------------------------------------------------
// A8 — record-level citations from governed recall
//
// P1-08's vertical-slice criterion is "performs a permitted broker read, emits
// supported progress/CITATIONS and saves one final response". Until this
// section existed the Hermes path emitted only the `tool.completed ->
// {type:'sources'}` trust-step frame above: tool PROVENANCE (a tool ran, it
// took 0.4s), not a record-level citation. V3 answers cite their sources, so a
// Hermes answer was a visible regression against "preserve the existing Meri
// experience".
//
// The contract produced here is the SAME one V3 produces — `MeriCitation` from
// @capiro/shared, persisted as `metadata.citations` on the assistant
// ClioMessage and emitted as `{type:'citations', citations}` — so the existing
// consumers (source chips in ChatMessage.tsx, the source drawer via
// meri-source-api.ts, MeriConversationEvidenceService) work unchanged. No
// frontend change is required: `citationSourceLabel` falls through to
// `citationTypeLabel(type)` for an unrecognised tool, and `meriSourceLocator`
// resolves `type: 'memory'` (or an explicit `source.kind === 'memory'`) to the
// memory source reader.
//
// WHERE THE DATA COMES FROM, AND WHY IT IS SAFE TO CITE.
// The only authorization-filtered, record-level read the Phase 1 runtime has is
// the broker's governed recall (`meri_memory_search` ->
// `MeriHermesBrokerService.recall()` -> `ContextPlaneRecallPort` -> the
// canonical institutional-knowledge rail). Its `MeriHermesRecallItem`s are
// exactly the records that survived tenant RLS, owner visibility, the ethical
// wall, governed-status filtering and the F-1 pre-release recheck. Citations
// are built from THOSE ITEMS AND NOTHING ELSE:
//
//   - the set is never widened (no re-query, no fallback to the query text, no
//     synthesising a source from a tool name or from `coverage.total`);
//   - a recall that returned no items produces no citation, so a tool call that
//     found nothing can never be dressed up as a source;
//   - an item without a real `sourceId` is dropped rather than given a
//     placeholder id.
//
// Because the recall result is already authorization-filtered, a record the
// envelope did not authorize is absent from `items` and therefore absent from
// the citations — the filter is inherited here, never re-implemented or
// widened.
//
// WHY THE RUN EVENT AND NOT THE HTTP RESPONSE. `recall()` returns its payload
// over HTTP to the Hermes worker, in a different process and possibly against a
// different API replica than the one consuming the run event stream and
// finalizing the turn. The durable `memory.recalled` run event is the only
// replica-agnostic record of the read, so it is the citation source of truth.
// ---------------------------------------------------------------------------

/** Durable run-event kind appended by `MeriHermesBrokerService.recall()`. */
export const HERMES_RECALL_EVENT_KIND = 'memory.recalled';

/** Broker tool whose governed result becomes a citation. */
export const HERMES_RECALL_TOOL = 'meri_memory_search';

/**
 * `MeriCitation.type` for an institutional-memory record. Matches the label the
 * web source reader keys on (`citation.type === 'memory'` ->
 * `{kind:'memory'}`), so the drawer opens the right reader for a Hermes answer.
 */
export const HERMES_RECALL_CITATION_TYPE = 'memory';

/**
 * Per-recall cap, matching `extractCitationsFromToolResult`'s `maxPerTool`
 * default on the V3 path so one chatty read cannot dominate the source strip.
 */
export const HERMES_MAX_CITATIONS_PER_RECALL = 5;

/**
 * Per-run cap. `budget.maxToolCalls` is 40, so an uncapped run could persist
 * 200 citations into one message metadata blob. The drawer renders four chips
 * and a "+N more" counter, so this bound is generous for the UI while keeping
 * `metadata.citations` a bounded column value.
 */
export const HERMES_MAX_CITATIONS_PER_RUN = 25;

const CITATION_SNIPPET_MAX = 240;
const CITATION_TITLE_MAX = 200;

/** The shape this module reads out of a durable run event. */
export interface HermesCitableRunEvent {
  kind: string;
  payload: Record<string, unknown>;
}

function citationText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * One `MeriHermesRecallItem` -> one `MeriCitation`, or null when the item
 * carries no real record identity. Returning null rather than a placeholder is
 * the no-fabrication rule: a citation whose `id` is invented is worse than no
 * citation, because the drawer would offer to open a record that does not
 * exist.
 */
export function citationFromRecallItem(item: unknown, n: number): MeriCitation | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const row = item as Record<string, unknown>;
  const sourceId = typeof row.sourceId === 'string' ? row.sourceId.trim() : '';
  if (!sourceId) return null;
  const clientId =
    typeof row.clientId === 'string' && row.clientId.trim() ? row.clientId.trim() : null;
  const observedAt =
    typeof row.updatedAt === 'string' && row.updatedAt.trim() ? row.updatedAt.trim() : null;
  return {
    n,
    type: HERMES_RECALL_CITATION_TYPE,
    id: sourceId,
    // The recall port already resolves a title (`payload.key ?? payload.title ??
    // recordId`), so a missing one means a malformed item; fall back to the
    // record id rather than inventing prose for it.
    title: citationText(row.title, CITATION_TITLE_MAX) ?? sourceId,
    // Institutional memory has no external URL. V3 writes null in the same
    // situation, and a URL must never be guessed.
    url: null,
    snippet: citationText(row.excerpt, CITATION_SNIPPET_MAX),
    tool: HERMES_RECALL_TOOL,
    source: {
      kind: 'memory' as const,
      recordId: sourceId,
      ...(clientId ? { clientId } : {}),
      ...(observedAt ? { observedAt } : {}),
    },
  };
}

/**
 * Build the turn citations from a run durable event log.
 *
 * Numbering is global and 1-based across the whole run, in event order then
 * item order, exactly as the V3 loop numbers across a turn tool results.
 * Repeat recalls that return the same record are deduplicated by `sourceId`,
 * keeping the first (lowest) number, so asking twice does not double-count one
 * source.
 *
 * Note that `[N]` markers are NOT validated against the answer text here, and
 * deliberately so. On the V3 path the model is handed
 * `formatCitationsForPrompt(...)` inside the tool result and therefore writes
 * `[N]` markers, which `validateCitationMarkers` then filters on. The Hermes
 * worker memory tool does not inject that block (doing so is a worker/broker
 * side change, not one this module can make), so the answer contains no markers
 * and marker-filtering would discard every real source. The source strip and
 * the drawer render from the citation LIST, not from markers, so the sources
 * still surface; inline markers become available for free if the worker later
 * injects the citable-sources block.
 */
export function hermesCitationsFromRunEvents(
  events: readonly HermesCitableRunEvent[],
): MeriCitation[] {
  const out: MeriCitation[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.kind !== HERMES_RECALL_EVENT_KIND) continue;
    const items = event.payload?.items;
    // A recall event with no `items` array (a recall that returned nothing, or
    // an event written before items were recorded) contributes nothing.
    if (!Array.isArray(items)) continue;
    let fromThisRecall = 0;
    for (const item of items) {
      if (out.length >= HERMES_MAX_CITATIONS_PER_RUN) return out;
      if (fromThisRecall >= HERMES_MAX_CITATIONS_PER_RECALL) break;
      const citation = citationFromRecallItem(item, out.length + 1);
      if (!citation) continue;
      if (seen.has(citation.id)) continue;
      seen.add(citation.id);
      out.push(citation);
      fromThisRecall += 1;
    }
  }
  return out;
}

/**
 * The SSE frame the existing Meri web client already consumes
 * (`{ type: 'citations'; citations?: MeriCitation[] }` in
 * useMeriChatController.ts -> `setChatMessageCitations`). Null when there is
 * nothing to cite, matching the V3 `if (used.length)` guard — an empty frame
 * would clear citations the client had already rendered.
 */
export function hermesCitationsFrame(citations: readonly MeriCitation[]): MeriSseFrame | null {
  if (!citations.length) return null;
  return { type: 'citations', citations: [...citations] };
}
