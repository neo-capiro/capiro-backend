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
 */
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
