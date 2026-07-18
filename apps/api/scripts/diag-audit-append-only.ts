/**
 * REHEARSAL for migration 20260718000000_audit_append_only. Proves the
 * append-only trigger LOGIC without touching any real data: it builds a faithful
 * mirror of the audit tables + their FK cascades entirely in pg_temp (session-
 * local temp tables, a pg_temp trigger function, temp triggers), runs a battery
 * of probes with per-probe exception handling, and reports PASS/FAIL. Because it
 * only ever references `_ao_*` temp objects, it is SAFE to run against any DB
 * (incl. prod capiro) — it never reads or writes audit_logs / compliance_check.
 *
 * The temp trigger function is a byte-for-byte mirror of enforce_audit_append_
 * only() with the table-name literals mapped ('audit_logs' -> '_ao_audit'). Run
 * this from the SAME image that carries the migration, BEFORE applying it.
 *
 * SAFE: temp objects only, no real-table access, whole thing rolls off at commit.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface ResultRow {
  probe: string;
  result: string;
  detail: string;
}

// One big DO block: sets up the temp mirror, runs every probe inside its own
// BEGIN/EXCEPTION subtransaction (so a trigger RAISE is caught instead of
// aborting the outer transaction), and records PASS/FAIL into _ao_results.
const REHEARSAL = `
DO $rehearse$
DECLARE
  v_count int;
  v_actor text;
BEGIN
  CREATE TEMP TABLE _ao_tenant(id text primary key) ON COMMIT DROP;
  CREATE TEMP TABLE _ao_user(id text primary key) ON COMMIT DROP;
  CREATE TEMP TABLE _ao_audit(
    id bigint primary key,
    tenant_id text references _ao_tenant(id) on delete cascade,
    actor_user_id text references _ao_user(id) on delete set null,
    action text
  ) ON COMMIT DROP;
  CREATE TEMP TABLE _ao_compliance(
    id bigint primary key,
    tenant_id text references _ao_tenant(id) on delete cascade,
    actor_user_id text,
    status text
  ) ON COMMIT DROP;
  CREATE TEMP TABLE _ao_results(probe text, result text, detail text) ON COMMIT DROP;

  CREATE FUNCTION pg_temp.enforce_ao() RETURNS trigger LANGUAGE plpgsql AS $fn$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      IF current_setting('app.allow_audit_purge', true) = 'on' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'append-only: % rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = '0A000';
    END IF;
    IF TG_TABLE_NAME = '_ao_audit'
       AND OLD.actor_user_id IS NOT NULL
       AND NEW.actor_user_id IS NULL
       AND (to_jsonb(NEW) - 'actor_user_id') = (to_jsonb(OLD) - 'actor_user_id') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'append-only: % rows cannot be modified', TG_TABLE_NAME USING ERRCODE = '0A000';
  END;
  $fn$;

  CREATE TRIGGER _ao_audit_ao BEFORE UPDATE OR DELETE ON _ao_audit
    FOR EACH ROW EXECUTE FUNCTION pg_temp.enforce_ao();
  CREATE TRIGGER _ao_comp_ao BEFORE UPDATE OR DELETE ON _ao_compliance
    FOR EACH ROW EXECUTE FUNCTION pg_temp.enforce_ao();

  INSERT INTO _ao_tenant VALUES ('t1');
  INSERT INTO _ao_user VALUES ('u1');

  -- P1: INSERT is never blocked (trigger is UPDATE/DELETE only).
  BEGIN
    INSERT INTO _ao_audit VALUES (1,'t1','u1','created');
    INSERT INTO _ao_compliance VALUES (1,'t1','u1','pass');
    INSERT INTO _ao_results VALUES ('P1_insert_allowed','PASS','insert ok');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _ao_results VALUES ('P1_insert_allowed','FAIL','insert raised: '||SQLERRM);
  END;

  -- P2: any content UPDATE of audit is blocked.
  BEGIN
    UPDATE _ao_audit SET action='tampered' WHERE id=1;
    INSERT INTO _ao_results VALUES ('P2_update_audit_blocked','FAIL','update was allowed');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _ao_results VALUES ('P2_update_audit_blocked','PASS',SQLERRM);
  END;

  -- P3: DELETE of audit is blocked without the purge GUC.
  BEGIN
    DELETE FROM _ao_audit WHERE id=1;
    INSERT INTO _ao_results VALUES ('P3_delete_audit_blocked','FAIL','delete allowed w/o GUC');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _ao_results VALUES ('P3_delete_audit_blocked','PASS',SQLERRM);
  END;

  -- P4: DELETE of audit is allowed under the purge GUC.
  BEGIN
    PERFORM set_config('app.allow_audit_purge','on',true);
    DELETE FROM _ao_audit WHERE id=1;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    PERFORM set_config('app.allow_audit_purge','off',true);
    IF v_count = 1 THEN
      INSERT INTO _ao_results VALUES ('P4_delete_under_guc','PASS','deleted under GUC');
    ELSE
      INSERT INTO _ao_results VALUES ('P4_delete_under_guc','FAIL','rowcount='||v_count);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.allow_audit_purge','off',true);
    INSERT INTO _ao_results VALUES ('P4_delete_under_guc','FAIL','raised: '||SQLERRM);
  END;
  INSERT INTO _ao_audit VALUES (1,'t1','u1','created') ON CONFLICT DO NOTHING;

  -- P5: the actor FK ON DELETE SET NULL cascade (actor->NULL only) is allowed;
  -- the audit row survives with actor_user_id nulled.
  BEGIN
    DELETE FROM _ao_user WHERE id='u1';
    SELECT count(*) INTO v_count FROM _ao_audit WHERE id=1;
    SELECT actor_user_id INTO v_actor FROM _ao_audit WHERE id=1;
    IF v_count=1 AND v_actor IS NULL THEN
      INSERT INTO _ao_results VALUES ('P5_actor_setnull_allowed','PASS','row kept, actor nulled');
    ELSE
      INSERT INTO _ao_results VALUES ('P5_actor_setnull_allowed','FAIL','cnt='||v_count||' actor='||COALESCE(v_actor,'<null>'));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _ao_results VALUES ('P5_actor_setnull_allowed','FAIL','raised: '||SQLERRM);
  END;

  -- P6: an UPDATE that nulls actor AND changes another column is still blocked.
  INSERT INTO _ao_user VALUES ('u2') ON CONFLICT DO NOTHING;
  INSERT INTO _ao_audit VALUES (2,'t1','u2','created') ON CONFLICT DO NOTHING;
  BEGIN
    UPDATE _ao_audit SET actor_user_id=NULL, action='tampered' WHERE id=2;
    INSERT INTO _ao_results VALUES ('P6_actor_plus_other_blocked','FAIL','multi-col update allowed');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _ao_results VALUES ('P6_actor_plus_other_blocked','PASS',SQLERRM);
  END;

  -- P7: any UPDATE of compliance is blocked (no actor-cascade exception applies).
  BEGIN
    UPDATE _ao_compliance SET status='tampered' WHERE id=1;
    INSERT INTO _ao_results VALUES ('P7_compliance_update_blocked','FAIL','update was allowed');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _ao_results VALUES ('P7_compliance_update_blocked','PASS',SQLERRM);
  END;

  -- P8: a tenant hard-delete WITHOUT the GUC is blocked (its cascade would try to
  -- delete child audit rows, which the trigger refuses) -> the whole delete fails.
  BEGIN
    DELETE FROM _ao_tenant WHERE id='t1';
    INSERT INTO _ao_results VALUES ('P8_cascade_blocked_no_guc','FAIL','tenant delete succeeded w/o GUC');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _ao_results VALUES ('P8_cascade_blocked_no_guc','PASS',SQLERRM);
  END;

  -- P9: a tenant hard-delete UNDER the GUC succeeds and cascades child audit +
  -- compliance rows away (the GDPR path CapiroAdminService.deleteTenant uses).
  BEGIN
    PERFORM set_config('app.allow_audit_purge','on',true);
    DELETE FROM _ao_tenant WHERE id='t1';
    PERFORM set_config('app.allow_audit_purge','off',true);
    SELECT (SELECT count(*) FROM _ao_audit) + (SELECT count(*) FROM _ao_compliance) INTO v_count;
    IF v_count=0 THEN
      INSERT INTO _ao_results VALUES ('P9_cascade_under_guc','PASS','tenant + children purged');
    ELSE
      INSERT INTO _ao_results VALUES ('P9_cascade_under_guc','FAIL','residual children='||v_count);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.allow_audit_purge','off',true);
    INSERT INTO _ao_results VALUES ('P9_cascade_under_guc','FAIL','raised: '||SQLERRM);
  END;
END
$rehearse$;
`;

async function main(): Promise<void> {
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(REHEARSAL);
    return tx.$queryRawUnsafe<ResultRow[]>(
      `SELECT probe, result, detail FROM _ao_results ORDER BY probe`,
    );
  });

  const failed = rows.filter((r) => r.result !== 'PASS');
  console.log(
    'AUDIT_APPEND_ONLY ' + JSON.stringify({ total: rows.length, failed: failed.length, rows }),
  );
  for (const r of rows) {
    console.log(`  ${r.result === 'PASS' ? 'PASS' : 'FAIL'} ${r.probe} :: ${r.detail}`);
  }
  if (failed.length > 0) {
    console.error(
      `AUDIT_APPEND_ONLY REHEARSAL FAILED: ${failed.length}/${rows.length} probes failed`,
    );
    process.exitCode = 1;
  } else {
    console.log(`AUDIT_APPEND_ONLY REHEARSAL PASSED: ${rows.length}/${rows.length} probes`);
  }
}

main()
  .catch((err) => {
    console.error('AUDIT_APPEND_ONLY REHEARSAL ERROR', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
