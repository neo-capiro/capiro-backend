/** Run against the disposable local PostgreSQL container: pnpm exec tsx test/legiwatch-lifecycle-postgres.ts */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { LegiWatchLifecycleNotificationService } from '../src/live-hearings/legiwatch-lifecycle-notification.service.js';

async function main() {
  let statement = '';
  const service = new LegiWatchLifecycleNotificationService({
    withSystem: (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        assert(values.every((v) => typeof v === 'number'));
        statement = strings.reduce((sql, part, i) => sql + part + (values[i] ?? ''), '');
        return [];
      },
    }),
  } as never);
  await service.reconcileFollowedLifecycle();
  const tenant = '11111111-1111-1111-1111-111111111111';
  const otherTenant = '22222222-2222-2222-2222-222222222222';
  const user = '33333333-3333-3333-3333-333333333333';
  const client = '44444444-4444-4444-4444-444444444444';
  const sql = `BEGIN;
    CREATE TEMP TABLE users(id uuid,clerk_user_id text);
    CREATE TEMP TABLE tenant_memberships(user_id uuid,tenant_id uuid,status text);
    CREATE TEMP TABLE clients(id uuid,tenant_id uuid,status text);
    CREATE TEMP TABLE hearing_follow(tenant_id uuid,user_id text,hearing_id text,client_ids uuid[],created_at timestamptz,
      notify_on_hearing_starting boolean,notify_on_schedule_change boolean,notify_on_transcript_ready boolean,notify_on_high_priority_match boolean);
    CREATE TEMP TABLE committee_hearing(id text,canonical_hearing_id text,visibility text,committee_system_code text,title text,event_status text,starts_at timestamptz);
    CREATE TEMP TABLE legislative_calendar_transition(id text,hearing_id text,observed_at timestamptz,before jsonb,changed_fields text[]);
    CREATE TEMP TABLE public_hearing_capture(id text,hearing_id text,status text,actual_end timestamptz);
    CREATE TEMP TABLE public_hearing_transcript_segment(capture_id text,is_final boolean,text text);
    CREATE TEMP TABLE tenant_hearing_relevance(tenant_id uuid,client_id uuid,hearing_id text,insight_id text,score double precision,rationale text,created_at timestamptz);
    CREATE TEMP TABLE legiwatch_notification_event(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,user_id text,event_type text,hearing_id text,committee_system_code text,client_id uuid,title text,body text,deep_link text,dedup_key text, UNIQUE(tenant_id,user_id,dedup_key));
    INSERT INTO users VALUES('${user}','clerk-test');
    INSERT INTO tenant_memberships VALUES('${user}','${tenant}','active');
    INSERT INTO clients VALUES('${client}','${tenant}','active');
    INSERT INTO committee_hearing VALUES('hearing',NULL,'public','hsas00','Test hearing','in_progress',now()-interval '2 minutes');
    INSERT INTO hearing_follow VALUES('${tenant}','clerk-test','hearing',ARRAY['${client}']::uuid[],now()-interval '1 day',true,true,true,true);
    INSERT INTO hearing_follow VALUES('${otherTenant}','clerk-test','hearing',ARRAY['${client}']::uuid[],now()-interval '1 day',true,true,true,true);
    INSERT INTO legislative_calendar_transition VALUES('changed','hearing',now(),'{}',ARRAY['time']),('initial','hearing',now(),NULL,ARRAY['time']);
    INSERT INTO public_hearing_capture VALUES('capture','hearing','ended',now());
    INSERT INTO public_hearing_transcript_segment VALUES('capture',true,'Verified final segment');
    INSERT INTO tenant_hearing_relevance VALUES('${tenant}','${client}','hearing','insight',0.9,'Client topic',now()),('${otherTenant}','${client}','hearing','foreign',0.9,'Other tenant',now());
    ${statement};
    ${statement};
    DO $$ BEGIN
      IF (SELECT count(*) FROM legiwatch_notification_event) <> 4 THEN RAISE EXCEPTION 'Expected exactly four lifecycle events after retry'; END IF;
      IF EXISTS(SELECT 1 FROM legiwatch_notification_event WHERE tenant_id<>'${tenant}' OR user_id<>'${user}') THEN RAISE EXCEPTION 'Tenant/user isolation failure'; END IF;
    END $$;
    DELETE FROM legiwatch_notification_event;
    UPDATE hearing_follow SET notify_on_hearing_starting=false,notify_on_schedule_change=false,notify_on_transcript_ready=false,notify_on_high_priority_match=false;
    ${statement};
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM legiwatch_notification_event) THEN RAISE EXCEPTION 'Disabled preferences must suppress delivery'; END IF; END $$;
    ROLLBACK;`;
  const result = spawnSync('docker', ['exec', '-i', 'capiro-postgres', 'psql', '-U', 'capiro', '-d', 'capiro', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  process.stdout.write('PostgreSQL lifecycle qualification passed: four types, retry deduplication, tenant/user isolation, preferences.\n');
}
void main();
