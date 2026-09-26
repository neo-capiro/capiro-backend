import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';

/** This is diagnostic runtime evidence, not tenant permission or an invocation token. */
export interface MeriAnalysisSandboxReadinessObservation {
  readonly protocolVersion: 1;
  readonly ready: true;
  readonly observedAt: string;
  readonly observation: 'fresh' | 'coalesced' | 'cached';
  readonly provenance: 'bearer_authenticated_sandbox_readiness_v1';
}

const MAX_RECEIPT_BYTES = 512;
const RECEIPT_MAX_AGE_MS = 30_000;
const RECEIPT_MAX_FUTURE_SKEW_MS = 5_000;
const PROBE_TIMEOUT_MS = 27_000;
const MIN_PROBE_INTERVAL_MS = 30_000;
const DEMAND_WINDOW_MS = 60_000;
const FIRST_PROBE_DELAY_MS = 1_100;

function readinessUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash
    ) return null;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/readiness`;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Validate only an authenticated HTTP 200 receipt. An HTTP 503, including a
 * `refused` body, is unready even if it contains a forged positive field.
 */
export function parseMeriAnalysisSandboxReadinessReceipt(
  value: unknown,
  nowMs: number = Date.now(),
): MeriAnalysisSandboxReadinessObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(',') !== 'observation,observedAt,protocolVersion,ready') return null;
  if (
    body.protocolVersion !== 1 || body.ready !== true ||
    typeof body.observation !== 'string' ||
    !['fresh', 'coalesced', 'cached'].includes(body.observation) ||
    typeof body.observedAt !== 'string'
  ) return null;
  const observedMs = Date.parse(body.observedAt);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(observedMs) ||
    new Date(observedMs).toISOString() !== body.observedAt ||
    nowMs - observedMs > RECEIPT_MAX_AGE_MS ||
    observedMs - nowMs > RECEIPT_MAX_FUTURE_SKEW_MS
  ) return null;
  return Object.freeze({
    protocolVersion: 1,
    ready: true,
    observedAt: body.observedAt,
    observation: body.observation as MeriAnalysisSandboxReadinessObservation['observation'],
    provenance: 'bearer_authenticated_sandbox_readiness_v1',
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RECEIPT_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RECEIPT_BYTES) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * API-owned, process-local, default-off sampler. `noteRunAnalysisOffered()` is
 * called only after the permission proof finds a real offered and eligible
 * run_analysis row. It schedules I/O after the one-second proof exchange,
 * coalesces per-process demand, and never stores the bearer in this object.
 */
@Injectable()
export class MeriAnalysisSandboxReadinessObserver implements OnModuleDestroy {
  private readonly enabled: boolean;
  private readonly url: string | null;
  private readonly lifetimeAbort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private stopped = false;
  private lastDemandAt = Number.NEGATIVE_INFINITY;
  private demandGeneration = 0;
  private nextProbeAt = 0;
  private observation: MeriAnalysisSandboxReadinessObservation | null = null;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    this.enabled = config.get('MERI_ANALYSIS_SANDBOX_READINESS_OBSERVER_SHADOW', { infer: true }) === true &&
      config.get('CLIO_ANALYSIS_SANDBOX_ENABLED', { infer: true }) === true;
    const configuredToken = this.enabled ? config.get('CLIO_SANDBOX_TOKEN', { infer: true }) : undefined;
    this.url = typeof configuredToken === 'string' && configuredToken.trim()
      ? readinessUrl(config.get('CLIO_SANDBOX_URL', { infer: true }))
      : null;
  }

  noteRunAnalysisOffered(): void {
    if (!this.enabled || !this.url || this.stopped) return;
    this.lastDemandAt = Date.now();
    this.demandGeneration += 1;
    this.schedule(Math.max(FIRST_PROBE_DELAY_MS, this.nextProbeAt - this.lastDemandAt));
  }

  /** A past positive result is never a reservation or executable claim. */
  currentObservation(): MeriAnalysisSandboxReadinessObservation | null {
    if (!this.enabled || !this.observation || this.stopped) return null;
    const ageMs = Date.now() - Date.parse(this.observation.observedAt);
    if (ageMs <= RECEIPT_MAX_AGE_MS && ageMs >= -RECEIPT_MAX_FUTURE_SKEW_MS) return this.observation;
    this.observation = null;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    return null;
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.timer = undefined;
    this.expiryTimer = undefined;
    this.observation = null;
    this.lifetimeAbort.abort();
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.inFlight || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sampleIfDemanded();
    }, delayMs);
    this.timer.unref?.();
  }

  private async sampleIfDemanded(): Promise<void> {
    if (this.stopped || this.inFlight || Date.now() - this.lastDemandAt > DEMAND_WINDOW_MS) return;
    this.inFlight = true;
    const sampledDemandGeneration = this.demandGeneration;
    this.observation = null;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.nextProbeAt = Date.now() + MIN_PROBE_INTERVAL_MS;
    try {
      const sampled = await this.sample();
      this.observation = this.stopped ? null : sampled;
      if (this.observation && !this.stopped) {
        const accepted = this.observation;
        const expiresInMs = Math.max(0, Date.parse(accepted.observedAt) + RECEIPT_MAX_AGE_MS - Date.now()) + 1;
        this.expiryTimer = setTimeout(() => {
          if (this.observation === accepted) this.observation = null;
          this.expiryTimer = undefined;
        }, expiresInMs);
        this.expiryTimer.unref?.();
      }
    } finally {
      this.inFlight = false;
      // One eligible-offer burst pays for one probe. Only a later offer can
      // request a repeat; a quiet tenant does not keep importing Python.
      if (!this.stopped && this.demandGeneration > sampledDemandGeneration &&
          Date.now() - this.lastDemandAt <= DEMAND_WINDOW_MS) {
        this.schedule(Math.max(0, this.nextProbeAt - Date.now()));
      }
    }
  }

  private async sample(): Promise<MeriAnalysisSandboxReadinessObservation | null> {
    if (!this.url || this.stopped) return null;
    // Read at request time, do not retain or log the secret in the observer.
    const token = this.config.get('CLIO_SANDBOX_TOKEN', { infer: true });
    if (typeof token !== 'string' || !token.trim()) return null;
    const requestAbort = new AbortController();
    const abortOnDestroy = () => requestAbort.abort();
    if (this.lifetimeAbort.signal.aborted) abortOnDestroy();
    else this.lifetimeAbort.signal.addEventListener('abort', abortOnDestroy, { once: true });
    const timeout = setTimeout(() => requestAbort.abort(), PROBE_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: requestAbort.signal,
      });
      if (
        response.status !== 200 || response.redirected ||
        !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')
      ) {
        void response.body?.cancel().catch(() => undefined);
        return null;
      }
      return parseMeriAnalysisSandboxReadinessReceipt(await boundedJson(response));
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      this.lifetimeAbort.signal.removeEventListener('abort', abortOnDestroy);
    }
  }
}
