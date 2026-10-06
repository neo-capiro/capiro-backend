import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PublicHearingCaptureStore } from './public-hearing-capture.store.js';
import { PublicCaptureAutomaticResolverAdapter } from './public-capture-automatic-resolver.adapter.js';
import {
  PublicCaptureOrchestrator,
  PublicCaptureWorkerCoordinator,
} from './public-capture.orchestrator.js';
import { PublicCapturePersistentQueueAdapter } from './public-capture-persistent-queue.adapter.js';

// Run only against the fully migrated disposable qualification database.
const describeDb =
  process.env.DATABASE_URL && process.env.CAPIRO_DISPOSABLE_PG === '1' ? describe : describe.skip;
describeDb('late-source recovery on native PostgreSQL', () => {
  const prisma = new PrismaService();
  const prefix = `late-source-${randomUUID()}`;
  const fixtures: Array<{ hearing: string; capture: string; source: string; candidate: string }> =
    [];
  const priorAll = process.env.LEGIWATCH_CAPTURE_ALL_PUBLIC_EVENTS;
  const priorState = process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED;
  let store: PublicHearingCaptureStore;
  const media = {
    url: 'https://www-senate-gov-media-srs.akamaized.net/live/master.m3u8',
    kind: 'hls' as const,
    provider: 'senate-isvp',
  };
  beforeAll(() => {
    process.env.LEGIWATCH_CAPTURE_ALL_PUBLIC_EVENTS = 'true';
    process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = 'true';
    store = new PublicHearingCaptureStore(prisma);
  });
  afterAll(async () => {
    await prisma.withSystem(async (tx) => {
      for (const f of fixtures) {
        await tx.$executeRawUnsafe(
          'DELETE FROM public_hearing_capture_job WHERE hearing_id=$1',
          f.hearing,
        );
        await tx.$executeRawUnsafe(
          'DELETE FROM intel_public_hearing_audio_epoch WHERE hearing_id=$1',
          f.hearing,
        );
        await tx.$executeRawUnsafe(
          'DELETE FROM public_hearing_capture WHERE hearing_id=$1',
          f.hearing,
        );
        await tx.$executeRawUnsafe(
          'DELETE FROM hearing_stream_candidate WHERE hearing_id=$1',
          f.hearing,
        );
        await tx.$executeRawUnsafe(
          'DELETE FROM hearing_source_observation WHERE hearing_id=$1',
          f.hearing,
        );
        await tx.$executeRawUnsafe('DELETE FROM committee_source WHERE id=$1', f.source);
        await tx.$executeRawUnsafe('DELETE FROM committee_hearing WHERE id=$1', f.hearing);
      }
    });
    if (priorAll === undefined) delete process.env.LEGIWATCH_CAPTURE_ALL_PUBLIC_EVENTS;
    else process.env.LEGIWATCH_CAPTURE_ALL_PUBLIC_EVENTS = priorAll;
    if (priorState === undefined) delete process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED;
    else process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = priorState;
    await prisma.$disconnect();
  });
  async function seed() {
    const f = {
      hearing: `${prefix}-${fixtures.length}`,
      capture: randomUUID(),
      source: randomUUID(),
      candidate: randomUUID(),
    };
    fixtures.push(f);
    await prisma.withSystem(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO committee_hearing(id,chamber,committee_name,title,date,starts_at,type,url,visibility,event_status)
        VALUES($1,'senate','Recovery QA','Late source',CURRENT_DATE,now()+interval '5 minutes','Open Hearing','https://www.senate.gov/hearing/late','public','scheduled')`,
        f.hearing,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO committee_source(id,chamber,source_type,source_url,adapter_key)
        VALUES($1,'senate','SENATE_SCHEDULE','https://www.senate.gov/schedule/'||$1,'late-source-test')`,
        f.source,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO hearing_source_observation(id,hearing_id,source_id,external_event_id,raw_content_hash)
        VALUES($1,$2,$3,$2,'fixture')`,
        randomUUID(),
        f.hearing,
        f.source,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO public_hearing_capture(id,hearing_id,status,domain_status,terminal_reason_code,
        resolution_state,resolution_reason_code,resolution_capture_policy,last_resolution_at)
        VALUES($1,$2,'no_stream','BLOCKED','CAPTURE_BLOCKED','BROWSER_CAPTURE_ONLY','YOUTUBE_BROWSER_ONLY','BROWSER_CAPTURE_ONLY',now()-interval '2 minutes')`,
        f.capture,
        f.hearing,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO hearing_stream_candidate(id,hearing_id,source_id,provider,official_page_url,first_seen_at)
        VALUES($1,$2,$3,'senate-isvp','https://www.senate.gov/hearing/new',now()-interval '1 minute')`,
        f.candidate,
        f.hearing,
        f.source,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO hearing_stream_candidate(id,hearing_id,provider,official_page_url,media_url,first_seen_at,capture_policy)
        VALUES($1,$2,'youtube','https://www.senate.gov/hearing/new','https://youtube.com/watch?v=old',now()-interval '3 minutes','BROWSER_CAPTURE_ONLY')`,
        f.candidate + '-old',
        f.hearing,
      );
    });
    return f;
  }
  async function state(f: { capture: string }) {
    return (
      await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'SELECT * FROM public_hearing_capture WHERE id=$1',
        f.capture,
      )
    )[0]!;
  }
  async function probe(f: { capture: string }) {
    const candidate = await store.getBlockedRecoveryCandidate(f.capture, new Date());
    expect(candidate).not.toBeNull();
    const adapter = new PublicCaptureAutomaticResolverAdapter(prisma, {
      resolve: async () => ({ status: 'resolved', media }),
    } as never);
    return (await adapter.probeBlockedRecoveryCandidate(candidate!))!;
  }

  it('discovers an unprobed new candidate while BLOCKED, probes it, and queues exactly once through the ordinary orchestrator', async () => {
    const f = await seed();
    expect(await store.listDueHearingIds(new Date())).toContain(f.hearing);
    const rawResolver = jest.fn(async () => {
      expect((await state(f)).domain_status).toBe('BLOCKED');
      return { status: 'resolved', media };
    });
    const adapter = new PublicCaptureAutomaticResolverAdapter(prisma, {
      resolve: rawResolver,
    } as never);
    const queue = new PublicCapturePersistentQueueAdapter(prisma);
    const orchestrator = new PublicCaptureOrchestrator(store, adapter, queue);
    expect(await orchestrator.reconcile(f.hearing)).toMatchObject({
      action: 'CAPTURE_JOB_ENQUEUED',
      enqueued: true,
    });
    const recovered = await state(f);
    expect(recovered).toMatchObject({
      domain_status: 'READY',
      terminal_reason_code: null,
      captured_ms: 0,
      selected_stream_candidate_id: f.candidate,
    });
    const jobs = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM public_hearing_capture_job WHERE hearing_id=$1 AND job_type='capture'`,
      f.hearing,
    );
    const oldCandidate = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'SELECT capture_policy,last_probe_at FROM hearing_stream_candidate WHERE id=$1',
      f.candidate + '-old',
    );
    expect(oldCandidate[0]).toEqual({
      capture_policy: 'BROWSER_CAPTURE_ONLY',
      last_probe_at: null,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'pending', capture_id: f.capture });
    expect(await store.getBlockedRecoveryCandidate(f.capture, new Date())).toBeNull();
    // The ordinary worker still re-resolves. A source becoming browser-only
    // after enqueue cannot reach media ingestion, despite the successful probe.
    const resolveAgain = jest.fn(async () => ({
      status: 'unresolvable' as const,
      note: 'YouTube browser-only source',
    }));
    const runtime = { run: jest.fn() };
    const worker = new PublicCaptureWorkerCoordinator(store, { resolve: resolveAgain }, runtime);
    expect(
      await worker.run({ captureId: f.capture, hearingId: f.hearing, workerId: 'test-worker' }),
    ).toMatchObject({ action: 'NO_LONGER_CAPTURABLE' });
    expect(resolveAgain).toHaveBeenCalledTimes(1);
    expect(runtime.run).not.toHaveBeenCalled();
  });

  const refused = [
    [
      'manual stop',
      "UPDATE public_hearing_capture SET terminal_reason_code='MANUAL_STOP' WHERE id=$1",
      'capture',
    ],
    [
      'failed',
      "UPDATE public_hearing_capture SET domain_status='FAILED',status='failed' WHERE id=$1",
      'capture',
    ],
    [
      'completed',
      "UPDATE public_hearing_capture SET domain_status='COMPLETE',status='ended' WHERE id=$1",
      'capture',
    ],
    [
      'canceled capture',
      "UPDATE public_hearing_capture SET domain_status='CANCELED' WHERE id=$1",
      'capture',
    ],
    [
      'recorded milliseconds',
      'UPDATE public_hearing_capture SET captured_ms=1 WHERE id=$1',
      'capture',
    ],
    ['started', 'UPDATE public_hearing_capture SET actual_start=now() WHERE id=$1', 'capture'],
    [
      'expired prior lease',
      "UPDATE public_hearing_capture SET worker_lease_owner='old',lease_expires_at=now()-interval '1 minute' WHERE id=$1",
      'capture',
    ],
    ['closed', "UPDATE committee_hearing SET visibility='private' WHERE id=$1", 'hearing'],
    [
      'canceled event',
      "UPDATE committee_hearing SET event_status='canceled' WHERE id=$1",
      'hearing',
    ],
    [
      'completed event',
      "UPDATE committee_hearing SET event_status='completed' WHERE id=$1",
      'hearing',
    ],
    ['unknown time', 'UPDATE committee_hearing SET starts_at=NULL WHERE id=$1', 'hearing'],
    [
      'outside grace',
      "UPDATE committee_hearing SET starts_at=now()-interval '91 minutes' WHERE id=$1",
      'hearing',
    ],
    [
      'outside horizon',
      "UPDATE committee_hearing SET starts_at=now()+interval '15 days' WHERE id=$1",
      'hearing',
    ],
    ['unknown type', "UPDATE committee_hearing SET type='Unknown' WHERE id=$1", 'hearing'],
    ['disabled source', 'UPDATE committee_source SET enabled=false WHERE id=$1', 'source'],
    [
      'unproven source',
      'UPDATE hearing_stream_candidate SET source_id=NULL WHERE id=$1',
      'candidate',
    ],
    [
      'old identity refreshed',
      "UPDATE hearing_stream_candidate SET first_seen_at=now()-interval '3 minutes',updated_at=now() WHERE id=$1",
      'candidate',
    ],
    [
      'third-party transport',
      "UPDATE hearing_stream_candidate SET media_url='https://youtube.com/watch?v=123' WHERE id=$1",
      'candidate',
    ],
    [
      'expired source',
      "UPDATE hearing_stream_candidate SET expires_at=now()-interval '1 second' WHERE id=$1",
      'candidate',
    ],
    [
      'paced probe',
      'UPDATE hearing_stream_candidate SET last_probe_at=now() WHERE id=$1',
      'candidate',
    ],
  ] as const;
  it.each(refused)('preserves %s without a probe or reopen', async (_name, sql, key) => {
    const f = await seed();
    await prisma.$executeRawUnsafe(sql, f[key]);
    const before = await state(f);
    expect(await store.getBlockedRecoveryCandidate(f.capture, new Date())).toBeNull();
    expect(await store.listDueHearingIds(new Date())).not.toContain(f.hearing);
    expect(await state(f)).toEqual(before);
  });

  it.each(['attempt', 'segment', 'epoch'] as const)(
    'does not reopen retained %s history',
    async (kind) => {
      const f = await seed();
      await prisma.withSystem(async (tx) => {
        if (kind === 'attempt')
          await tx.$executeRawUnsafe(
            `INSERT INTO public_hearing_capture_attempt(id,capture_id,attempt_number) VALUES($1,$2,1)`,
            randomUUID(),
            f.capture,
          );
        if (kind === 'segment')
          await tx.$executeRawUnsafe(
            `INSERT INTO public_hearing_transcript_segment(id,capture_id,sequence,start_ms,end_ms,text) VALUES($1,$2,1,0,1,'retained')`,
            randomUUID(),
            f.capture,
          );
        if (kind === 'epoch')
          await tx.$executeRawUnsafe(
            `INSERT INTO intel_public_hearing_audio_epoch(id,capture_id,hearing_id,source_url,owner_id,fencing_token,start_ms,durable_end_ms,sample_rate,channels,expires_at) VALUES($1,$2::uuid,$3,'https://www.senate.gov/hearing/late','old',1,0,0,16000,1,now()+interval '1 day')`,
            randomUUID(),
            f.capture,
            f.hearing,
          );
      });
      expect(await store.getBlockedRecoveryCandidate(f.capture, new Date())).toBeNull();
    },
  );

  it.each([
    [
      'manual stop',
      "UPDATE public_hearing_capture SET terminal_reason_code='MANUAL_STOP',version=version+1 WHERE id=$1",
      'capture',
    ],
    ['closed event', "UPDATE committee_hearing SET visibility='private' WHERE id=$1", 'hearing'],
    [
      'revoked candidate',
      "UPDATE hearing_stream_candidate SET capture_policy='BLOCKED' WHERE id=$1",
      'candidate',
    ],
    [
      'changed candidate',
      "UPDATE hearing_stream_candidate SET official_page_url='https://www.senate.gov/other' WHERE id=$1",
      'candidate',
    ],
    ['disabled provenance', 'UPDATE committee_source SET enabled=false WHERE id=$1', 'source'],
  ] as const)('rechecks %s after a successful probe', async (_name, sql, key) => {
    const f = await seed(),
      proof = await probe(f);
    await prisma.$executeRawUnsafe(sql, f[key]);
    const before = await state(f);
    expect(
      await store.reopenBlockedCapture({
        captureId: f.capture,
        expectedVersion: 1,
        probe: proof,
        now: new Date(),
      }),
    ).toBeNull();
    expect(await state(f)).toEqual(before);
  });

  it('only one concurrent optimistic recovery can win', async () => {
    const f = await seed(),
      proof = await probe(f);
    const input = { captureId: f.capture, expectedVersion: 1, probe: proof, now: new Date() };
    const results = await Promise.all([
      store.reopenBlockedCapture(input),
      store.reopenBlockedCapture(input),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await state(f)).version).toBe(2);
  });

  it.each([
    [48, false],
    [24, true],
  ])('waits for the ordinary T-24h first checkpoint: %s hours ahead', async (hours, expected) => {
    const f = await seed();
    await prisma.$executeRawUnsafe(
      `UPDATE committee_hearing SET starts_at=now()+($2::int*interval '1 hour') WHERE id=$1`,
      f.hearing,
      hours,
    );
    expect(Boolean(await store.getBlockedRecoveryCandidate(f.capture, new Date()))).toBe(expected);
    expect((await store.listDueHearingIds(new Date())).includes(f.hearing)).toBe(expected);
  });

  it('does not overwrite a candidate policy revoked while its network probe was in flight', async () => {
    const f = await seed(),
      candidate = (await store.getBlockedRecoveryCandidate(f.capture, new Date()))!;
    const adapter = new PublicCaptureAutomaticResolverAdapter(prisma, {
      resolve: async () => {
        await prisma.$executeRawUnsafe(
          `UPDATE hearing_stream_candidate SET capture_policy='BLOCKED',updated_at=now() WHERE id=$1`,
          f.candidate,
        );
        return { status: 'resolved', media };
      },
    } as never);
    expect(await adapter.probeBlockedRecoveryCandidate(candidate)).toBeNull();
    const after = await prisma.$queryRawUnsafe<Array<{ capture_policy: string }>>(
      'SELECT capture_policy FROM hearing_stream_candidate WHERE id=$1',
      f.candidate,
    );
    expect(after[0]?.capture_policy).toBe('BLOCKED');
    expect((await state(f)).domain_status).toBe('BLOCKED');
  });

  it('preserves BLOCKED during source failure and paces a later fresh successful probe', async () => {
    const f = await seed(),
      before = await state(f);
    const candidate = (await store.getBlockedRecoveryCandidate(f.capture, new Date()))!;
    const adapter = new PublicCaptureAutomaticResolverAdapter(prisma, {
      resolve: async () => {
        throw Error('temporary failure');
      },
    } as never);
    const result = await adapter.probeBlockedRecoveryCandidate(candidate);
    expect(result?.classified.state).toBe('SOURCE_ERROR');
    expect(await state(f)).toEqual(before);
    expect(await store.getBlockedRecoveryCandidate(f.capture, new Date())).toBeNull();
    await prisma.$executeRawUnsafe(
      `UPDATE hearing_stream_candidate SET last_probe_at=now()-interval '2 minutes' WHERE id=$1`,
      f.candidate,
    );
    const success = await probe(f);
    expect(
      await store.reopenBlockedCapture({
        captureId: f.capture,
        expectedVersion: 1,
        probe: success,
        now: new Date(),
      }),
    ).toMatchObject({ status: 'READY' });
  });

  it('does not let an unready future source consume every scan before its next preflight checkpoint', async () => {
    const f = await seed();
    await prisma.$executeRawUnsafe(
      `UPDATE committee_hearing SET starts_at=now()+interval '2 hours' WHERE id=$1`,
      f.hearing,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE hearing_stream_candidate SET last_probe_at=now()-interval '2 minutes',resolution_state='WAITING_FOR_STREAM' WHERE id=$1`,
      f.candidate,
    );
    expect(await store.listDueHearingIds(new Date())).not.toContain(f.hearing);
    // The T-1h checkpoint has now arrived since the previous probe.
    await prisma.$executeRawUnsafe(
      `UPDATE committee_hearing SET starts_at=now()+interval '59 minutes' WHERE id=$1`,
      f.hearing,
    );
    expect(await store.listDueHearingIds(new Date())).toContain(f.hearing);
  });
});
