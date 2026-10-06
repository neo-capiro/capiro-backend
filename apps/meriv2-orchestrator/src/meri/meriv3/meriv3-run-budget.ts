import { createHash, randomUUID } from 'node:crypto';
import { JEV_TASK_REGISTRY } from '@capiro/meriv2-core';

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

export type MeriProviderAttemptKind = 'openai_responses' | 'anthropic_messages' | 'jev';

export interface MeriProviderAttemptBinding {
  logicalOperationId: string;
  attemptId: string;
  retryOfAttemptId: string | null;
  kind: MeriProviderAttemptKind;
  phase: MeriModelBudgetPhase;
  provider: string;
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number | null;
}

export interface MeriProviderReservation extends MeriProviderAttemptBinding {
  reservationId: string;
  deadlineAt: string;
}

export interface MeriDurableProviderAccounting {
  reserve: (binding: MeriProviderAttemptBinding) => Promise<{
    reservationId: string;
    dispatchAllowed: boolean;
    deadlineAt: string;
  }>;
  settle: (
    reservation: MeriProviderReservation,
    outcome:
      | { kind: 'known'; inputTokens: number; outputTokens: number }
      | { kind: 'rejected' }
      | { kind: 'uncertain' },
  ) => Promise<void>;
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
  /** Successful, non-polling reads of this turn, by signature: the provider call that produced each. */
  private readonly settledReads = new Map<string, string>();
  private readonly failureHistory: FailureObservation[] = [];

  constructor(
    readonly limits: MeriRunBudgetLimits,
    private readonly control: { signal?: AbortSignal; deadlineAt?: number } = {},
    private readonly providerAccounting?: MeriDurableProviderAccounting,
  ) {}

  static fromToolRoundCeiling(
    maxToolRounds: number,
    control: { signal?: AbortSignal; deadlineAt?: number } = {},
    providerAccounting?: MeriDurableProviderAccounting,
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
      providerAccounting,
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

  async reserveProviderAttempt(
    input: Omit<
      MeriProviderAttemptBinding,
      'attemptId' | 'logicalOperationId' | 'retryOfAttemptId'
    > & {
      logicalOperationId?: string;
      attemptId?: string;
      retryOfAttemptId?: string | null;
      retry?: boolean;
    },
  ): Promise<MeriProviderReservation | null> {
    this.reserveModelAttempt(input.phase, input.retry === true);
    if (!this.providerAccounting) return null;
    const attemptId = input.attemptId ?? randomUUID();
    const binding: MeriProviderAttemptBinding = {
      logicalOperationId: input.logicalOperationId ?? attemptId,
      attemptId,
      retryOfAttemptId: input.retryOfAttemptId ?? null,
      kind: input.kind,
      phase: input.phase,
      provider: input.provider,
      model: input.model,
      maxInputTokens: input.maxInputTokens,
      maxOutputTokens: input.maxOutputTokens,
    };
    const reserved = await this.providerAccounting.reserve(binding);
    if (!reserved.dispatchAllowed) throw new MeriRunBudgetExhaustedError('model_calls');
    return { ...binding, reservationId: reserved.reservationId, deadlineAt: reserved.deadlineAt };
  }

  async settleProviderAttempt(
    reservation: MeriProviderReservation | null,
    outcome:
      | { kind: 'known'; inputTokens: number; outputTokens: number }
      | { kind: 'rejected' }
      | { kind: 'uncertain' },
  ): Promise<void> {
    if (reservation && this.providerAccounting)
      await this.providerAccounting.settle(reservation, outcome);
  }

  budgetedFetch(
    phase: MeriModelBudgetPhase,
    fetchImpl: typeof fetch = globalThis.fetch,
  ): typeof fetch {
    const attempts = new Map<string, { count: number; previousAttemptId: string | null }>();
    return (async (...args: Parameters<typeof fetch>) => {
      const fetchBudget = providerFetchBudgetInput(args, phase);
      const operationState = attempts.get(fetchBudget.logicalOperationId) ?? {
        count: 0,
        previousAttemptId: null,
      };
      const attemptId = `${fetchBudget.logicalOperationId}:${operationState.count}`;
      const reservation = await this.reserveProviderAttempt({
        ...fetchBudget,
        attemptId,
        retryOfAttemptId: operationState.previousAttemptId,
        retry: operationState.count > 0,
      });
      let settled = false;
      const durableDeadline = reservation
        ? Date.parse(reservation.deadlineAt)
        : Number.POSITIVE_INFINITY;
      const deadlineAt = Math.min(
        this.control.deadlineAt ?? Number.POSITIVE_INFINITY,
        durableDeadline,
      );
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        await this.settleProviderAttempt(reservation, { kind: 'rejected' });
        throw new MeriRunBudgetExhaustedError('deadline');
      }
      const controller = new AbortController();
      const abortFromControl = () => controller.abort(this.control.signal?.reason);
      this.control.signal?.addEventListener('abort', abortFromControl, { once: true });
      const timer = setTimeout(
        () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
        Math.min(remainingMs, 2_147_483_647),
      );
      const init = args[1] ?? {};
      const abortFromRequest = () => controller.abort(init.signal?.reason);
      init.signal?.addEventListener('abort', abortFromRequest, { once: true });
      if (this.control.signal?.aborted) abortFromControl();
      if (init.signal?.aborted) abortFromRequest();
      let dispatched = false;
      try {
        dispatched = true;
        const response = await raceWithAbort(
          fetchImpl(args[0], { ...init, signal: controller.signal }),
          controller.signal,
        );
        if (controller.signal.aborted || Date.now() >= deadlineAt) {
          throw controller.signal.reason ?? new DOMException('Timed out', 'TimeoutError');
        }
        if (response.ok) {
          const usage = await responseUsage(response);
          if (usage) {
            await this.settleProviderAttempt(reservation, { kind: 'known', ...usage });
            settled = true;
          }
        }
        if (!settled) {
          await this.settleProviderAttempt(reservation, { kind: 'uncertain' });
          settled = true;
        }
        attempts.set(fetchBudget.logicalOperationId, {
          count: operationState.count + 1,
          previousAttemptId: attemptId,
        });
        return response;
      } catch (error) {
        if (!settled) {
          await this.settleProviderAttempt(
            reservation,
            dispatched ? { kind: 'uncertain' } : { kind: 'rejected' },
          );
        }
        attempts.set(fetchBudget.logicalOperationId, {
          count: operationState.count + 1,
          previousAttemptId: attemptId,
        });
        throw error;
      } finally {
        clearTimeout(timer);
        this.control.signal?.removeEventListener('abort', abortFromControl);
        init.signal?.removeEventListener('abort', abortFromRequest);
      }
    }) as typeof fetch;
  }

  providerControl(deadlineAt?: string): { signal?: AbortSignal; deadlineAt: number } {
    return {
      ...(this.control.signal ? { signal: this.control.signal } : {}),
      deadlineAt: Math.min(
        this.control.deadlineAt ?? Number.POSITIVE_INFINITY,
        deadlineAt ? Date.parse(deadlineAt) : Number.POSITIVE_INFINITY,
      ),
    };
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

  /**
   * The earlier provider call of this turn that already returned this exact
   * read, if any. Its result is in the model's context, so repeating the call
   * would only resend the same evidence.
   */
  settledRead(signature: string): string | null {
    return this.settledReads.get(signature) ?? null;
  }

  /** Remember a successful read so an identical call later in the turn is not re-dispatched. */
  rememberSettledRead(signature: string, providerCallId: string): void {
    if (!this.settledReads.has(signature)) this.settledReads.set(signature, providerCallId);
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

export function stableProviderOperationId(scope: string, value: unknown): string {
  return `${scope}:${hashCanonical(value)}`;
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

function providerFetchBudgetInput(
  args: Parameters<typeof fetch>,
  phase: MeriModelBudgetPhase,
): Omit<MeriProviderAttemptBinding, 'attemptId' | 'retryOfAttemptId'> {
  const request = args[0];
  const init = args[1];
  const url =
    typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
  const body = typeof init?.body === 'string' ? init.body : '';
  let parsed: Record<string, unknown> = {};
  try {
    const candidate = body ? JSON.parse(body) : {};
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) parsed = candidate;
  } catch {
    // The byte reservation remains conservative even when the body is not JSON.
  }
  const kind: MeriProviderAttemptKind = url.includes('/v1/responses')
    ? 'openai_responses'
    : url.includes('/v1/messages')
      ? 'anthropic_messages'
      : 'jev';
  const configuredOutput = parsed.max_output_tokens ?? parsed.max_tokens;
  const model =
    typeof parsed.model === 'string' && parsed.model.length > 0
      ? parsed.model
      : kind === 'jev'
        ? 'jev'
        : 'unknown';
  const jevOutputCeiling =
    kind === 'jev'
      ? Math.max(
          0,
          ...Object.values(JEV_TASK_REGISTRY)
            .filter((registration) => registration.modelVersion === model)
            .map((registration) => registration.costBudget.maxOutputTokens),
        ) || null
      : null;
  return {
    logicalOperationId: stableProviderOperationId('provider-fetch', {
      url,
      method:
        init?.method ??
        (typeof request === 'string' || request instanceof URL ? 'GET' : request.method),
      body,
      phase,
    }),
    kind,
    phase,
    provider: kind === 'jev' ? 'jev' : kind === 'openai_responses' ? 'openai' : 'anthropic',
    model,
    // UTF-8 bytes are a conservative upper bound for provider tokenizer units.
    maxInputTokens: Buffer.byteLength(body, 'utf8'),
    maxOutputTokens:
      typeof configuredOutput === 'number' &&
      Number.isSafeInteger(configuredOutput) &&
      configuredOutput >= 0
        ? configuredOutput
        : jevOutputCeiling,
  };
}

async function responseUsage(
  response: Response,
): Promise<{ inputTokens: number; outputTokens: number } | null> {
  try {
    const json = (await response.clone().json()) as Record<string, unknown>;
    const usage =
      json.usage && typeof json.usage === 'object' && !Array.isArray(json.usage)
        ? (json.usage as Record<string, unknown>)
        : json;
    const input = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens;
    const output = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens;
    return Number.isSafeInteger(input) &&
      Number(input) >= 0 &&
      Number.isSafeInteger(output) &&
      Number(output) >= 0
      ? { inputTokens: Number(input), outputTokens: Number(output) }
      : null;
  } catch {
    return null;
  }
}

function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
