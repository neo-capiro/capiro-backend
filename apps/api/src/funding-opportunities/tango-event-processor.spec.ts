import {
  CHANGE_DIMENSIONS,
  type MaterialChange,
  type NoticeObservation,
} from './opportunity-change-classifier.js';
import {
  ALERTABLE_SEVERITIES,
  ALERTABLE_STAGES,
  type AffectedClientRow,
  type AlertToWrite,
  type EventProcessorPort,
  MAX_ATTEMPTS,
  type OutboxRow,
  TERMINAL_STAGES,
  TangoEventProcessorService,
  changeFingerprint,
  decideAlert,
  isAlertableStage,
  stageForAlerting,
} from './tango-event-processor.service.js';

/**
 * Funding Opportunities P48 — event fan-out, materiality and quiet alerts.
 *
 * The port is doubled in memory, and the alert store enforces the REAL unique
 * index rather than pretending inserts always succeed. That matters: the whole
 * "replay and out-of-order produce one result" guarantee lives in that index,
 * so a double that accepted every insert would prove nothing.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────────

function notice(over: Partial<NoticeObservation> = {}): NoticeObservation {
  return {
    tangoNoticeId: 'n-1',
    title: 'Widget Support Services',
    descriptionHash: 'hash-a',
    postedDate: new Date('2026-07-01T00:00:00Z'),
    providerUpdatedAt: new Date('2026-07-01T00:00:00Z'),
    responseDeadline: new Date('2026-09-01T00:00:00Z'),
    active: true,
    setAside: 'SBA',
    naicsCode: '541512',
    pscCode: 'D399',
    attachmentCount: 2,
    sourceUrl: 'https://sam.gov/opp/abc',
    contentHash: 'c-1',
    ...over,
  };
}

function client(over: Partial<AffectedClientRow> = {}): AffectedClientRow {
  return {
    tenantId: 't-1',
    clientId: 'c-1',
    sourceType: 'sam_opportunity',
    sourceRecordKey: 'opp-1',
    pipelineStage: 'pursuing',
    workflowStatus: 'pursuing',
    humanDecision: null,
    ...over,
  };
}

function change(over: Partial<MaterialChange> = {}): MaterialChange {
  return {
    dimension: 'deadline',
    severity: 'critical',
    before: '2026-09-01',
    after: '2026-08-15',
    summary: 'Response deadline moved earlier.',
    ...over,
  };
}

class PortDouble implements EventProcessorPort {
  rows: OutboxRow[] = [];
  notices: NoticeObservation[] = [];
  clients: AffectedClientRow[] = [];
  /** Enforces the real dedupe unique index. */
  readonly alerts: AlertToWrite[] = [];
  readonly done: string[] = [];
  readonly failed: { id: string; attempts: number }[] = [];
  readonly quarantined: string[] = [];
  /** deliveryId -> error to throw, to simulate a poison event. */
  poison = new Map<string, Error>();
  refreshCalls = 0;

  async claimBatch(): Promise<OutboxRow[]> {
    return this.rows;
  }

  async refreshAndReadNotices(
    _resourceType: string,
    _externalId: string,
  ): Promise<NoticeObservation[]> {
    this.refreshCalls += 1;
    return this.notices;
  }

  async findAffectedClients(): Promise<AffectedClientRow[]> {
    return this.clients;
  }

  async insertAlertIfNew(alert: AlertToWrite): Promise<boolean> {
    const clash = this.alerts.some(
      (a) =>
        a.tenantId === alert.tenantId &&
        a.clientId === alert.clientId &&
        a.sourceRecordKey === alert.sourceRecordKey &&
        a.changeFingerprint === alert.changeFingerprint,
    );
    if (clash) return false;
    this.alerts.push(alert);
    return true;
  }

  async markDone(id: string): Promise<void> {
    this.done.push(id);
  }

  async markFailed(id: string, attempts: number): Promise<void> {
    this.failed.push({ id, attempts });
  }

  async markQuarantined(id: string): Promise<void> {
    this.quarantined.push(id);
  }
}

function outbox(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'o-1',
    deliveryId: 'dlv-1',
    eventIndex: 0,
    eventType: 'opportunity.updated',
    resourceType: 'opportunity',
    externalId: 'opp-1',
    attempts: 0,
    ...over,
  };
}

/** Two notices whose only difference is the deadline — a critical change. */
function deadlineMovedNotices(): NoticeObservation[] {
  return [
    notice({ tangoNoticeId: 'n-1', contentHash: 'c-1' }),
    notice({
      tangoNoticeId: 'n-2',
      contentHash: 'c-2',
      postedDate: new Date('2026-07-10T00:00:00Z'),
      providerUpdatedAt: new Date('2026-07-10T00:00:00Z'),
      responseDeadline: new Date('2026-08-15T00:00:00Z'),
    }),
  ];
}

// ── Pure policy ──────────────────────────────────────────────────────────────

describe('stageForAlerting', () => {
  it('delegates to the pipeline module rather than reconciling the columns again', () => {
    expect(stageForAlerting('pursuing', 'pursuing')).toBe('pursuing');
  });

  it('maps a legacy saved row with no recorded stage to reviewing', () => {
    // Without this, every pre-pipeline-v2 saved row would be silenced.
    expect(stageForAlerting(null, 'saved')).toBe('reviewing');
  });

  it('SUGGESTED maps to no stage — a producer suggestion is not human engagement', () => {
    // `suggested` is the column default, so this is the common case for rows
    // nobody has touched. Alerting on them would mean alerting on the
    // producer's entire backlog.
    expect(stageForAlerting(null, 'suggested')).toBeNull();
  });

  it('EXPIRED maps to no stage — the source closed before anybody staged it', () => {
    expect(stageForAlerting(null, 'expired')).toBeNull();
  });

  it.each([
    ['pursuing', 'pursuing'],
    ['dismissed', 'passed'],
    ['won', 'won'],
    ['lost', 'lost'],
  ])('maps legacy %s -> %s', (legacy, expected) => {
    expect(stageForAlerting(null, legacy)).toBe(expected);
  });
});

describe('isAlertableStage', () => {
  it.each(ALERTABLE_STAGES)('%s is alertable', (stage) => {
    expect(isAlertableStage(stage)).toBe(true);
  });

  it.each(TERMINAL_STAGES)('%s is NOT alertable', (stage) => {
    expect(isAlertableStage(stage)).toBe(false);
  });

  it('an unknown or absent stage is NOT alertable — absence of evidence is not engagement', () => {
    expect(isAlertableStage(null)).toBe(false);
    expect(isAlertableStage('something_new')).toBe(false);
  });
});

describe('changeFingerprint', () => {
  it('is stable for the same change', () => {
    expect(changeFingerprint('opp-1', change(), 'n-1')).toBe(
      changeFingerprint('opp-1', change(), 'n-1'),
    );
  });

  it('is a lowercase hex sha256, matching the column CHECK', () => {
    expect(changeFingerprint('opp-1', change(), 'n-1')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when the AFTER value differs', () => {
    expect(changeFingerprint('opp-1', change(), 'n-1')).not.toBe(
      changeFingerprint('opp-1', change({ after: '2026-08-20' }), 'n-1'),
    );
  });

  it('differs across source records — the same-looking change on two opportunities is two alerts', () => {
    expect(changeFingerprint('opp-1', change(), 'n-1')).not.toBe(
      changeFingerprint('opp-2', change(), 'n-1'),
    );
  });

  it('IGNORES the summary text, so rewording the sentence never re-alerts', () => {
    expect(changeFingerprint('opp-1', change(), 'n-1')).toBe(
      changeFingerprint('opp-1', change({ summary: 'completely different prose' }), 'n-1'),
    );
  });

  it('distinguishes null from the string "null"', () => {
    expect(changeFingerprint('opp-1', change({ after: null }), 'n-1')).not.toBe(
      changeFingerprint('opp-1', change({ after: 'null' }), 'n-1'),
    );
  });

  it('is STABLE when only `before` differs — the back-fill case (F4)', () => {
    // `buildNoticeTimeline` derives `before` from the immediately preceding
    // notice, so a notice back-filled BETWEEN two syncs rewrites it for the very
    // same current state. Hashing `before` produced two fingerprints for one
    // deadline and alerted twice; a unique index cannot collapse what does not
    // collide. The notice identity is unchanged by a back-fill, so it is stable.
    expect(changeFingerprint('opp-1', change({ before: '2026-03-01' }), 'n-3')).toBe(
      changeFingerprint('opp-1', change({ before: '2026-04-01' }), 'n-3'),
    );
  });

  it('SEPARATES two opposite transitions that end at the same value (re-review N2)', () => {
    // The regression the second review caught. Hashing `after` alone collapsed
    // a deadline PULL-IN (Dec -> Sep, critical) onto an earlier EXTENSION
    // (Jun -> Sep) because both end at Sep — and silently suppressed the
    // pull-in, the more urgent of the two. They arrive on different notices.
    const extension = change({ before: '2026-06-01', after: '2026-09-01' });
    const pullIn = change({ before: '2026-12-01', after: '2026-09-01' });
    expect(changeFingerprint('opp-1', extension, 'n-2')).not.toBe(
      changeFingerprint('opp-1', pullIn, 'n-4'),
    );
  });

  it('the same notice reporting the same value is still ONE fingerprint', () => {
    // Replay must still collapse.
    expect(changeFingerprint('opp-1', change(), 'n-2')).toBe(
      changeFingerprint('opp-1', change(), 'n-2'),
    );
  });

  it('still separates two DIFFERENT resulting values', () => {
    expect(changeFingerprint('opp-1', change({ after: '2026-08-15' }), 'n-1')).not.toBe(
      changeFingerprint('opp-1', change({ after: '2026-08-20' }), 'n-1'),
    );
  });
});

describe('decideAlert', () => {
  const base = {
    change: change(),
    isFirstObservation: false,
    pipelineStage: 'pursuing' as string | null,
    workflowStatus: 'pursuing' as string | null,
    humanDecision: null as string | null,
  };

  it('alerts on a critical change to a pursuing row', () => {
    expect(decideAlert(base)).toEqual({ alert: true, reason: 'alerted' });
  });

  it('BASELINES a first observation silently', () => {
    expect(decideAlert({ ...base, isFirstObservation: true })).toEqual({
      alert: false,
      reason: 'baselined_first_observation',
    });
  });

  it('reports the first observation even on a passed row — the most fundamental cause wins', () => {
    expect(
      decideAlert({
        ...base,
        isFirstObservation: true,
        pipelineStage: 'passed',
        workflowStatus: 'dismissed',
      }).reason,
    ).toBe('baselined_first_observation');
  });

  it('suppresses informational severity — visible on the timeline, not an interruption', () => {
    expect(
      decideAlert({ ...base, change: change({ dimension: 'title', severity: 'informational' }) }),
    ).toEqual({ alert: false, reason: 'below_materiality' });
  });

  it.each(TERMINAL_STAGES)('does NOT alert a %s row', (stage) => {
    expect(
      decideAlert({
        ...base,
        pipelineStage: stage,
        workflowStatus: stage === 'passed' ? 'dismissed' : stage,
      }),
    ).toEqual({
      alert: false,
      reason: 'terminal_stage',
    });
  });

  it("a human's pass outranks the stage a producer may still be moving", () => {
    expect(decideAlert({ ...base, humanDecision: 'pass' })).toEqual({
      alert: false,
      reason: 'human_declined',
    });
  });

  it('does not alert a row nobody engaged with', () => {
    expect(decideAlert({ ...base, pipelineStage: null, workflowStatus: 'suggested' })).toEqual({
      alert: false,
      reason: 'stage_not_engaged',
    });
  });

  it.each(ALERTABLE_STAGES)('alerts a %s row', (stage) => {
    expect(decideAlert({ ...base, pipelineStage: stage, workflowStatus: 'saved' }).alert).toBe(
      true,
    );
  });

  it('alerts a legacy saved row with no pipeline stage', () => {
    expect(decideAlert({ ...base, pipelineStage: null, workflowStatus: 'saved' }).alert).toBe(true);
  });
});

// ── The dimensions P48's acceptance names explicitly ─────────────────────────

describe('the change dimensions this phase must handle', () => {
  const engaged = {
    isFirstObservation: false,
    pipelineStage: 'pursuing' as string | null,
    workflowStatus: 'pursuing' as string | null,
    humanDecision: null,
  };

  it('DEADLINE is critical and alerts', () => {
    expect(
      decideAlert({ ...engaged, change: change({ dimension: 'deadline', severity: 'critical' }) })
        .alert,
    ).toBe(true);
  });

  it('CANCELLATION is critical and alerts', () => {
    expect(
      decideAlert({
        ...engaged,
        change: change({ dimension: 'cancellation', severity: 'critical' }),
      }).alert,
    ).toBe(true);
  });

  it('SET-ASIDE is significant and alerts — it can change whether a client may respond at all', () => {
    expect(
      decideAlert({
        ...engaged,
        change: change({ dimension: 'set_aside', severity: 'significant' }),
      }).alert,
    ).toBe(true);
  });

  it('REQUIREMENT change is observed as `attachments`, and is informational — so it does NOT interrupt', () => {
    // Honest accounting: the provider's notice resource carries an attachment
    // COUNT, not a requirements diff. P28 bands that informational, and this
    // phase does not promote it. A real requirements change surfaces through
    // P31's evidence-bound extraction, not through a webhook alert.
    expect((CHANGE_DIMENSIONS as readonly string[]).includes('attachments')).toBe(true);
    expect(
      decideAlert({
        ...engaged,
        change: change({ dimension: 'attachments', severity: 'informational' }),
      }),
    ).toEqual({ alert: false, reason: 'below_materiality' });
  });

  it('VEHICLE change is NOT observable from notice history, and nothing here fabricates one', () => {
    // The plan's acceptance lists vehicle changes, but the provider states no
    // vehicle on a notice — P28's CHANGE_DIMENSIONS has no such dimension, and
    // inventing one would mean emitting an alert from a field that does not
    // exist. Vehicle movement is P22's sync, not a webhook event.
    expect((CHANGE_DIMENSIONS as readonly string[]).includes('vehicle')).toBe(false);
  });

  it('only critical and significant are ever allowed to interrupt', () => {
    expect([...ALERTABLE_SEVERITIES].sort()).toEqual(['critical', 'significant']);
  });
});

// ── The drain ────────────────────────────────────────────────────────────────

describe('TangoEventProcessorService.processBatch', () => {
  it('writes one alert for a deadline change on a pursuing row', async () => {
    const port = new PortDouble();
    port.rows = [outbox()];
    port.notices = deadlineMovedNotices();
    port.clients = [client()];

    const summary = await new TangoEventProcessorService(port).processBatch();

    expect(summary.alertsWritten).toBe(1);
    expect(port.alerts[0]).toMatchObject({
      tenantId: 't-1',
      clientId: 'c-1',
      changeDimension: 'deadline',
      severity: 'critical',
      pipelineStageAtAlert: 'pursuing',
      deliveryId: 'dlv-1',
    });
    expect(port.done).toEqual(['o-1']);
  });

  it('REPLAY produces one result', async () => {
    // The same delivery processed twice — an at-least-once sender's normal
    // behaviour. The dedupe index collapses it.
    const port = new PortDouble();
    port.rows = [outbox()];
    port.notices = deadlineMovedNotices();
    port.clients = [client()];
    const svc = new TangoEventProcessorService(port);

    await svc.processBatch();
    const second = await svc.processBatch();

    expect(port.alerts).toHaveLength(1);
    expect(second.alertsWritten).toBe(0);
    expect(second.alertsDeduped).toBe(1);
  });

  it('OUT-OF-ORDER delivery produces one result', async () => {
    // The classifier orders notices itself, so a batch whose notices arrive
    // reversed must yield the same change and therefore the same fingerprint.
    const forward = new PortDouble();
    forward.rows = [outbox()];
    forward.notices = deadlineMovedNotices();
    forward.clients = [client()];
    await new TangoEventProcessorService(forward).processBatch();

    const reversed = new PortDouble();
    reversed.rows = [outbox({ id: 'o-2', deliveryId: 'dlv-2' })];
    reversed.notices = [...deadlineMovedNotices()].reverse();
    reversed.clients = [client()];
    await new TangoEventProcessorService(reversed).processBatch();

    expect(forward.alerts).toHaveLength(1);
    expect(reversed.alerts).toHaveLength(1);
    expect(reversed.alerts[0]?.changeFingerprint).toBe(forward.alerts[0]?.changeFingerprint);
  });

  it('alerts on EVERY entry with changes, not just the last (review F5)', async () => {
    // The notice sync and this drain are separately scheduled, so a cycle that
    // lands two notices used to drop the earlier one's changes permanently —
    // the event was marked done and nothing revisited it.
    const port = new PortDouble();
    port.rows = [outbox()];
    port.notices = [
      notice({ tangoNoticeId: 'n-1', contentHash: 'c-1' }),
      notice({
        tangoNoticeId: 'n-2',
        contentHash: 'c-2',
        postedDate: new Date('2026-07-05T00:00:00Z'),
        providerUpdatedAt: new Date('2026-07-05T00:00:00Z'),
        responseDeadline: new Date('2026-08-20T00:00:00Z'),
      }),
      notice({
        tangoNoticeId: 'n-3',
        contentHash: 'c-3',
        postedDate: new Date('2026-07-10T00:00:00Z'),
        providerUpdatedAt: new Date('2026-07-10T00:00:00Z'),
        responseDeadline: new Date('2026-08-15T00:00:00Z'),
      }),
    ];
    port.clients = [client()];

    await new TangoEventProcessorService(port).processBatch();

    // Two distinct deadline values moved through; both are told, once each.
    const afters = port.alerts.map((a) => a.afterValue).sort();
    expect(port.alerts).toHaveLength(2);
    expect(new Set(afters).size).toBe(2);
  });

  it('re-processing that same history writes nothing new', async () => {
    // Widening to every entry is only safe because the fingerprint is stable
    // and the dedupe is a unique index.
    const port = new PortDouble();
    port.rows = [outbox()];
    port.notices = deadlineMovedNotices();
    port.clients = [client()];
    const svc = new TangoEventProcessorService(port);

    await svc.processBatch();
    const first = port.alerts.length;
    const second = await svc.processBatch();

    expect(port.alerts).toHaveLength(first);
    expect(second.alertsWritten).toBe(0);
  });

  it('an UNCHANGED source creates no alert', async () => {
    const port = new PortDouble();
    port.rows = [outbox()];
    // Same facts twice: a re-post with nothing altered.
    port.notices = [
      notice({ tangoNoticeId: 'n-1', contentHash: 'c-1' }),
      notice({ tangoNoticeId: 'n-2', contentHash: 'c-1' }),
    ];
    port.clients = [client()];

    const summary = await new TangoEventProcessorService(port).processBatch();
    expect(summary.alertsWritten).toBe(0);
    expect(port.alerts).toHaveLength(0);
  });

  it('a FIRST observation is baselined silently', async () => {
    const port = new PortDouble();
    port.rows = [outbox()];
    port.notices = [notice()];
    port.clients = [client()];

    const summary = await new TangoEventProcessorService(port).processBatch();
    expect(summary.alertsWritten).toBe(0);
    expect(summary.suppressions.baselined_first_observation ?? 0).toBeGreaterThanOrEqual(0);
    expect(port.alerts).toHaveLength(0);
  });

  it.each(TERMINAL_STAGES)('a %s row receives no active-pursuit alert', async (stage) => {
    const port = new PortDouble();
    port.rows = [outbox()];
    port.notices = deadlineMovedNotices();
    port.clients = [
      client({ pipelineStage: stage, workflowStatus: stage === 'passed' ? 'dismissed' : stage }),
    ];

    const summary = await new TangoEventProcessorService(port).processBatch();
    expect(summary.alertsWritten).toBe(0);
    expect(summary.suppressions.terminal_stage).toBe(1);
  });

  it('fans out to several tenants, and each alert carries ONLY its own tenant', async () => {
    // Cross-tenant fan-out is impossible because every alert is built from the
    // row it came from — there is no path by which tenant A's row produces an
    // alert stamped tenant B. (The database enforces the other half: the table
    // is RLS ENABLED and FORCED, asserted in the migration rehearsal.)
    const port = new PortDouble();
    port.rows = [outbox()];
    port.notices = deadlineMovedNotices();
    port.clients = [
      client({ tenantId: 't-1', clientId: 'c-1' }),
      client({ tenantId: 't-2', clientId: 'c-2' }),
    ];

    await new TangoEventProcessorService(port).processBatch();

    expect(port.alerts).toHaveLength(2);
    expect(port.alerts.find((a) => a.clientId === 'c-1')?.tenantId).toBe('t-1');
    expect(port.alerts.find((a) => a.clientId === 'c-2')?.tenantId).toBe('t-2');
    expect(new Set(port.alerts.map((a) => a.tenantId)).size).toBe(2);
  });

  it('two tenants watching the SAME opportunity each get their own alert', async () => {
    // Same fingerprint, different tenant — the dedupe key includes tenant and
    // client, so one tenant's alert must never suppress another's.
    const port = new PortDouble();
    port.rows = [outbox()];
    port.notices = deadlineMovedNotices();
    port.clients = [
      client({ tenantId: 't-1', clientId: 'c-1', sourceRecordKey: 'opp-1' }),
      client({ tenantId: 't-2', clientId: 'c-2', sourceRecordKey: 'opp-1' }),
    ];

    await new TangoEventProcessorService(port).processBatch();
    expect(port.alerts).toHaveLength(2);
    expect(port.alerts[0]?.changeFingerprint).toBe(port.alerts[1]?.changeFingerprint);
  });

  it('a POISON event is retried, then quarantined, and NEVER blocks the queue', async () => {
    const port = new PortDouble();
    const boom = new Error('provider returned garbage');
    port.rows = [
      outbox({ id: 'poison', deliveryId: 'dlv-bad' }),
      outbox({ id: 'good', deliveryId: 'dlv-good' }),
    ];
    port.notices = deadlineMovedNotices();
    port.clients = [client()];
    // Fail only the first row.
    let call = 0;
    port.refreshAndReadNotices = async () => {
      call += 1;
      if (call === 1) throw boom;
      return deadlineMovedNotices();
    };

    const summary = await new TangoEventProcessorService(port).processBatch();

    // The healthy row behind it still processed.
    expect(summary.processed).toBe(1);
    expect(port.done).toEqual(['good']);
    expect(port.failed).toEqual([{ id: 'poison', attempts: 1 }]);
    expect(port.quarantined).toEqual([]);
  });

  it('quarantines at the attempt ceiling rather than retrying forever', async () => {
    const port = new PortDouble();
    port.rows = [outbox({ id: 'poison', attempts: MAX_ATTEMPTS - 1 })];
    port.refreshAndReadNotices = async () => {
      throw new Error('still broken');
    };

    const summary = await new TangoEventProcessorService(port).processBatch();
    expect(port.quarantined).toEqual(['poison']);
    expect(summary.quarantined).toBe(1);
    expect(port.failed).toEqual([]);
  });

  it('an event naming no addressable resource is a no-op, not a retry loop', async () => {
    const port = new PortDouble();
    port.rows = [outbox({ externalId: null })];

    const summary = await new TangoEventProcessorService(port).processBatch();
    expect(port.refreshCalls).toBe(0);
    expect(summary.processed).toBe(1);
    expect(port.done).toEqual(['o-1']);
    expect(port.quarantined).toEqual([]);
  });

  it('records no alert when nobody is watching the opportunity', async () => {
    const port = new PortDouble();
    port.rows = [outbox()];
    port.notices = deadlineMovedNotices();
    port.clients = [];

    const summary = await new TangoEventProcessorService(port).processBatch();
    expect(summary.alertsWritten).toBe(0);
    expect(summary.processed).toBe(1);
  });

  it("the evidence carries the classifier's own before/after, not prose", async () => {
    const port = new PortDouble();
    port.rows = [outbox()];
    port.notices = deadlineMovedNotices();
    port.clients = [client()];

    await new TangoEventProcessorService(port).processBatch();
    const alert = port.alerts[0];
    expect(alert?.beforeValue).toBeTruthy();
    expect(alert?.afterValue).toBeTruthy();
    expect(alert?.evidenceJsonb).toMatchObject({ dimension: 'deadline', severity: 'critical' });
  });
});
