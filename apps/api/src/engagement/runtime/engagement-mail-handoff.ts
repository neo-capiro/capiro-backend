/**
 * Process-scoped mail-handoff admission barrier.
 *
 * This is the single owner of the handoff fence state and of the lifetime of
 * work that was already admitted when the fence was applied. It is deliberately
 * NOT a Nest provider: the barrier describes an operator fence over this
 * *process*, so a per-injection instance would be the wrong lifetime, and the
 * existing `EngagementRuntimePolicyService` stays the one policy instance that
 * delegates here.
 *
 * Default (no selection, phase 'off') preserves legacy behavior: every assertion
 * returns immediately, no counters are created and no observation exists.
 *
 * TWO SEPARATE CONCEPTS, deliberately not conflated:
 *  - BOOT SELECTION: an operator phase read once from the resolved environment.
 *    It is never mutated after binding, and a conflicting rebind is ignored
 *    without changing phase, generation, timestamp or counters, so a helper
 *    constructor can never reset another owner's selection or mix generations.
 *    A different phase needs a restarted task.
 *  - LOCAL LIFECYCLE: `beginLocalShutdown()` synchronously closes NEW admissions
 *    on this process; the process then keeps its already-owned handles until each
 *    reaches a terminal disposition. `localClosure` is true when admission is
 *    locally closed AND no admitted work remains — including for a process that
 *    never admitted anything. Local closure says nothing about provider outcome
 *    reconciliation: `unknownTotal` may remain after local closure and must never
 *    be reported as reconciled or successful. A successor process starts empty,
 *    so its zero counters never prove a predecessor's closure.
 *
 * Phases (each admits strictly less than the previous):
 *   off               legacy
 *   initiation_fenced new initiation and NEW grant writes refused; already
 *                     admitted callbacks/queue work/ticks and the grant writes
 *                     nested inside them continue
 *   callback_fenced   additionally refuses new callback/notification reception
 *                     and new scheduler ticks
 *   writers_closed    refuses all new work
 *
 * CONTINUATION IS A LIVE RECORD, NOT A CLAIM. Every admission creates one record
 * held in `liveAdmissions`; the AsyncLocalStorage scope and the handle `context`
 * carry that same record object, so identity is the only way to present it.
 * Settlement kills the record and removes it, which invalidates the handle AND
 * any async descendant that inherited the scope: a child running after its
 * parent settled can no longer grant-write. A header, query value, boolean or
 * model field cannot produce a live record.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { EngagementRuntimeEnvironment } from './engagement-runtime-env.js';
import type {
  CapiroServiceName,
  EngagementMailHandoffBoundary,
  EngagementMailHandoffContext,
  EngagementMailHandoffDisposition,
  EngagementMailHandoffHandle,
  EngagementMailHandoffObservation,
  EngagementMailHandoffOutcome,
  EngagementMailHandoffPhase,
} from './engagement-runtime.types.js';

export interface EngagementMailHandoffConfig {
  phase: EngagementMailHandoffPhase;
  generation: string | null;
  fenceUtc: string | null;
}

const PHASE_ORDER: Record<EngagementMailHandoffPhase, number> = {
  off: 0,
  initiation_fenced: 1,
  callback_fenced: 2,
  writers_closed: 3,
};

/**
 * The phase at which each boundary stops admitting NEW work.
 *
 * Issuers, creation, sync/calendar/subscription/disconnect, capture, identity
 * initiation and grant writes stop as soon as the issuer fence is applied.
 * Callback/notification reception and periodic scheduler ticks stay admitted
 * through `initiation_fenced` (an admitted callback must be able to finish, and
 * closing callback ingress does not stop an already-admitted tick), and stop
 * when the callback/mail admission closes.
 */
const REFUSE_FROM: Record<EngagementMailHandoffBoundary, EngagementMailHandoffPhase> = {
  integration_create: 'initiation_fenced',
  oauth_state_issue: 'initiation_fenced',
  integration_sync: 'initiation_fenced',
  integration_calendar_commands: 'initiation_fenced',
  integration_subscription: 'initiation_fenced',
  integration_disconnect: 'initiation_fenced',
  capture_initiation: 'initiation_fenced',
  identity_delete_initiation: 'initiation_fenced',
  grant_refresh: 'initiation_fenced',
  grant_persist: 'initiation_fenced',
  callback_notification_admit: 'callback_fenced',
  scheduler_tick: 'callback_fenced',
  oauth_callback_continue: 'writers_closed',
};

type MutableCounters = Record<string, number>;
/** Terminal disposition, owned by the shared runtime types. */
type Outcome = EngagementMailHandoffOutcome;

/** Boundaries decided by continuation ownership rather than only by phase. */
const GRANT_BOUNDARIES: readonly EngagementMailHandoffBoundary[] = [
  'grant_refresh',
  'grant_persist',
];

/**
 * Boundaries that may be RETAINED as a child of an already-admitted record.
 *
 * Retaining never opens a new admission: it extends the lifetime of work that was
 * already admitted (a callback's deferred queue item, an accepted notification, a
 * scheduler tick). Boundaries that initiate effects are not retentable, so this
 * can never be used to mint authority for new work.
 */
const RETENTION_BOUNDARIES: readonly EngagementMailHandoffBoundary[] = [
  'callback_notification_admit',
  'scheduler_tick',
  'oauth_callback_continue',
];

/** One admission's server-owned record; its identity is the continuation proof. */
interface AdmissionRecord {
  readonly boundary: EngagementMailHandoffBoundary;
  readonly admittedAtUtc: string;
  readonly phaseAtAdmission: EngagementMailHandoffPhase;
  /** Call-local outcome box; this record's finalizer reads it once. */
  readonly disposition: EngagementMailHandoffDisposition;
  live: boolean;
}

/**
 * One disposition box. `begin` marks an in-flight external effect, so the owner is
 * `unknown` until that effect reports a definite result; a reported `unknown` is
 * sticky for this admission and is never erased by a later success.
 */
function createDisposition(): EngagementMailHandoffDisposition {
  let open = 0;
  let settled = false;
  let failed = false;
  let unresolved = false;
  let reported = false;
  return {
    begin(): void {
      open += 1;
      reported = true;
    },
    settle(outcome: 'settled' | 'failed'): void {
      reported = true;
      if (open > 0) open -= 1;
      if (outcome === 'settled') settled = true;
      else failed = true;
    },
    unknown(): void {
      reported = true;
      unresolved = true;
    },
    hasReport(): boolean {
      return reported;
    },
    outcome(): Outcome {
      if (unresolved || open > 0) return 'unknown';
      if (settled) return 'settled';
      if (failed) return 'failed';
      // A report that resolved nothing definite is not evidence of success.
      return 'unknown';
    },
  };
}

function bump(counters: MutableCounters, key: string): void {
  counters[key] = (counters[key] ?? 0) + 1;
}

function total(counters: MutableCounters): number {
  return Object.values(counters).reduce((sum, value) => sum + value, 0);
}

export class EngagementMailHandoffBarrier {
  private readonly logger = new Logger('EngagementMailHandoff');
  private readonly admissionScope = new AsyncLocalStorage<AdmissionRecord>();
  private readonly liveAdmissions = new Set<AdmissionRecord>();
  private readonly idleWaiters = new Set<() => void>();
  private bound = false;
  private config: EngagementMailHandoffConfig = { phase: 'off', generation: null, fenceUtc: null };
  private serviceName: CapiroServiceName = 'api';
  private configuredAtUtc: string | null = null;
  private admissionClosedLocally = false;
  private readonly initiationRefusals: MutableCounters = {};
  private readonly admittedWork: MutableCounters = {};
  private readonly activeWork: MutableCounters = {};
  private readonly settledWork: MutableCounters = {};
  private readonly failedWork: MutableCounters = {};
  private readonly unknownWork: MutableCounters = {};

  /**
   * Bind ONCE from the resolved environment. A later agreeing call is a no-op; a
   * conflicting call is ignored with a warning and changes nothing — no phase, no
   * generation, no configuredAtUtc, no counters — so a helper owner constructed
   * with an omitted selection can never reset an existing fence or mix
   * generations.
   */
  bind(environment: EngagementRuntimeEnvironment): void {
    const selection: EngagementMailHandoffConfig = {
      phase: environment.mailHandoff?.phase ?? 'off',
      generation: environment.mailHandoff?.generation ?? null,
      fenceUtc: environment.mailHandoff?.fenceUtc ?? null,
    };
    if (this.bound) {
      const agrees =
        selection.phase === this.config.phase &&
        selection.generation === this.config.generation &&
        selection.fenceUtc === this.config.fenceUtc &&
        environment.serviceName === this.serviceName;
      if (agrees) return;
      // An omitted/legacy selection is a helper that must not reset an existing
      // fence: tolerate it without touching state.
      const omitted =
        selection.phase === 'off' && selection.generation === null && selection.fenceUtc === null;
      if (omitted) {
        this.logger.warn(
          'ignoring omitted-selection rebind; the first boot selection is authoritative ' +
            `(bound=${this.config.phase}/${this.config.generation ?? 'unset'})`,
        );
        return;
      }
      // A requested fence (or a different generation/service) that cannot be
      // honoured fails closed. Silently starting with the fence off would permit
      // exactly the writes the operator asked to stop.
      throw new Error(
        'ENGAGEMENT_MAIL_HANDOFF_* conflict: this process is already bound to ' +
          `${this.config.phase}/${this.config.generation ?? 'unset'}/${this.serviceName} and cannot be ` +
          `rebound to ${selection.phase}/${selection.generation ?? 'unset'}/${environment.serviceName}. ` +
          'Refusing to start with a handoff selection the process cannot honour.',
      );
    }
    this.bound = true;
    this.serviceName = environment.serviceName;
    this.config = selection;
    this.configuredAtUtc = new Date().toISOString();
    if (this.config.phase !== 'off') {
      this.logger.log(
        `mail handoff barrier ${this.config.phase} selected ` +
          `(generation=${this.config.generation ?? 'unset'} fence=${this.config.fenceUtc ?? 'unset'} ` +
          `service=${this.serviceName} task=${this.taskIdentity()} pid=${process.pid})`,
      );
    }
  }

  phase(): EngagementMailHandoffPhase {
    return this.config.phase;
  }

  generation(): string | null {
    return this.config.generation;
  }

  fenceUtc(): string | null {
    return this.config.fenceUtc;
  }

  private fenced(): boolean {
    return this.config.phase !== 'off';
  }

  /** Cross-task identity axis: in ECS the container hostname is the task id. */
  private taskIdentity(): string {
    return process.env.HOSTNAME ?? process.env.ENGAGEMENT_TASK_ID ?? 'unknown-task';
  }

  /**
   * The single gate every NEW admission passes, atomically: registered boundary,
   * local shutdown state, then the boot-phase threshold. Nested NEW work goes
   * through here too; only an existing live record may skip it.
   */
  private gateNewAdmission(boundary: EngagementMailHandoffBoundary): void {
    if (!this.fenced()) return;
    const refuseFrom = REFUSE_FROM[boundary];
    if (!refuseFrom) {
      // An unregistered boundary name must not become an accidental bypass.
      this.refuse(boundary, 'unregistered boundary');
    }
    if (this.admissionClosedLocally) {
      this.refuse(boundary, 'local admission closed for shutdown');
    }
    if (PHASE_ORDER[this.config.phase] >= PHASE_ORDER[refuseFrom]) {
      this.refuse(boundary, `new work refused from ${refuseFrom}`);
    }
  }

  /** Gate, then create the one live record that both APIs share. */
  private openAdmission(boundary: EngagementMailHandoffBoundary): AdmissionRecord {
    this.gateNewAdmission(boundary);
    const record: AdmissionRecord = {
      boundary,
      admittedAtUtc: new Date().toISOString(),
      phaseAtAdmission: this.config.phase,
      disposition: createDisposition(),
      live: true,
    };
    if (!this.fenced()) return record;
    this.liveAdmissions.add(record);
    bump(this.admittedWork, boundary);
    bump(this.activeWork, boundary);
    return record;
  }

  /**
   * Exactly one terminal accounting event per record: authority is removed with
   * the record, so a settled handle and any descendant holding it both lose
   * continuation rights.
   */
  private settleRecord(record: AdmissionRecord, outcome: Outcome): void {
    if (!record.live) return;
    record.live = false;
    this.liveAdmissions.delete(record);
    const key = record.boundary;
    this.activeWork[key] = Math.max(0, (this.activeWork[key] ?? 0) - 1);
    if (outcome === 'settled') bump(this.settledWork, key);
    else if (outcome === 'failed') bump(this.failedWork, key);
    else bump(this.unknownWork, key);
    if (total(this.activeWork) === 0) {
      for (const waiter of this.idleWaiters) waiter();
      this.idleWaiters.clear();
    }
  }

  private refuse(boundary: EngagementMailHandoffBoundary, detail: string): never {
    bump(this.initiationRefusals, boundary);
    // Honest, content-free diagnostic: names the selected phase and boundary,
    // never a token, tenant, customer or business value.
    this.logger.warn(
      `mail handoff refused ${boundary} in phase ${this.config.phase} ` +
        `(generation=${this.config.generation ?? 'unset'} process=${process.pid}): ${detail}`,
    );
    throw new ServiceUnavailableException({
      statusCode: 503,
      code: 'ENGAGEMENT_MAIL_HANDOFF_FENCED',
      phase: this.config.phase,
      boundary,
      generation: this.config.generation,
      message:
        'Mail handoff is in progress in this environment. New mailbox work is refused ' +
        'until the handoff completes.',
    });
  }

  /**
   * Refuse a NEW initiation before the caller performs any state or provider
   * effect. Call this at the service boundary that owns the effect, not at the
   * HTTP route.
   */
  assertInitiation(boundary: EngagementMailHandoffBoundary): void {
    this.gateNewAdmission(boundary);
  }

  /**
   * Explicit trusted continuation for work an already-admitted owner started
   * (scheduled sync/renewal, deferred notification drain, admitted disconnect).
   *
   * Allowed ONLY from a live record issued by this barrier. Anything else falls
   * back to the NEW-admission gate for the same boundary, so a fresh direct request
   * is not silently exempted and unrelated nested NEW work is still refused.
   */
  assertOwnedContinuation(boundary: EngagementMailHandoffBoundary): void {
    if (!this.fenced()) return;
    if (this.liveRecord()) return;
    this.gateNewAdmission(boundary);
  }

  /** The single live-record authority test: membership plus liveness. */
  private liveRecord(context?: EngagementMailHandoffContext): AdmissionRecord | undefined {
    const candidates: Array<AdmissionRecord | undefined> = [
      context as unknown as AdmissionRecord | undefined,
      this.admissionScope.getStore(),
    ];
    // Authority is live-Set membership, never precedence: a stale inherited
    // record must not shadow a still-live explicit queue handle, and a forged,
    // foreign or settled record never grants anything.
    for (const candidate of candidates) {
      if (candidate && candidate.live && this.liveAdmissions.has(candidate)) return candidate;
    }
    return undefined;
  }

  /** The disposition box of the live record in scope, if any (undefined when off). */
  mailHandoffDisposition(): EngagementMailHandoffDisposition | undefined {
    if (!this.fenced()) return undefined;
    return this.liveRecord()?.disposition;
  }

  /**
   * Synchronously close new admissions on this process. It does not wait, does
   * not change the boot phase and does not touch counters: work already admitted
   * keeps its live record until it settles.
   */
  beginLocalShutdown(): void {
    if (this.admissionClosedLocally) return;
    this.admissionClosedLocally = true;
    this.logger.log(
      `mail handoff local admission closed (phase=${this.config.phase} ` +
        `task=${this.taskIdentity()} pid=${process.pid} active=${total(this.activeWork)})`,
    );
  }

  /**
   * Resolve when this process owns no further admitted work. It observes the real
   * live records; it never clears counters to return early.
   */
  waitForLocalSettlement(): Promise<void> {
    if (total(this.activeWork) === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  /**
   * Guard a grant write (token refresh / token persistence).
   *
   * Allowed only from a LIVE admission record: the AsyncLocalStorage record of
   * `runAdmitted`, or the `context` returned by `admitWork` (the same object).
   * Settlement kills the record, so a handle used after settling and a descendant
   * that inherited the scope but runs after its parent settled are both refused.
   * A caller presenting its own boolean, header or look-alike object has no live
   * record and is refused as a new grant writer.
   */
  assertGrantWrite(
    boundary: EngagementMailHandoffBoundary,
    context?: EngagementMailHandoffContext,
  ): void {
    if (!this.fenced()) return;
    if (!GRANT_BOUNDARIES.includes(boundary)) {
      this.refuse(boundary, 'not a grant boundary');
    }
    if (this.liveRecord(context)) return;
    this.refuse(boundary, 'no live admitted continuation');
  }

  /**
   * Admit one unit of already-permitted work and run it inside the live record.
   *
   * Gated like any other NEW admission. `disposition` lets the actual effect owner
   * state the real terminal outcome when it is known: a provider effect whose
   * result is not established stays `unknown` instead of being forced into
   * `failed` (throw) or `settled` (return). One terminal accounting event only —
   * the settled record and the handle share the same record.
   */
  async runAdmitted<T>(
    boundary: EngagementMailHandoffBoundary,
    work: () => Promise<T> | T,
    disposition?: () => Outcome,
  ): Promise<T> {
    const record = this.openAdmission(boundary);
    let succeeded = false;
    let value: T | undefined;
    let workError: unknown;
    try {
      value = await this.admissionScope.run(record, async () => work());
      succeeded = true;
    } catch (error) {
      workError = error;
    }
    // The owner's disposition is evaluated EXACTLY ONCE. Precedence: an explicit
    // caller classifier, then the record's own reported box, then the plain
    // success/throw fallback for work with no external effect to report. A
    // classifier that itself fails retains `unknown` rather than guessing, and
    // never leaves live authority behind. Local writer closure stays distinct
    // from provider reconciliation, and the original work error is preserved.
    let outcome: Outcome = succeeded ? 'settled' : 'failed';
    if (disposition) {
      try {
        outcome = disposition();
      } catch {
        outcome = 'unknown';
      }
    } else if (record.disposition.hasReport()) {
      outcome = record.disposition.outcome();
    }
    this.settleRecord(record, outcome);
    if (!succeeded) throw workError;
    return value as T;
  }

  /**
   * Register work at admission time (queue entry, deferred job) and keep the SAME
   * handle for its later drain. The drain settles this handle instead of minting a
   * replacement, so the lifetime cannot double-count or split, and the live record
   * it carries is the continuation authority for nested grant writes.
   */
  admitWork(boundary: EngagementMailHandoffBoundary): EngagementMailHandoffHandle {
    const record = this.openAdmission(boundary);
    return {
      context: record,
      disposition: record.disposition,
      settle: (outcome?: Outcome) => {
        this.settleRecord(record, outcome ?? this.defaultSettleOutcome(record));
      },
    };
  }

  /**
   * Run work inside an ALREADY-ISSUED live record. Never mints and never gates:
   * the caller already owns this admission. A settled or foreign record is
   * refused, so a deferred item cannot revive authority after settlement.
   */
  async runInAdmission<T>(
    boundary: EngagementMailHandoffBoundary,
    context: EngagementMailHandoffContext,
    work: () => Promise<T> | T,
  ): Promise<T> {
    if (!this.fenced()) return work();
    const record = this.liveRecord(context);
    if (!record) this.refuse(boundary, 'no live admitted continuation');
    return this.admissionScope.run(record as AdmissionRecord, async () => work());
  }

  /**
   * Retain already-admitted work as a CHILD of the live record in scope.
   *
   * Used by a callback that must answer the provider before its deferred queue item
   * finishes: the child keeps the parent's authority and its own accounting,
   * survives the parent's settlement and local shutdown, and is released only by
   * its own `settle`. It never opens a new admission, so it cannot start unrelated
   * work. A missing, foreign or settled parent is refused; when the handoff is off
   * the returned handle is inert and legacy behavior is unchanged.
   */
  retainAdmission(boundary: EngagementMailHandoffBoundary): EngagementMailHandoffHandle {
    const disposition = createDisposition();
    if (!this.fenced()) {
      return {
        context: { boundary } as EngagementMailHandoffContext,
        disposition,
        settle: (): void => undefined,
      };
    }
    if (!RETENTION_BOUNDARIES.includes(boundary)) {
      this.refuse(boundary, 'boundary is not retentable');
    }
    const parent = this.liveRecord();
    if (!parent) {
      this.refuse(boundary, 'no live admitted parent to retain');
    }
    const child: AdmissionRecord = {
      boundary,
      admittedAtUtc: new Date().toISOString(),
      phaseAtAdmission: parent.phaseAtAdmission,
      disposition,
      live: true,
    };
    this.liveAdmissions.add(child);
    // Same accounting rules as any admitted unit: the child holds local closure
    // open until it settles itself, independently of its parent.
    bump(this.admittedWork, boundary);
    bump(this.activeWork, boundary);
    return {
      context: child,
      disposition,
      settle: (outcome?: Outcome) => {
        this.settleRecord(child, outcome ?? this.defaultSettleOutcome(child));
      },
    };
  }

  /** Outcome used when a handle is settled without an explicit one. */
  private defaultSettleOutcome(record: AdmissionRecord): Outcome {
    return record.disposition.hasReport() ? record.disposition.outcome() : 'settled';
  }

  /**
   * Bounded, content-free per-process readback for the existing authenticated
   * diagnostic surface. Configured phase, actual local drain and provider outcome
   * reconciliation are three separate things here:
   *  - configuredPhase is the boot selection and never changes;
   *  - localClosure is "admission closed here and no live local work", true even
   *    for a process that never admitted anything, and never borrowed from
   *    another task's counters;
   *  - outcomeReconciled is false while any unknown outcome remains, so local
   *    closure is never reported as provider success.
   */
  observation(): EngagementMailHandoffObservation | null {
    if (!this.fenced()) return null;
    const admittedTotal = total(this.admittedWork);
    const activeTotal = total(this.activeWork);
    return {
      processIdentity: `${this.taskIdentity()}:${process.pid}`,
      taskIdentity: this.taskIdentity(),
      releaseIdentity: process.env.RELEASE_SHA ?? 'UNVERIFIED',
      serviceName: this.serviceName,
      configuredPhase: this.config.phase,
      generation: this.config.generation,
      fenceUtc: this.config.fenceUtc,
      configuredAtUtc: this.configuredAtUtc,
      phaseSelectionMode: 'boot-static',
      admissionClosedLocally: this.admissionClosedLocally,
      liveAdmissionCount: this.liveAdmissions.size,
      initiationRefusals: { ...this.initiationRefusals },
      admittedWork: { ...this.admittedWork },
      activeWork: { ...this.activeWork },
      settledWork: { ...this.settledWork },
      failedWork: { ...this.failedWork },
      unknownWork: { ...this.unknownWork },
      admittedTotal,
      activeTotal,
      settledTotal: total(this.settledWork),
      failedTotal: total(this.failedWork),
      unknownTotal: total(this.unknownWork),
      localClosure: this.admissionClosedLocally && activeTotal === 0,
      outcomeReconciled: total(this.unknownWork) === 0,
    };
  }
}

export const mailHandoff = new EngagementMailHandoffBarrier();
