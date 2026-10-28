/**
 * MB-05 source-event producer (finite slice): the exact Core event, its fact digest, and the
 * bounded service-identity delivery to Meri's existing routine source-event listener.
 *
 * The producer is the existing bizdev watch runner's canonical, immutable alert. The event is
 * CONTENT, never authority: it carries no prompt, scope grant, destination selector, budget,
 * limit or run identifier, and Meri re-reads every claim from Core custody through the existing
 * `POST /api/internal/routines/source-events/current` service-identity route before any effect.
 *
 * Delivery is idempotent by identity — (tenant, producer, immutable alert id) — so a lost or
 * unknown acknowledgement is reconciled by replaying the SAME bytes and reading Meri's own
 * recorded disposition. A failed or unknown HTTP response is never reported as success, and an
 * event is never dispatched without an approved binding read from Meri's durable owner: this
 * module can read an approval, never create one, and it never fabricates a routine generation.
 *
 * The codec MIRRORS the canonical Meri commands-0.2 contract at this HTTP boundary
 * (meri-greenfield apps/control/schedules/source-event-contract.mjs) with the repo's existing
 * RFC 8785 canonical hash, exactly as native-approval-metadata.ts mirrors Meri's native codecs.
 */
import { ConflictException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import {
  BIZDEV_SOURCE_EVENT_RECORDED_STATES,
  countSourceEventDispositions,
} from './bizdev-watch.types.js';

export const SOURCE_EVENT_PROTOCOL = 'meri.routines.source-event/1';
export const SOURCE_EVENT_FACT_PROTOCOL = `${SOURCE_EVENT_PROTOCOL}.bizdev.watch.alert/1`;
export const SOURCE_EVENT_PRODUCER = 'bizdev.watch.alert.v1';
export const SOURCE_EVENT_EVENT_PATH = '/v1/internal/routines/source-events';
export const SOURCE_EVENT_BINDING_PATH = '/v1/internal/routines/source-events/binding';
/** The producer fact vocabulary of the existing watch owners (bizdev-watch.types.ts). */
export const SOURCE_EVENT_FAMILIES = Object.freeze([
  'federal_award', 'federal_assistance_award', 'sam_opportunity', 'tango_resource', 'lda_filing', 'acquisition_revision',
]);
/** Read-response bound and delivery bound: one finite event per request, at most one replay. */
export const SOURCE_EVENT_MAX_RESPONSE_BYTES = 64 * 1024;
export const SOURCE_EVENT_DELIVERY_ATTEMPTS = 2;
export const SOURCE_EVENT_REQUEST_TIMEOUT_MS = 3000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\u0000');
const instant = (value: unknown): value is string =>
  typeof value === 'string' && Number.isSafeInteger(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

const unavailable = () => new ServiceUnavailableException('Routine source-event delivery unavailable');
const mismatch = () => new ConflictException('Routine source event does not match canonical alert custody');
const invalid = (field: string) => new ConflictException(`Invalid routine source event: ${field}`);

export interface SourceEventAlertFacts {
  alertId: string; watchId: string; prospectId: string; dedupeKey: string; fingerprint: string;
}
export interface SourceEventSourceFacts {
  sourceFamily: string; recordId: string; sourceRevision: string | null;
}
export interface SourceEventEnvelope {
  schemaVersion: 1; producer: string; tenantId: string; eventId: string; eventHash: string; occurredAt: string;
  routine: { scheduleId: string; generation: number };
  source: SourceEventSourceFacts;
  alert: SourceEventAlertFacts;
}
/** Canonical immutable alert custody as the runner observed it inside its own committed transaction. */
export interface SourceEventAlertCustody extends SourceEventAlertFacts {
  tenantId: string; sourceFamily: string; recordId: string; sourceRevision: string | null; occurredAtMs: number;
}

/** The one canonical immutable producer fact set. Producer and receiver must derive this identically. */
export function sourceEventFacts(value: { tenantId: string; alert: SourceEventAlertFacts; source: SourceEventSourceFacts }) {
  if (!text(value.tenantId, 256)) throw mismatch();
  const a = value.alert;
  if (!UUID.test(String(a.alertId)) || !UUID.test(String(a.watchId)) || !UUID.test(String(a.prospectId)) ||
      !text(a.dedupeKey, 512) || !HEX64.test(String(a.fingerprint))) throw mismatch();
  const s = value.source;
  if (!SOURCE_EVENT_FAMILIES.includes(s.sourceFamily) || !text(s.recordId, 512) ||
      !(s.sourceRevision === null || text(s.sourceRevision, 512))) throw mismatch();
  return {
    tenantId: value.tenantId,
    alert: { alertId: a.alertId, watchId: a.watchId, prospectId: a.prospectId, dedupeKey: a.dedupeKey, fingerprint: a.fingerprint },
    source: { sourceFamily: s.sourceFamily, recordId: s.recordId, sourceRevision: s.sourceRevision },
  };
}

/** The producer fact digest carried as the event hash. */
export function sourceEventFactHash(facts: ReturnType<typeof sourceEventFacts>): string {
  return createHash('sha256').update(canonicalizeCoreRetainedJson({
    protocol: SOURCE_EVENT_FACT_PROTOCOL, tenantId: facts.tenantId, alert: facts.alert, source: facts.source,
  }), 'utf8').digest('hex');
}

/**
 * The exact event for one immutable alert and one approved routine generation. The event
 * identity is the alert's own immutable id, so a crash, a redelivery or a reconciliation replay
 * always names the same single event.
 */
export function bizDevWatchSourceEvent(input: {
  custody: SourceEventAlertCustody; scheduleId: string; generation: number;
}): SourceEventEnvelope {
  const c = input.custody;
  if (!UUID.test(String(c.alertId)) || !UUID.test(String(c.watchId)) || !UUID.test(String(c.prospectId))) throw mismatch();
  if (!text(c.tenantId, 256) || !text(c.dedupeKey, 512) || !HEX64.test(String(c.fingerprint))) throw mismatch();
  if (!UUID.test(String(input.scheduleId)) || !Number.isSafeInteger(input.generation) || input.generation < 1) throw invalid('routine');
  if (!Number.isSafeInteger(c.occurredAtMs) || c.occurredAtMs < 0) throw invalid('occurredAtMs');
  const facts = sourceEventFacts({
    tenantId: c.tenantId,
    alert: { alertId: c.alertId, watchId: c.watchId, prospectId: c.prospectId, dedupeKey: c.dedupeKey, fingerprint: c.fingerprint },
    source: { sourceFamily: c.sourceFamily, recordId: c.recordId, sourceRevision: c.sourceRevision },
  });
  return Object.freeze({
    schemaVersion: 1 as const, producer: SOURCE_EVENT_PRODUCER, tenantId: facts.tenantId,
    eventId: facts.alert.alertId, eventHash: sourceEventFactHash(facts),
    occurredAt: new Date(c.occurredAtMs).toISOString(),
    routine: Object.freeze({ scheduleId: input.scheduleId, generation: input.generation }),
    source: Object.freeze(facts.source), alert: Object.freeze(facts.alert),
  });
}

export type SourceEventDeliveryState =
  | 'DISPATCHED' | 'DEDUPED' | 'ACCEPTED' | 'QUEUED' | 'SKIPPED' | 'REFUSED' | 'CONFLICT' | 'UNKNOWN';

/** The disposition vocabulary Meri's receiver can return on the wire. */
const SOURCE_EVENT_DISPOSITION_STATES: ReadonlySet<string> = new Set([
  'DISPATCHED', 'DEDUPED', 'ACCEPTED', 'QUEUED', 'SKIPPED', 'REFUSED', 'CONFLICT', 'UNKNOWN',
]);

export interface SourceEventDeliveryResult {
  state: SourceEventDeliveryState;
  /** Meri's own recorded disposition code, when one was returned. */
  code: string | null;
  attempts: number;
  /**
   * The store state a DEDUPED answer RECORDED for the row it found (Meri's own
   * `sourceEvent.recorded`, e.g. receiver SETTLED -> DEDUPED with the prior
   * row's state). Preserved and validated through this result so DEDUPED can
   * only advance the recovery cursor when this names a terminal outcome:
   * UNKNOWN / ACCEPTED / QUEUED / absent / malformed never becomes terminal.
   */
  recorded: string | null;
}

/**
 * Per-alert dispositions for one evaluator pass. An answer Meri never gave is UNKNOWN, never
 * success. `unknown` also counts a DEDUPED answer whose recorded outcome is not terminal: the
 * handoff outcome is NOT confirmed, so an aggregate-only owner cannot acknowledge that page.
 */
export interface SourceEventSinkCounts {
  offered: number;
  dispatched: number;
  queued: number;
  deduped: number;
  refused: number;
  unknown: number;
  skipped: number;
}

/**
 * Per-alert disposition for one offered alert. UNKNOWN means Meri never definitively answered THIS
 * alert (or answered DEDUPED without naming a terminal recorded outcome): it is neither a delivery
 * nor a refusal, and it can never advance the recovery cursor. ACCEPTED/QUEUED are durable but IN
 * FLIGHT — also not a completed handoff. `recorded` carries the store state a DEDUPED answer names.
 */
export interface SourceEventAlertDisposition {
  alertId: string;
  state: SourceEventDeliveryState;
  /** Meri's `sourceEvent.recorded` store state for a DEDUPED answer (validated; null when absent). */
  recorded?: string | null;
}

/** The delivery owner's answer for one offered page: the run counts plus the exact per-alert dispositions. */
export interface SourceEventDeliveryAnswer {
  counts: SourceEventSinkCounts;
  dispositions: SourceEventAlertDisposition[];
}

/**
 * The evaluator's delivery owner: the exact producer-side owner of MB-05. It reads the approved
 * binding from Meri's durable owner ONCE per (producer, family, resource) pair — an unbound pair
 * therefore causes ZERO event calls — and reports only what Meri itself answered, PER ALERT, so the
 * caller can advance its durable recovery cursor over exactly the alerts Meri definitively answered.
 * A binding read that Meri could not answer is UNKNOWN for that pair, never "no binding".
 */
export function createSourceEventDispositionSink(options: {
  transport?: SourceEventTransport; origin?: string; secret?: string; fetchImpl?: typeof fetch;
} = {}): (alerts: readonly SourceEventAlertCustody[]) => Promise<SourceEventDeliveryAnswer> {
  const transport = options.transport ?? createSourceEventTransport({origin: options.origin, secret: options.secret, fetchImpl: options.fetchImpl});
  const delivery = new BizDevWatchSourceEventDelivery();
  return async alerts => {
    const dispositions: SourceEventAlertDisposition[] = [];
    const bindings = new Map<string, { binding: { scheduleId: string; generation: number } | null } | null>();
    for (const custody of alerts) {
      const key = `${custody.tenantId}\u0000${custody.sourceFamily}\u0000${custody.watchId}`;
      if (!bindings.has(key)) {
        try {
          bindings.set(key, {binding: await transport.binding({
            tenantId: custody.tenantId, sourceFamily: custody.sourceFamily, resourceKey: custody.watchId,
          })});
        } catch {
          bindings.set(key, null);
        }
      }
      const approved = bindings.get(key) ?? null;
      if (approved === null) {
        // Meri never answered whether this pair is approved: the alert stays UNKNOWN, never skipped.
        dispositions.push({alertId: custody.alertId, state: 'UNKNOWN', recorded: null});
        continue;
      }
      if (approved.binding === null) {
        // Meri's own definite answer that this pair has no approved routine: no effect, and the
        // alert is a terminal no-op rather than an unresolved one.
        dispositions.push({alertId: custody.alertId, state: 'SKIPPED', recorded: null});
        continue;
      }
      const result = await delivery.deliver(
        bizDevWatchSourceEvent({custody, scheduleId: approved.binding.scheduleId, generation: approved.binding.generation}),
        {transport},
      );
      // Report Meri's answer verbatim, carrying the recorded outcome a DEDUPED answer names. The
      // SHARED counter (countSourceEventDispositions) decides what counts as a completed handoff, so
      // a DEDUPED answer without a terminal recorded outcome counts as UNKNOWN and can never make an
      // aggregate-only page look acknowledged.
      dispositions.push({alertId: custody.alertId, state: result.state, recorded: result.recorded});
    }
    const counts: SourceEventSinkCounts = countSourceEventDispositions(alerts.length, dispositions);
    return {counts, dispositions};
  };
}

/**
 * Aggregate-only view of the same owner (the existing caller contract): the run's counts. The
 * per-alert dispositions are available through createSourceEventDispositionSink.
 */
export function createSourceEventSink(options: {
  transport?: SourceEventTransport; origin?: string; secret?: string; fetchImpl?: typeof fetch;
} = {}): (alerts: readonly SourceEventAlertCustody[]) => Promise<SourceEventSinkCounts> {
  const owner = createSourceEventDispositionSink(options);
  return async alerts => (await owner(alerts)).counts;
}

export interface SourceEventTransport {
  /** READ the approved binding for a producer/resource pair. Never creates one. */
  binding(pair: { tenantId: string; sourceFamily: string; resourceKey: string; signal?: AbortSignal }): Promise<{ scheduleId: string; generation: number } | null>;
  /**
   * Deliver exactly one event; the disposition is Meri's, never this transport's. `recorded` is the
   * store state a DEDUPED answer names (`sourceEvent.recorded`), validated to a known state or null.
   */
  event(envelope: SourceEventEnvelope, signal?: AbortSignal): Promise<{
    status: number;
    disposition: string | null;
    outcome: string | null;
    code: string | null;
    recorded?: string | null;
  }>;
}

const closed = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const names = Object.keys(value as Record<string, unknown>);
  if (names.some((k) => !keys.includes(k))) throw unavailable();
  return value as Record<string, unknown>;
};

/** One bounded service-identity POST over the existing private Meri Control transport. */
async function post(
  fetchImpl: typeof fetch, base: URL, path: string, secret: string, body: unknown,
): Promise<{ status: number; payload: unknown }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SOURCE_EVENT_REQUEST_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetchImpl(new URL(path, base), {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: abort.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'identity', 'x-internal-service-secret': secret },
      body: JSON.stringify(body),
    } as RequestInit & { cache: string });
    let payload: unknown = null;
    if (response.body) {
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > SOURCE_EVENT_MAX_RESPONSE_BYTES) throw unavailable();
        chunks.push(next.value);
      }
      if (abort.signal.aborted) throw unavailable();
      if (chunks.length) {
        try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { payload = null; }
      }
    }
    return { status: response.status, payload };
  } finally {
    clearTimeout(timer); abort.abort();
    if (reader) await reader.cancel().catch(() => undefined);
  }
}

/**
 * The producer's transport. `connect` is the one seam the task-owned specs replace with an
 * injected local transport; production uses the SAME configured origin and shared service
 * secret the existing native-approval metadata reader uses (`MERI_CONTROL_ORIGIN` +
 * `INTERNAL_SERVICE_SECRET`), never a runtime/control bearer.
 */
export function createSourceEventTransport(options: {
  origin?: string; secret?: string; fetchImpl?: typeof fetch;
}): SourceEventTransport {
  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  let base: URL;
  try { base = new URL(options.origin ?? ''); } catch { throw unavailable(); }
  const secret = options.secret;
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      typeof secret !== 'string' || secret.length === 0 || secret.length > 8192 || /[\r\n]/.test(secret) ||
      typeof fetchImpl !== 'function') throw unavailable();
  const call = (path: string, body: unknown, signal?: AbortSignal) => {
    if (signal?.aborted) throw unavailable();
    return post(fetchImpl as typeof fetch, base, path, secret, body);
  };
  return Object.freeze({
    async binding(pair: { tenantId: string; sourceFamily: string; resourceKey: string; signal?: AbortSignal }) {
      const response = await call(SOURCE_EVENT_BINDING_PATH, {
        schemaVersion: 1, producer: SOURCE_EVENT_PRODUCER, tenantId: pair.tenantId,
        sourceFamily: pair.sourceFamily, resourceKey: pair.resourceKey,
      }, pair.signal);
      // A transport that cannot answer is UNAVAILABLE: "no binding" may only come from Meri itself.
      if (response.status !== 200) throw unavailable();
      const body = closed(response.payload, ['outcome', 'binding']);
      if (body.binding === null || body.binding === undefined) return null;
      const found = closed(body.binding, ['scheduleId', 'generation']);
      if (!text(found.scheduleId, 64) || !Number.isSafeInteger(found.generation) || (found.generation as number) < 1)
        throw unavailable();
      return { scheduleId: found.scheduleId as string, generation: found.generation as number };
    },
    async event(envelope: SourceEventEnvelope, signal?: AbortSignal) {
      const response = await call(SOURCE_EVENT_EVENT_PATH, envelope, signal);
      const body = response.payload === null ? null : (typeof response.payload === 'object' && !Array.isArray(response.payload)
        ? response.payload as Record<string, unknown> : null);
      const sourceEvent = body && typeof body.sourceEvent === 'object' && body.sourceEvent !== null
        ? body.sourceEvent as Record<string, unknown> : null;
      const disposition = sourceEvent === null ? undefined : sourceEvent.disposition;
      const recorded = sourceEvent === null ? undefined : sourceEvent.recorded;
      const error = body && typeof body.error === 'object' && body.error !== null
        ? (body.error as Record<string, unknown>).code : undefined;
      return {
        status: response.status,
        // A disposition this protocol does not define is UNINTELLIGIBLE, never a state we invent.
        disposition: typeof disposition === 'string' && SOURCE_EVENT_DISPOSITION_STATES.has(disposition) ? disposition : null,
        outcome: body && typeof body.outcome === 'string' ? body.outcome : null,
        code: typeof error === 'string' ? error : null,
        // Preserve the recorded outcome a DEDUPED answer names; anything not a known store state is
        // malformed and becomes null, so DEDUPED-with-UNKNOWN/absent HOLDS rather than completing.
        recorded: typeof recorded === 'string' && BIZDEV_SOURCE_EVENT_RECORDED_STATES.has(recorded) ? recorded : null,
      };
    },
  });
}

/**
 * The producer-side delivery owner. It reads the approved binding from Meri's durable owner,
 * refuses to invent one, and reports only what Meri actually answered.
 */
@Injectable()
export class BizDevWatchSourceEventDelivery {
  constructor(@Optional() private readonly config?: ConfigService) {}

  private transport(): SourceEventTransport {
    return createSourceEventTransport({
      origin: this.config?.get<string>('MERI_CONTROL_ORIGIN'),
      secret: this.config?.get<string>('INTERNAL_SERVICE_SECRET'),
    });
  }

  /**
   * Deliver one committed alert. No approved binding for (producer, sourceFamily, watch) means
   * NOTHING is dispatched and nothing is invented; a read of an approval is never a grant.
   */
  async deliverForAlert(
    custody: SourceEventAlertCustody,
    overrides: { transport?: SourceEventTransport } = {},
  ): Promise<SourceEventDeliveryResult> {
    const transport = overrides.transport ?? this.transport();
    const binding = await transport.binding({
      tenantId: custody.tenantId, sourceFamily: custody.sourceFamily, resourceKey: custody.watchId,
    });
    if (!binding) return { state: 'SKIPPED', code: 'SOURCE_EVENT_BINDING_ABSENT', attempts: 0, recorded: null };
    const envelope = bizDevWatchSourceEvent({ custody, scheduleId: binding.scheduleId, generation: binding.generation });
    return this.deliver(envelope, { transport });
  }

  /**
   * One finite event, at most one bounded replay. Every non-200 answer is UNKNOWN ("we do not
   * know whether Meri accepted this"), never success; a replay sends the SAME bytes, and Meri's
   * identity dedup makes it the same single event rather than a second effect.
   */
  async deliver(
    envelope: SourceEventEnvelope,
    overrides: { transport?: SourceEventTransport } = {},
  ): Promise<SourceEventDeliveryResult> {
    const transport = overrides.transport ?? this.transport();
    let last: { state: SourceEventDeliveryState; code: string | null } = { state: 'UNKNOWN', code: 'SOURCE_EVENT_UNKNOWN' };
    for (let attempt = 1; attempt <= SOURCE_EVENT_DELIVERY_ATTEMPTS; attempt++) {
      let answer: {
        status: number; disposition: string | null; outcome: string | null; code: string | null;
        recorded?: string | null;
      };
      try {
        answer = await transport.event(envelope);
      } catch {
        last = { state: 'UNKNOWN', code: 'SOURCE_EVENT_UNAVAILABLE' };
        continue;
      }
      if (answer.status === 200 && answer.disposition !== null && answer.disposition !== 'UNKNOWN' &&
          SOURCE_EVENT_DISPOSITION_STATES.has(answer.disposition)) {
        // Carry the recorded store state for a DEDUPED answer, validated again here so a foreign
        // transport cannot smuggle an unrecognised outcome into a "completed" handoff.
        const recorded = typeof answer.recorded === 'string' && BIZDEV_SOURCE_EVENT_RECORDED_STATES.has(answer.recorded)
          ? answer.recorded : null;
        return {
          state: answer.disposition as SourceEventDeliveryState,
          code: answer.code,
          attempts: attempt,
          recorded,
        };
      }
      // A transport-level failure (absent route, wrong credential, my own mistake) is OUR state,
      // not Meri's refusal: it can only add work, and it can never be read as a disposition. An
      // unintelligible 200 body is the same: UNKNOWN, never a fabricated disposition.
      last = answer.status === 200
        ? { state: 'UNKNOWN', code: answer.outcome === 'UNKNOWN' ? 'SOURCE_EVENT_UNKNOWN' : 'SOURCE_EVENT_UNKNOWN' }
        : [400, 403, 409, 422].includes(answer.status)
          ? { state: 'REFUSED', code: answer.code }
          : { state: 'UNKNOWN', code: answer.code ?? 'SOURCE_EVENT_UNAVAILABLE' };
      if (last.state === 'REFUSED') return { state: 'REFUSED', code: last.code, attempts: attempt, recorded: null };
    }
    return { state: 'UNKNOWN', code: last.code, attempts: SOURCE_EVENT_DELIVERY_ATTEMPTS, recorded: null };
  }
}
