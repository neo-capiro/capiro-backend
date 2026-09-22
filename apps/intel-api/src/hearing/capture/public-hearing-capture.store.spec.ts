import { OptimisticCaptureWriteError, PublicHearingCaptureStore, StaleCaptureFencingTokenError } from './public-hearing-capture.store.js';
describe('PublicHearingCaptureStore SQL guards',()=>{
  it('checks renewal expiry at database execution time instead of a queued request timestamp', async () => {
    const raw = jest.fn().mockResolvedValue([]);
    const store = new PublicHearingCaptureStore({ $queryRawUnsafe: raw } as never);
    const requestedAt = new Date('2026-09-06T10:00:00Z');
    await expect(store.renewLease({
      captureId: 'c', ownerId: 'worker', fencingToken: 7,
      now: requestedAt, leaseDurationMs: 60_000,
    })).rejects.toBeInstanceOf(StaleCaptureFencingTokenError);
    const sql = raw.mock.calls[0]![0] as string;
    expect(sql).toContain('worker_lease_owner=$2 AND fencing_token=$5');
    expect(sql).toContain('lease_expires_at > clock_timestamp()');
    expect(sql).not.toContain('lease_expires_at > $3');
  });

  it('uses database conflict idempotency',async()=>{ const raw=jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{id:'c',hearingId:'h',status:'SCHEDULED',version:1,resolutionState:'NOT_CHECKED',consecutiveSourceErrors:0,fencingToken:0,capturedMs:0,gaps:[]}]);
    const store=new PublicHearingCaptureStore({$queryRawUnsafe:raw} as never); await store.ensureCapture({hearingId:'h',idempotencyKey:'k',now:new Date()}); expect(raw.mock.calls[0][0]).toContain('ON CONFLICT (hearing_id) DO NOTHING'); });
  it('distinguishes optimistic and stale fencing failures',async()=>{ const raw=jest.fn().mockResolvedValue([]); const store=new PublicHearingCaptureStore({$queryRawUnsafe:raw} as never);
    await expect(store.saveState({captureId:'c',expectedVersion:1,next:{status:'PREPARING',version:2,updatedAt:new Date()}})).rejects.toBeInstanceOf(OptimisticCaptureWriteError);
    await expect(store.renewLease({captureId:'c',ownerId:'wrong',fencingToken:1,now:new Date(),leaseDurationMs:1000})).rejects.toBeInstanceOf(StaleCaptureFencingTokenError); });
});

describe('PublicHearingCaptureStore capture-all and jurisdiction switches', () => {
  const STATE_FLAG = 'LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED';
  const CAPTURE_ALL = 'LEGIWATCH_CAPTURE_ALL_PUBLIC_EVENTS';
  const previous = { state: process.env[STATE_FLAG], captureAll: process.env[CAPTURE_ALL] };
  beforeEach(() => {
    delete process.env[STATE_FLAG];
    delete process.env[CAPTURE_ALL];
  });
  afterAll(() => {
    for (const [key, value] of [
      [STATE_FLAG, previous.state],
      [CAPTURE_ALL, previous.captureAll],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function storeWith(input: {
    stateRows?: Array<{ id: string }>;
    cutover?: Array<{ enabled: boolean | null }> | Error;
    count?: number;
  } = {}) {
    const cutoverRead = jest.fn(async (..._args: [TemplateStringsArray, ...unknown[]]) => {
      if (input.cutover instanceof Error) throw input.cutover;
      return input.cutover ?? [];
    });
    const systemUnsafe = jest.fn(async (..._args: unknown[]) => [{ count: input.count ?? 0 }]);
    const jurisdictionProbe = jest.fn(async (..._args: unknown[]) => input.stateRows ?? []);
    const directUnsafe = jest.fn(async (..._args: unknown[]) => [] as unknown[]);
    const tx = { $queryRaw: cutoverRead, $queryRawUnsafe: systemUnsafe };
    const withSystem = jest.fn(async (operation: (value: typeof tx) => unknown) => operation(tx));
    const store = new PublicHearingCaptureStore({
      $queryRaw: jurisdictionProbe,
      $queryRawUnsafe: directUnsafe,
      withSystem,
    } as never);
    return { store, cutoverRead, systemUnsafe, jurisdictionProbe, directUnsafe, withSystem };
  }

  it('reads capture-all from legiwatch_cutover_state (planner switch) even with the env unset', async () => {
    const h = storeWith({ cutover: [{ enabled: true }], count: 0 });
    await expect(h.store.getDemand('h')).resolves.toEqual({
      activeSubscriptionCount: 0,
      globalCoverageRequested: true,
    });
    const call = h.cutoverRead.mock.calls[0];
    const sql = call ? call[0].join('?') : '';
    expect(sql).toContain("FROM legiwatch_cutover_state WHERE id='global'");
    expect(sql).toContain('capture_all_public_events');
  });

  it('caches the capture-all read for the scan window instead of querying per hearing', async () => {
    const h = storeWith({ cutover: [{ enabled: true }] });
    await h.store.getDemand('h1');
    await h.store.getDemand('h2');
    await h.store.listDueHearingIds(new Date());
    expect(h.cutoverRead).toHaveBeenCalledTimes(1);
    // listDueHearingIds' own $queryRawUnsafe call is (sql, now, captureAll, types).
    expect(h.systemUnsafe.mock.calls.at(-1)![2]).toBe(true);
  });

  it('falls back to the env switch when the row is false, missing, or unreadable', async () => {
    await expect(storeWith({ cutover: [{ enabled: false }] }).store.getDemand('h')).resolves.toMatchObject({
      globalCoverageRequested: false,
    });
    await expect(storeWith({ cutover: [] }).store.getDemand('h')).resolves.toMatchObject({
      globalCoverageRequested: false,
    });
    process.env[CAPTURE_ALL] = 'true';
    await expect(storeWith({ cutover: [{ enabled: false }] }).store.getDemand('h')).resolves.toMatchObject({
      globalCoverageRequested: true,
    });
    const broken = storeWith({ cutover: new Error('relation "legiwatch_cutover_state" does not exist'), count: 2 });
    await expect(broken.store.getDemand('h')).resolves.toEqual({
      activeSubscriptionCount: 2,
      globalCoverageRequested: true,
    });
  });

  it('zeroes non-US demand while the state switch is off and counts it once on', async () => {
    const off = storeWith({ stateRows: [{ id: 'hearing-fl' }], cutover: [{ enabled: true }], count: 3 });
    await expect(off.store.getDemand('hearing-fl')).resolves.toEqual({
      activeSubscriptionCount: 0,
      globalCoverageRequested: false,
    });
    expect(off.withSystem).not.toHaveBeenCalled();

    process.env[STATE_FLAG] = 'true';
    const on = storeWith({ stateRows: [{ id: 'hearing-fl' }], cutover: [{ enabled: true }], count: 3 });
    await expect(on.store.getDemand('hearing-fl')).resolves.toEqual({
      activeSubscriptionCount: 3,
      globalCoverageRequested: true,
    });
    expect(on.jurisdictionProbe).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'federal_committee_hearing'],
    ['true', 'capturable_committee_hearing'],
  ])('reads hearings and the due scan from the %s-gated view: %s', async (flag, view) => {
    if (flag === undefined) delete process.env[STATE_FLAG];
    else process.env[STATE_FLAG] = flag;
    const h = storeWith({ cutover: [{ enabled: false }] });
    await h.store.getHearing('h');
    expect(h.directUnsafe.mock.calls[0]![0]).toContain(`FROM ${view}\n`);
    await h.store.listDueHearingIds(new Date());
    expect(h.systemUnsafe.mock.calls.at(-1)![0]).toContain(`FROM ${view} h`);
    expect(h.systemUnsafe.mock.calls.at(-1)![2]).toBe(false);
  });
});

describe('PublicHearingCaptureStore.ensureCapture reschedule propagation (2026-09-04)',()=>{
  const existingRow={id:'c',hearingId:'h',status:'SCHEDULED',version:1,resolutionState:'NOT_CHECKED',consecutiveSourceErrors:0,fencingToken:0,capturedMs:0,gaps:[]};
  it('propagates the corrected start into an existing SCHEDULED capture (no second row)',async()=>{
    const raw=jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{...existingRow,scheduledStart:new Date('2026-09-04T20:00:00Z')}]).mockResolvedValueOnce([{...existingRow}]);
    const store=new PublicHearingCaptureStore({$queryRawUnsafe:raw} as never);
    const out=await store.ensureCapture({hearingId:'h',idempotencyKey:'k',scheduledStart:new Date('2026-09-04T20:00:00Z'),now:new Date()});
    const updateSql=raw.mock.calls[1][0] as string;
    expect(updateSql).toContain("domain_status IN ('SCHEDULED','PREPARING','WAITING_FOR_STREAM','READY')");
    // REGRESSION (disposable-PG proof 2026-09-03): the physical status column is
    // legacy-lowercase ('scheduled','leased',...) — an uppercase allowlist on
    // bare `status` matched ZERO real rows, so propagation silently no-oped.
    // The allowlist MUST target domain_status (word-boundary before status).
    expect(updateSql).not.toMatch(/(^|[^_])status IN \('SCHEDULED'/);
    expect(updateSql).toContain('actual_start IS NULL');
    expect(out.hearingId).toBe('h'); // the SAME capture row (idempotent upsert), propagation asserted via the SQL allowlist above
  });
  it('never rewrites a terminal or already-started capture (SQL allowlist)',async()=>{
    const raw=jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([existingRow]);
    const store=new PublicHearingCaptureStore({$queryRawUnsafe:raw} as never);
    await store.ensureCapture({hearingId:'h',idempotencyKey:'k',scheduledStart:new Date('2026-09-04T20:00:00Z'),now:new Date()});
    const sql=raw.mock.calls[1][0] as string;
    for(const terminal of ['COMPLETE','COMPLETE_WITH_GAPS','FAILED','CANCELED','BLOCKED','CAPTURING']) expect(sql).not.toContain(`'${terminal}',` .trim());
    expect(sql).toContain('actual_start IS NULL');
  });
});
