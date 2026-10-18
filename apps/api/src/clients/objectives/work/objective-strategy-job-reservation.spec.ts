import { createHash } from 'node:crypto';
import { createObjectiveStrategyRequestCodec, lockObjectiveStrategyIntakeWithinTx, lockObjectiveStrategyJobCreatorsWithinTx,
  lockObjectiveStrategyOutputWithinTx, requireObjectiveStrategyJobInventory } from '@capiro/shared/objective-strategy-intake';
import { createObjectiveStrategyReservationWithinTx } from './objective-strategy-job-reservation.js';

const id = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const codec = createObjectiveStrategyRequestCodec({ sha256: text => createHash('sha256').update(text).digest('hex'),
  invalidRequest: () => { throw Error('invalid'); } });
/** Actual source/codec, explicitly synthetic native SQL and insertion port. */
async function fixture() {
  const events: Array<{ sql: string; values: any[] }> = [];
  const draft = { requestId: id(1), clientId: id(2), objective: { objectiveId: id(3), objectiveVersion: 7 }, type: 'earmark' as const };
  const s: any = { jobs: [], native: null, inserts: [] };
  const tx: any = { $queryRawUnsafe: async (sql: string, ...values: any[]) => {
    events.push({ sql, values });
    if (sql.includes('pg_advisory_xact_lock')) return [{}];
    if (sql.includes('LIMIT 129 FOR UPDATE NOWAIT')) return s.jobs;
    if (sql.includes('FROM client_objective_strategy_intakes')) return s.native ? [s.native] : [];
    if (sql.includes('INSERT INTO sp_draft_job')) { s.inserts.push(values); return [{ id: values[0] }]; }
    throw Error('unexpected SQL');
  } };
  const inventory = await lockObjectiveStrategyIntakeWithinTx(tx, id(9));
  const input = { inventory, intakeId: id(4), generationJobId: id(5), tenantId: id(9), clientId: id(2), objectiveId: id(3),
    consentId: id(6), commandReceiptId: id(7), wrapperSha256: 'a'.repeat(64), originalClerkUserId: 'user_original',
    typedRequest: draft, requestFingerprint: codec.digest(draft), jobRequestKey: codec.requestKey(id(9), 'user_original', id(1)),
    source: { clientId: id(2), objectiveId: id(3), objectiveVersion: 7, objectiveRevisionId: id(8) },
    intentOutcome: 'The actual ready outcome', originalDeadlineAtMs: 5000 };
  s.native = { intake: { id: id(4), generation_job_id: id(5), tenant_id: id(9), client_id: id(2), objective_id: id(3),
    work_action: 'objective.strategy.draft', consent_id: id(6), command_receipt_id: id(7), wrapper_sha256: 'a'.repeat(64),
    original_clerk_user_id: 'user_original', selected_type: 'earmark', generation_request_id: id(1), typed_request: structuredClone(draft),
    request_fingerprint: input.requestFingerprint, job_request_key: input.jobRequestKey, source_revision_id: id(8), source_objective_version: 7 },
    consent: {}, receipt: {}, deadlineMs: '5000', reservedMs: '1000', consentExpiresMs: '5000',
    snapshot: { id: id(3), clientId: id(2), version: 7, status: 'ready', deletedAt: null, outcome: input.intentOutcome } };
  return { input, tx, s, events };
}
describe('native Strategy job reservation source', () => {
  test('creator gate returns a Prisma-supported scalar on the same transaction and original lock key', async () => {
    const calls: Array<{ sql: string; values: any[] }> = [];
    const expected = 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text';
    // Explicitly synthetic Prisma result decoding, matching the native void
    // failure. This is source regression coverage, not PostgreSQL execution.
    const tx = { $queryRawUnsafe: async function<T>(sql: string, ...values: any[]): Promise<T> {
      expect(this).toBe(tx); calls.push({ sql, values });
      if (sql !== expected) throw Error('Failed to deserialize column of type void');
      return [{ pg_advisory_xact_lock: '' }] as T;
    } };
    await lockObjectiveStrategyJobCreatorsWithinTx(tx, id(9));
    expect(calls).toEqual([{ sql: expected, values: [`capiro.objective-strategy.job-creators:v1:${id(9)}`] }]);
  });
  test('locks complete tenant inventory before a fresh actual job insert, with original deadline and no admission', async () => {
    const f = await fixture();
    await expect(createObjectiveStrategyReservationWithinTx(f.tx, f.input)).resolves.toEqual({ intakeId: id(4), generationJobId: id(5) });
    expect(f.events[0]!.sql).toContain('pg_advisory_xact_lock');
    expect(f.events[1]!.sql).toContain('ORDER BY id LIMIT 129 FOR UPDATE NOWAIT');
    expect(f.events[1]!.sql).not.toMatch(/SKIP LOCKED|status\s*=|client_id\s*=/);
    const values = f.s.inserts[0], stored = JSON.parse(values[5]);
    expect(f.events.find(e => e.sql.includes('INSERT INTO sp_draft_job'))!.sql).toContain("$7::timestamptz AT TIME ZONE 'UTC'");
    expect(values[6]).toBe(new Date(5000).toISOString());
    expect(stored.objectiveCanonicalReservation).toEqual({ schemaVersion: 1, intakeId: id(4), consentId: id(6),
      commandReceiptId: id(7), wrapperSha256: 'a'.repeat(64) });
    expect(stored).not.toHaveProperty('canonicalGeneration');
    expect(stored.objectiveGeneration).toEqual({ request: f.input.typedRequest, fingerprint: f.input.requestFingerprint,
      receipt: codec.pendingReceipt(f.input.typedRequest, f.input.source) });
    expect(f.events.filter(e => /FOR UPDATE/.test(e.sql))).toHaveLength(1);
  });
  test('inventory capability is transaction and tenant bound, detached and immutable', async () => {
    const f = await fixture();
    expect(Object.isFrozen(f.input.inventory.jobs)).toBe(true);
    expect(() => requireObjectiveStrategyJobInventory({} as any, id(9), f.input.inventory)).toThrow();
    expect(() => requireObjectiveStrategyJobInventory(f.tx, id(99), f.input.inventory)).toThrow();
    expect(() => requireObjectiveStrategyJobInventory(f.tx, id(9), { jobs: [] } as any)).toThrow();
  });
  test('forged inventory refuses before native reads or inserts', async () => {
    const f = await fixture(); f.events.length = 0;
    await expect(createObjectiveStrategyReservationWithinTx(f.tx, { ...f.input, inventory: { jobs: [] } as any })).rejects.toThrow();
    expect(f.events).toHaveLength(0);
  });
  test('overflow and NOWAIT contention refuse rather than skip occupied jobs', async () => {
    const f = await fixture();
    f.s.jobs = Array.from({ length: 129 }, (_, n) => ({ id: id(n + 100), tenantId: id(9) }));
    await expect(lockObjectiveStrategyIntakeWithinTx(f.tx, id(9))).rejects.toThrow();
    f.tx.$queryRawUnsafe = async (sql: string) => { if (sql.includes('FOR UPDATE')) throw Error('55P03'); return []; };
    await expect(lockObjectiveStrategyIntakeWithinTx(f.tx, id(9))).rejects.toThrow('55P03');
    expect(f.s.inserts).toHaveLength(0);
  });
  test.each(['generation_job_id', 'tenant_id', 'client_id', 'objective_id', 'consent_id', 'command_receipt_id',
    'wrapper_sha256', 'original_clerk_user_id', 'selected_type', 'generation_request_id', 'request_fingerprint',
    'job_request_key', 'source_revision_id', 'source_objective_version'])('mismatched native %s cannot create a job', async key => {
    const f = await fixture(); f.s.native.intake[key] = 'wrong';
    await expect(createObjectiveStrategyReservationWithinTx(f.tx, f.input)).rejects.toThrow();
    expect(f.s.inserts).toHaveLength(0);
  });
  test('missing native association and changed original deadline cannot create jobs', async () => {
    const f = await fixture(); f.s.native = null;
    await expect(createObjectiveStrategyReservationWithinTx(f.tx, f.input)).rejects.toThrow();
    const g = await fixture(); g.s.native.deadlineMs = '6000';
    await expect(createObjectiveStrategyReservationWithinTx(g.tx, g.input)).rejects.toThrow();
    expect(g.s.inserts).toHaveLength(0);
  });
  test('all request scalars and nested source are captured before first await', async () => {
    const f = await fixture(); const original = f.tx.$queryRawUnsafe;
    f.tx.$queryRawUnsafe = async (sql: string, ...v: any[]) => {
      if (sql.includes('FROM client_objective_strategy_intakes')) {
        f.input.typedRequest.type = 'coalition' as any; f.input.source.objectiveVersion = 99;
        f.input.originalClerkUserId = 'user_other'; f.input.originalDeadlineAtMs = 10000;
      }
      return original(sql, ...v);
    };
    await createObjectiveStrategyReservationWithinTx(f.tx, f.input);
    const stored = JSON.parse(f.s.inserts[0][5]);
    expect(stored.dto.type).toBe('earmark'); expect(stored.objectiveGeneration.receipt.source.objectiveVersion).toBe(7);
    expect(f.s.inserts[0][3]).toBe('user_original'); expect(f.s.inserts[0][6]).toBe(new Date(5000).toISOString());
  });
  test('legacy hash convention preserves Date and numeric-key vectors', () => {
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(codec.digest({ at: new Date(1000), b: 1, a: { '10': 1, '2': 2 } })).toBe(
      hash('{"a":{"2":2,"10":1},"at":"1970-01-01T00:00:01.000Z","b":1}'));
  });
  test('global output gate calls the native trigger owner function without duplicating its namespace', async () => {
    const calls: any[] = [], tx = { $queryRawUnsafe: async <T>(sql: string, ...values: any[]): Promise<T> => {
      calls.push({ sql, values }); return [{ acquired: true }] as T;
    } };
    await lockObjectiveStrategyOutputWithinTx(tx, id(12));
    expect(calls).toEqual([{ sql: 'SELECT public.objective_strategy_output_gate($1::uuid) AS acquired', values: [id(12)] }]);
  });
  test.each([[], [{ acquired: false }], [{ acquired: null }], [{ acquired: true }, { acquired: true }]].map(rows => ({ rows })))(
    'missing/false/ambiguous global output acquisition refuses %j', async ({ rows }) => {
      await expect(lockObjectiveStrategyOutputWithinTx({ $queryRawUnsafe: async <T>() => rows as T }, id(12))).rejects.toThrow();
    });
  test('global gate rejects noncanonical UUID before native IO', async () => {
    const tx = { $queryRawUnsafe: jest.fn() };
    await expect(lockObjectiveStrategyOutputWithinTx(tx, `${id(12)}\n`)).rejects.toThrow();
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
