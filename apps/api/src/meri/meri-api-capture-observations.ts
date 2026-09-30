import { isDeepStrictEqual } from 'node:util';
import { MERI_CAPABILITY_REGISTRY, classifyApiToolReadOutcome } from '@capiro/shared';
import {
  notRun,
  observed,
  unknown,
  type MeriCaptureToolCallObservation,
  type MeriCaptureUsageObservation,
  type MeriServerReadonlyCapturePolicy,
} from '@capiro/meriv2-core';
import type { ToolRunOutcome } from './meri-tool-exec.helpers.js';

type UsageKey =
  'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens';
const USAGE_KEYS: UsageKey[] = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
];
type Round = {
  model: string | null;
  started: boolean;
  finished: boolean;
  usage: Partial<Record<UsageKey, number | null>>;
};
type Snapshot = { toolCalls: MeriCaptureToolCallObservation[]; usage: MeriCaptureUsageObservation };
const snapshots = new WeakMap<object, (policy: MeriServerReadonlyCapturePolicy) => Snapshot>();

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\s\x00-\x1f]/.test(value)
  );
}

export interface MeriApiCaptureObservations {
  /** Called immediately before the native Anthropic fetch, never from client metadata. */
  startAnthropicRequest(): (event: unknown) => void;
  recordTool(args: {
    callId: string;
    name: string;
    outcome: ToolRunOutcome<unknown> | undefined;
    sourceIds: string[];
    denied: boolean;
  }): void;
}

/** Each collector belongs to one already-bound server policy and one request closure. */
export function createMeriApiCaptureObservations(
  policy: MeriServerReadonlyCapturePolicy,
  currentPolicy: () => MeriServerReadonlyCapturePolicy | null,
): MeriApiCaptureObservations {
  const binding: MeriServerReadonlyCapturePolicy = {
    ...policy,
    expectedCaptureWrites: [...policy.expectedCaptureWrites],
  };
  const rounds: Round[] = [];
  const toolCalls: MeriCaptureToolCallObservation[] = [];
  const callIds = new Set<string>();
  const assertBinding = (candidate = currentPolicy()) => {
    if (
      !binding.turnId ||
      binding.expiresAt <= Date.now() ||
      !isDeepStrictEqual(binding, candidate) ||
      !isDeepStrictEqual(binding, currentPolicy())
    ) {
      throw new Error('meri_capture_observation_binding_mismatch');
    }
  };
  assertBinding(policy);
  const handle: MeriApiCaptureObservations = Object.freeze({
    startAnthropicRequest() {
      assertBinding();
      const round: Round = { model: null, started: false, finished: false, usage: {} };
      rounds.push(round);
      return (event: unknown) => {
        assertBinding();
        const evt = record(event);
        if (evt?.type === 'message_stop') {
          round.finished = round.started;
          return;
        }
        if (evt?.type !== 'message_start' && evt?.type !== 'message_delta') return;
        if (round.finished) {
          round.model = null;
          for (const key of USAGE_KEYS) round.usage[key] = null;
          return;
        }
        const message = record(evt.message);
        const usage = record(evt.type === 'message_start' ? message?.usage : evt.usage);
        if (evt.type === 'message_start') {
          // Multiple starts cannot silently replace identity or usage within one response.
          if (round.started) {
            round.model = null;
            for (const key of USAGE_KEYS) round.usage[key] = null;
            return;
          }
          round.started = true;
          round.model = identifier(message?.model) ? message.model : null;
        }
        for (const key of evt.type === 'message_start'
          ? USAGE_KEYS
          : (['output_tokens'] as UsageKey[])) {
          if (!usage || !(key in usage) || round.usage[key] === null) continue;
          const value = usage[key];
          round.usage[key] =
            typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
        }
      };
    },
    recordTool(args) {
      assertBinding();
      const capability = MERI_CAPABILITY_REGISTRY.find((entry) => entry.name === args.name);
      if (
        !identifier(args.callId) ||
        !capability ||
        callIds.has(args.callId) ||
        !args.outcome ||
        !Number.isSafeInteger(args.outcome.attempts) ||
        args.outcome.attempts < 1 ||
        !Array.isArray(args.sourceIds) ||
        args.sourceIds.some((id) => !identifier(id))
      ) {
        throw new Error('meri_capture_tool_observation_invalid');
      }
      callIds.add(args.callId);
      const status = args.denied
        ? 'denied'
        : !args.outcome.ok
          ? 'failed'
          : (classifyApiToolReadOutcome(args.name, args.outcome.result)?.kind ?? 'partial');
      // Unqualified legacy results remain partial; Promise resolution is not source completeness.
      toolCalls.push({
        callId: args.callId,
        name: args.name,
        attempt: args.outcome.attempts,
        status,
        readOnly: capability.readOnly,
        sourceIds: [...new Set(args.sourceIds)],
      });
    },
  });
  snapshots.set(handle, (candidate) => {
    assertBinding(candidate);
    const total = (key: UsageKey) => {
      if (!rounds.length) return notRun<number>('provider_request_not_observed');
      if (
        rounds.some(
          (round) =>
            !round.started ||
            (key === 'output_tokens' && !round.finished) ||
            typeof round.usage[key] !== 'number',
        )
      ) {
        return unknown<number>(`provider_${key}_not_reported_or_invalid`);
      }
      const sum = rounds.reduce((count, round) => count + (round.usage[key] as number), 0);
      return Number.isSafeInteger(sum) ? observed(sum) : unknown<number>('provider_usage_overflow');
    };
    const models = new Set(rounds.map((round) => round.model));
    return {
      toolCalls: toolCalls.map((call) => ({ ...call, sourceIds: [...call.sourceIds] })),
      usage: {
        provider: rounds.length ? observed('anthropic') : notRun('provider_request_not_observed'),
        model: !rounds.length
          ? notRun('provider_request_not_observed')
          : models.size === 1 && !models.has(null)
            ? observed(rounds[0].model!)
            : unknown('effective_provider_model_missing_or_mixed'),
        inputTokens: total('input_tokens'),
        outputTokens: total('output_tokens'),
        cacheReadTokens: total('cache_read_input_tokens'),
        cacheCreationTokens: total('cache_creation_input_tokens'),
        estimatedCostUsd: notRun('existing_pricing_adapter_not_bound_on_raw_path'),
        costKind: 'unknown',
      },
    };
  });
  return handle;
}

export function readMeriApiCaptureObservations(
  handle: MeriApiCaptureObservations,
  policy: MeriServerReadonlyCapturePolicy,
): Snapshot {
  const read = snapshots.get(handle);
  if (!read) throw new Error('meri_capture_observation_owner_missing');
  return read(policy);
}
