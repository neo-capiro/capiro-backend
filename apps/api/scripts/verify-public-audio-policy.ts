import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { globalPublicAudioSource } from '../../intel-api/src/hearing/capture/global-public-audio-policy.js';
import type { Prisma } from '../../intel-api/generated/prisma-client/index.js';
import { PublicHearingAudioStore } from '../../intel-api/src/hearing/capture/public-hearing-audio.store.js';

async function main() {
  assert.equal(process.env.CAPIRO_DISPOSABLE_PG, '1');
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname));
  process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED = 'true';
  process.env.HEARING_PUBLIC_AUDIO_CAPTURE_ALL_ENABLED = 'true';
  const db = new PrismaClient();
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE audio_policy_hearing (id text,url text,visibility text,canonical_hearing_id text,event_status text,jurisdiction text)`,
        );
        await tx.$executeRawUnsafe(
          `CREATE TEMP VIEW federal_committee_hearing AS SELECT * FROM audio_policy_hearing WHERE jurisdiction='US'`,
        );
        await tx.$executeRawUnsafe(
          `CREATE TEMP VIEW capturable_committee_hearing AS SELECT * FROM audio_policy_hearing`,
        );
        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE public_hearing_capture (hearing_id text,resolution_capture_policy text,domain_status text,resolution_state text,
          id text DEFAULT '00000000-0000-4000-8000-000000000001',worker_lease_owner text DEFAULT 'worker',fencing_token integer DEFAULT 1,
          lease_expires_at timestamptz DEFAULT now()+interval '1 hour',actual_start timestamptz,actual_end timestamptz,captured_ms integer DEFAULT 0,captured_seconds integer DEFAULT 0)`,
        );
        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE legiwatch_cutover_state (id text,capture_all_public_events boolean)`,
        );
        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE legiwatch_runtime_heartbeat (job_key text,enabled boolean,schedule_enabled boolean)`,
        );
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE users (id text,clerk_user_id text)`);
        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE tenant_memberships (tenant_id text,user_id text,status text)`,
        );
        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE intel_feature_flag (tenant_id text,feature text,enabled boolean)`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO audio_policy_hearing VALUES ('h','https://committee.senate.gov/hearing','public',NULL,'scheduled','US')`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO public_hearing_capture(hearing_id,resolution_capture_policy,domain_status,resolution_state) VALUES ('h','SERVER_CAPTURE_ALLOWED','CAPTURING','READY_FOR_SERVER_CAPTURE')`,
        );
        await tx.$executeRawUnsafe(`INSERT INTO legiwatch_cutover_state VALUES ('global',true)`);
        await tx.$executeRawUnsafe(
          `INSERT INTO legiwatch_runtime_heartbeat VALUES ('capture-worker',true,true)`,
        );
        await tx.$executeRawUnsafe(`INSERT INTO users VALUES ('u','clerk-u')`);
        await tx.$executeRawUnsafe(`INSERT INTO tenant_memberships VALUES ('t','u','active')`);
        await tx.$executeRawUnsafe(
          `INSERT INTO intel_feature_flag VALUES ('t','legiwatch_hearing_recording_v1',true)`,
        );
        const read = (input: Parameters<typeof globalPublicAudioSource>[2] = {}) =>
          globalPublicAudioSource(tx as unknown as Prisma.TransactionClient, 'h', input);
        assert.ok(await read({ capturing: true }));
        assert.ok(await read({ tenantId: 't', clerkUserId: 'clerk-u' }));
        assert.equal(await read({ tenantId: 'other', clerkUserId: 'clerk-u' }), null);
        assert.equal(await read({ sourceUrl: 'https://wrong.example/source' }), null);
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE intel_public_hearing_audio_epoch (
          id text,capture_id uuid,hearing_id text,source_url text,owner_id text,fencing_token integer,start_ms integer,
          durable_end_ms integer,sample_rate integer,channels integer,expires_at timestamptz,
          durable_sequence integer DEFAULT -1,durable_bytes bigint DEFAULT 0,state text DEFAULT 'recording',transcript_state text DEFAULT 'pending',reason text)`);
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE intel_public_hearing_audio_part (
          id text,epoch_id text,sequence integer,start_ms integer,end_ms integer,bytes integer,sha256 text,object_key text)`);
        const objects = new Map<string, Buffer>();
        const store = new PublicHearingAudioStore(
          { withSystem: (fn: (tx: unknown) => unknown) => fn(tx) } as never,
          {
            assertReady() {},
            async put(key: string, bytes: Buffer) {
              assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
              objects.set(key, bytes);
            },
          } as never,
        );
        const attempt = await store.begin({
          captureId: '00000000-0000-4000-8000-000000000001',
          hearingId: 'h',
          lease: { ownerId: 'worker', fencingToken: 1 },
          timelineOffsetMs: 0,
          sampleRate: 16000,
          channels: 1,
        });
        assert.ok(attempt);
        await store.append(attempt, Buffer.alloc(160000));
        assert.equal(objects.size, 1);
        const epochs = await tx.$queryRawUnsafe<
          Array<{ durable_sequence: number; durable_end_ms: number; durable_bytes: bigint }>
        >(
          `SELECT durable_sequence,durable_end_ms,durable_bytes FROM intel_public_hearing_audio_epoch`,
        );
        assert.equal(epochs[0]?.durable_sequence, 0);
        assert.equal(epochs[0]?.durable_end_ms, 5000);
        assert.equal(epochs[0]?.durable_bytes, 160044n);
        await tx.$executeRawUnsafe(`UPDATE public_hearing_capture SET fencing_token=2`);
        await assert.rejects(store.append(attempt, Buffer.alloc(160000)), /LEASE_LOST/);
        assert.equal(objects.size, 1);
        await tx.$executeRawUnsafe(`UPDATE public_hearing_capture SET fencing_token=1`);
        await store.seal(attempt, true, true, 'transcription_interrupted');
        const sealed = await tx.$queryRawUnsafe<Array<{ state: string; transcript_state: string }>>(
          `SELECT state,transcript_state FROM intel_public_hearing_audio_epoch`,
        );
        assert.deepEqual(sealed, [{ state: 'ready', transcript_state: 'partial' }]);
        for (const policy of [
          'BROWSER_CAPTURE_ONLY',
          'LICENSE_REQUIRED',
          'BLOCKED',
          'REVIEW_REQUIRED',
        ]) {
          await tx.$executeRaw`UPDATE public_hearing_capture SET resolution_capture_policy=${policy}`;
          assert.equal(await read(), null);
        }
        await tx.$executeRawUnsafe(
          `UPDATE public_hearing_capture SET resolution_capture_policy='SERVER_CAPTURE_ALLOWED'`,
        );
        await tx.$executeRawUnsafe(`UPDATE audio_policy_hearing SET visibility='private'`);
        assert.equal(await read(), null);
        await tx.$executeRawUnsafe(
          `UPDATE audio_policy_hearing SET visibility='public',canonical_hearing_id='canonical'`,
        );
        assert.equal(await read(), null);
        await tx.$executeRawUnsafe(
          `UPDATE audio_policy_hearing SET canonical_hearing_id=NULL,jurisdiction='FL'`,
        );
        delete process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED;
        assert.equal(await read(), null);
        process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = 'true';
        assert.ok(await read());
        await tx.$executeRawUnsafe(`UPDATE audio_policy_hearing SET event_status='completed'`);
        assert.equal(await read({ capturing: true }), null);
        assert.ok(await read());
        await tx.$executeRawUnsafe(`UPDATE tenant_memberships SET status='inactive'`);
        assert.equal(await read({ tenantId: 't', clerkUserId: 'clerk-u' }), null);
        await tx.$executeRawUnsafe(`UPDATE tenant_memberships SET status='active'`);
        await tx.$executeRawUnsafe(`UPDATE intel_feature_flag SET enabled=false`);
        assert.equal(await read({ tenantId: 't', clerkUserId: 'clerk-u' }), null);
        await tx.$executeRawUnsafe(
          `UPDATE legiwatch_cutover_state SET capture_all_public_events=false`,
        );
        assert.equal(await read(), null);
      },
      { timeout: 30_000 },
    );
    console.log(
      'PUBLIC_AUDIO_POLICY_POSTGRES_PASS: source policy, privacy, aliases, jurisdiction, membership, tenant isolation, current permission, durable WAV checkpoints, stale-worker fencing and completed-source recovery',
    );
  } finally {
    await db.$disconnect();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
