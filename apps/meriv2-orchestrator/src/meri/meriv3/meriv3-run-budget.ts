import { createHash } from 'node:crypto';

export type MeriModelBudgetPhase =
  'acquisition' | 'selection' | 'repair' | 'synthesis' | 'finalization' | 'shadow';

export type MeriRunBudgetStopReason =
  'cancelled' | 'deadline' | 'model_calls' | 'tool_calls' | 'retry_calls' | 'no_progress';

export interface MeriRunBudgetLimits {
  maxModelCalls: number;
  maxToolCalls: number;
  maxRetryCalls: number;
  synthesisModelCallReserve: number;
  noProgressLaps: number;
  maxCyclePeriod: number;
}

export interface MeriToolSignatureScope {
  actorId: string;
  tenantId: string;
  clientId: string | null;
  conversationId: string | null;
  runId: string | null;
}

export interface MeriRunBudgetSnapshot {
  modelCalls: number;
  toolCalls: number;
  retryCalls: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxRetryCalls: number;
  acquisitionStopped: boolean;
  stopReason: MeriRunBudgetStopReason | null;
}

export class MeriRunBudgetExhaustedError extends Error {
  readonly name = 'MeriRunBudgetExhaustedError';

  constructor(readonly reason: MeriRunBudgetStopReason) {
    super(`Meri runtime acquisition stopped: ${reason}`);
  }
}

interface FailureObservation {
  signature: string;
  resultHash: string;
  repeatable: boolean;
}

const SYNTHESIS_PHASES = new Set<MeriModelBudgetPhase>(['synthesis', 'finalization']);
const TERMINAL_CONTROL_REASONS = new Set<MeriRunBudgetStopReason>(['cancelled', 'deadline']);
const REVISION_KEYS =
  /(?:^|_)(?:source|artifact|content|record)?(?:revision|version|hash|etag)(?:$|_)/i;

/**
 * Request-local aggregate controller for the served MeriV3 turn.
 *
 * Counts are admission controls, not billing records. A provider batch is
 * admitted atomically before any member dispatches, so concurrent execution
 * cannot oversubscribe the turn even though the current executor is ordered.
 */
export class MeriRunBudget {
  private modelCalls = 0;
  private toolCalls = 0;
  private retryCalls = 0;
  private stopReason: MeriRunBudgetStopReason | null = null;
  private readonly toolAttempts = new Map<string, number>();
  private readonly failureHistory: FailureObservation[] = [];

  constructor(
    readonly limits: MeriRunBudgetLimits,
    private readonly control: { signal?: AbortSignal; deadlineAt?: number } = {},
  ) {}

  static fromToolRoundCeiling(
    maxToolRounds: number,
    control: { signal?: AbortSignal; deadlineAt?: number } = {},
  ): MeriRunBudget {
    const rounds = Math.max(1, Math.floor(maxToolRounds));
    return new MeriRunBudget(
      {
        // Existing provider rounds remain the acquisition ceiling. Three calls
        // are retained for forced synthesis / Research Director finalization.
        maxModelCalls: rounds + 3,
        synthesisModelCallReserve: 3,
        // Existing automatic document, coverage and repair ceilings remain
        // feasible while every path now shares one finite aggregate ceiling.
        maxToolCalls: rounds * 4 + 24 + 8 + 3,
        // Four retries permit the three-lap A/B observation needed to identify
        // an alternating unchanged-failure cycle before the retry ceiling wins.
        maxRetryCalls: Math.max(4, Math.ceil(rounds / 2)),
        noProgressLaps: 3,
        maxCyclePeriod: 4,
      },
      control,
    );
  }

  get acquisitionStopped(): boolean {
    this.observeControl();
    return this.stopReason !== null;
  }

  get reason(): MeriRunBudgetStopReason | null {
    this.observeControl();
    return this.stopReason;
  }

  snapshot(): MeriRunBudgetSnapshot {
    this.observeControl();
    return {
      modelCalls: this.modelCalls,
      toolCalls: this.toolCalls,
      retryCalls: this.retryCalls,
      maxModelCalls: this.limits.maxModelCalls,
      maxToolCalls: this.limits.maxToolCalls,
      maxRetryCalls: this.limits.maxRetryCalls,
      acquisitionStopped: this.stopReason !== null,
      stopReason: this.stopReason,
    };
  }

  reserveModelAttempt(phase: MeriModelBudgetPhase, retry = false): void {
    this.assertControlActive();
    const synthesis = SYNTHESIS_PHASES.has(phase);
    if (!synthesis && this.stopReason !== null)
      throw new MeriRunBudgetExhaustedError(this.stopReason);
    const ceiling = synthesis
      ? this.limits.maxModelCalls
      : Math.max(0, this.limits.maxModelCalls - this.limits.synthesisModelCallReserve);
    if (this.modelCalls >= ceiling) {
      if (!synthesis) this.close('model_calls');
      throw new MeriRunBudgetExhaustedError('model_calls');
    }
    if (retry) this.reserveRetry();
    this.modelCalls += 1;
  }

  budgetedFetch(
    phase: MeriModelBudgetPhase,
    fetchImpl: typeof fetch = globalThis.fetch,
  ): typeof fetch {
    return ((...args: Parameters<typeof fetch>) => {
      this.reserveModelAttempt(phase);
      return fetchImpl(...args);
    }) as typeof fetch;
  }

  /** Admit a provider-emitted batch atomically before any call can dispatch. */
  reserveToolBatch(size: number): boolean {
    this.observeControl();
    if (this.stopReason !== null) return false;
    const count = Math.max(0, Math.floor(size));
    if (this.toolCalls + count > this.limits.maxToolCalls) {
      this.close('tool_calls');
      return false;
    }
    this.toolCalls += count;
    return true;
  }

  /** Record a dispatch attempt after the batch has been admitted. */
  beginTool(signature: string): boolean {
    this.observeControl();
    if (this.stopReason !== null) return false;
    const attempts = this.toolAttempts.get(signature) ?? 0;
    if (attempts > 0) {
      try {
        this.reserveRetry();
      } catch {
        return false;
      }
    }
    this.toolAttempts.set(signature, attempts + 1);
    return true;
  }

  observeToolResult(input: {
    signature: string;
    result: unknown;
    failed: boolean;
    repeatable?: boolean;
  }): void {
    if (!input.failed) {
      // A successful changed page/read is progress and breaks a trailing failure cycle.
      this.failureHistory.length = 0;
      return;
    }
    this.failureHistory.push({
      signature: input.signature,
      resultHash: hashCanonical(input.result),
      repeatable: input.repeatable === true,
    });
    const maxHistory = this.limits.noProgressLaps * this.limits.maxCyclePeriod * 2;
    if (this.failureHistory.length > maxHistory) {
      this.failureHistory.splice(0, this.failureHistory.length - maxHistory);
    }
    if (this.detectFailureCycle()) this.close('no_progress');
  }

  toolSignature(
    scope: MeriToolSignatureScope,
    tool: string,
    validatedArgs: Record<string, unknown>,
  ): string {
    return hashCanonical({
      scope,
      tool,
      validatedArgs,
      relevantRevision: collectRevisions(validatedArgs),
    });
  }

  partialInstruction(): string {
    const reason = this.reason ?? 'tool_calls';
    return [
      `Runtime acquisition stopped at the bounded ${reason.replaceAll('_', ' ')} limit.`,
      'Do not call or imply that any additional tool ran.',
      'Return a supported partial answer from retained evidence, and identify requested work that remains uncompleted.',
    ].join(' ');
  }

  private reserveRetry(): void {
    if (this.retryCalls >= this.limits.maxRetryCalls) {
      this.close('retry_calls');
      throw new MeriRunBudgetExhaustedError('retry_calls');
    }
    this.retryCalls += 1;
  }

  private detectFailureCycle(): boolean {
    const history = this.failureHistory;
    for (let period = 1; period <= this.limits.maxCyclePeriod; period += 1) {
      const needed = period * this.limits.noProgressLaps;
      if (history.length < needed) continue;
      const tail = history.slice(-needed);
      let repeated = true;
      for (let index = period; index < tail.length; index += 1) {
        const left = tail[index]!;
        const right = tail[index % period]!;
        if (left.signature !== right.signature || left.resultHash !== right.resultHash) {
          repeated = false;
          break;
        }
      }
      if (repeated && !tail.slice(-period).every((item) => item.repeatable)) return true;
    }
    return false;
  }

  private observeControl(): void {
    if (this.control.signal?.aborted) this.close('cancelled');
    else if (this.control.deadlineAt !== undefined && Date.now() >= this.control.deadlineAt) {
      this.close('deadline');
    }
  }

  private assertControlActive(): void {
    this.observeControl();
    if (this.stopReason === 'cancelled' || this.stopReason === 'deadline') {
      throw new MeriRunBudgetExhaustedError(this.stopReason);
    }
  }

  private close(reason: MeriRunBudgetStopReason): void {
    if (this.stopReason !== null && TERMINAL_CONTROL_REASONS.has(this.stopReason)) return;
    if (TERMINAL_CONTROL_REASONS.has(reason) || this.stopReason === null) this.stopReason = reason;
  }
}

export function isLogicalToolFailure(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const value = result as Record<string, unknown>;
  return (
    value.error === true ||
    typeof value.error === 'string' ||
    value.success === false ||
    value.ok === false ||
    value.status === 'failed' ||
    value.status === 'error'
  );
}

/** Pending poll observations are repeatable; changed cursors remain distinct signatures. */
export function isLegitimatePollingObservation(
  args: Record<string, unknown>,
  result: unknown,
): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const record = result as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
  const hasPollIdentity = ['pollToken', 'jobId', 'operationId', 'taskId'].some(
    (key) => typeof args[key] === 'string' && String(args[key]).length > 0,
  );
  const hasPollContinuation =
    typeof record.nextPollAfterMs === 'number' ||
    typeof record.retryAfterMs === 'number' ||
    typeof record.pollToken === 'string';
  return (
    hasPollIdentity && hasPollContinuation && ['pending', 'running', 'queued'].includes(status)
  );
}

function collectRevisions(value: unknown, path = '$'): Array<{ path: string; value: unknown }> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectRevisions(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
    const nextPath = `${path}.${key}`;
    return REVISION_KEYS.test(key)
      ? [{ path: nextPath, value: canonicalValue(nested) }]
      : collectRevisions(nested, nextPath);
  });
}

function hashCanonical(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}
