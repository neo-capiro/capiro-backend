/**
 * Phase 9 — database identity / capability-authorisation regression tests.
 *
 * The boundary under test is the one the first Phase 9 cut got WRONG: it compared
 * a CONFIGURED env string (`DB_USER`) with the expected capability-role name.
 * That is not authorisation — it trusts the caller's own configuration, it is
 * spoofable via `DEFENSE_JOB_DB_ROLE`, and it cannot express the production
 * design at all:
 *
 *   capability role : capiro_defense_job        NOLOGIN, owns lifecycle grants
 *   login role      : capiro_defense_job_login  LOGIN, INHERITs via membership
 *
 * Under that design the configured username is CORRECTLY different from the
 * capability role, so a string compare is both wrong and useless.
 *
 * These tests therefore drive `evaluateCapabilityProof` — the pure evaluator fed
 * by the in-database proof (`current_user`, `session_user`, `pg_has_role(...)`,
 * and the `pg_roles` attribute flags) — across every accept/refuse identity.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CAPABILITY_PROOF_SQL,
  FORBIDDEN_ROLE_ATTRIBUTES,
  JobPreflightError,
  assertLiveJobCapability,
  evaluateCapabilityProof,
  resolveCapabilityRole,
  // @ts-expect-error -- .mjs preflight module has no type declarations
} from '../../scripts/job-preflight.mjs';

const CAPABILITY = 'capiro_defense_job';

/** A clean, unprivileged login that is a genuine INHERITing member. */
function goodProof(overrides: Record<string, unknown> = {}) {
  return {
    current_user: 'capiro_defense_job_login',
    session_user: 'capiro_defense_job_login',
    database: 'capiro',
    is_member: true,
    inherits_capability: true,
    is_superuser: false,
    can_create_role: false,
    can_create_db: false,
    can_replicate: false,
    can_bypass_rls: false,
    inherit_enabled: true,
    capability_can_login: false,
    ...overrides,
  };
}

function evaluate(row: unknown) {
  return evaluateCapabilityProof({ mode: 'backfill-run', row, capabilityRole: CAPABILITY });
}

describe('Phase 9 identity — the accepted production identity', () => {
  it('accepts capiro_defense_job_login with INHERITed membership', () => {
    const lines = evaluate(goodProof()) as readonly string[];
    assert.ok(lines.some((line) => line.includes('current_user=capiro_defense_job_login')));
    assert.ok(lines.some((line) => line.includes('session_user=capiro_defense_job_login')));
    assert.ok(lines.some((line) => line.includes('pg_has_role(member)=true')));
    assert.ok(lines.some((line) => line.includes('pg_has_role(usage/inherited)=true')));
  });

  it('logs every forbidden attribute as false, so the proof is auditable', () => {
    const lines = evaluate(goodProof()) as readonly string[];
    for (const [, label] of FORBIDDEN_ROLE_ATTRIBUTES as readonly [string, string][]) {
      assert.ok(
        lines.some((line) => line === `[phase9-identity] login.${label}=false`),
        `expected an explicit false proof line for ${label}`,
      );
    }
  });

  it('tolerates Postgres driver booleans arriving as t/true strings', () => {
    const lines = evaluate(
      goodProof({ is_member: 't', inherits_capability: 'true' }),
    ) as readonly string[];
    assert.ok(lines.some((line) => line.includes('pg_has_role(member)=true')));
  });
});

describe('Phase 9 identity — refused identities', () => {
  it('refuses an arbitrary login with no membership', () => {
    assert.throws(
      () => evaluate(goodProof({ current_user: 'some_random_login', session_user: 'some_random_login', is_member: false, inherits_capability: false })),
      (error: unknown) => {
        assert.ok(error instanceof JobPreflightError);
        assert.equal((error as { exitCode: number }).exitCode, 77);
        assert.match((error as Error).message, /is not a member of/);
        return true;
      },
    );
  });

  it('refuses capiro_app', () => {
    assert.throws(
      () =>
        evaluate(
          goodProof({
            current_user: 'capiro_app',
            session_user: 'capiro_app',
            is_member: false,
            inherits_capability: false,
          }),
        ),
      /capiro_app.*is not a member of/s,
    );
  });

  it('refuses capiro_defense_serve (the HTTP role, not the job role)', () => {
    assert.throws(
      () =>
        evaluate(
          goodProof({
            current_user: 'capiro_defense_serve',
            session_user: 'capiro_defense_serve',
            is_member: false,
            inherits_capability: false,
          }),
        ),
      /capiro_defense_serve.*is not a member of/s,
    );
  });

  it('refuses a master/admin role even when it is technically a member', () => {
    // capiro_master inherits broadly; membership alone must not be enough when
    // the login carries dangerous attributes.
    assert.throws(
      () =>
        evaluate(
          goodProof({
            current_user: 'capiro_master',
            session_user: 'capiro_master',
            is_member: true,
            inherits_capability: true,
            can_create_role: true,
            can_create_db: true,
          }),
        ),
      /forbidden attribute\(s\) \[createrole, createdb\]/,
    );
  });

  it('refuses a superuser login', () => {
    assert.throws(
      () => evaluate(goodProof({ current_user: 'postgres', is_superuser: true })),
      /forbidden attribute\(s\) \[superuser\]/,
    );
  });

  it('refuses a login holding bypassrls or replication', () => {
    assert.throws(
      () => evaluate(goodProof({ can_bypass_rls: true })),
      /forbidden attribute\(s\) \[bypassrls\]/,
    );
    assert.throws(
      () => evaluate(goodProof({ can_replicate: true })),
      /forbidden attribute\(s\) \[replication\]/,
    );
  });

  it('refuses membership that is not inherited (NOINHERIT)', () => {
    // Member on paper, but privileges would not apply without SET ROLE.
    assert.throws(
      () => evaluate(goodProof({ inherits_capability: false, inherit_enabled: false })),
      /does not inherit it \(NOINHERIT\)/,
    );
  });

  it('refuses if the capability role itself became LOGIN-capable', () => {
    // Guards the explicit instruction not to convert the capability role to LOGIN.
    assert.throws(
      () => evaluate(goodProof({ capability_can_login: true })),
      /must remain NOLOGIN/,
    );
  });

  it('refuses when the proof returns no row at all', () => {
    assert.throws(() => evaluate(undefined), /returned no row/);
  });

  it('every refusal uses exit code 77 (unauthorised), never 0', () => {
    const refusals = [
      goodProof({ is_member: false }),
      goodProof({ inherits_capability: false }),
      goodProof({ is_superuser: true }),
      goodProof({ capability_can_login: true }),
    ];
    for (const row of refusals) {
      try {
        evaluate(row);
        assert.fail('expected refusal');
      } catch (error) {
        assert.equal((error as { exitCode: number }).exitCode, 77);
      }
    }
  });
});

describe('Phase 9 identity — a spoofed env var cannot bypass the DB proof', () => {
  it('DEFENSE_JOB_DB_ROLE only selects WHICH capability is required', () => {
    assert.equal(resolveCapabilityRole({}), CAPABILITY);
    assert.equal(
      resolveCapabilityRole({ DEFENSE_JOB_DB_ROLE: 'some_other_role' }),
      'some_other_role',
    );
  });

  it('pointing DEFENSE_JOB_DB_ROLE at a role we are not a member of FAILS, never passes', async () => {
    // The membership predicate is evaluated in the database against the
    // requested capability, so redirecting it cannot manufacture authorisation.
    const sql = {
      async $queryRawUnsafe(_query: string, capability: string) {
        // Only genuinely a member of capiro_defense_job.
        const isMember = capability === CAPABILITY;
        return [goodProof({ is_member: isMember, inherits_capability: isMember })];
      },
    };

    await assert.rejects(
      () =>
        assertLiveJobCapability({
          mode: 'backfill-run',
          commit: true,
          sql,
          env: { DEFENSE_JOB_DB_ROLE: 'capiro_master' },
        }),
      /is not a member of the "capiro_master"/,
    );
  });

  it('a spoofed DB_USER string cannot satisfy the check, because it is not consulted', async () => {
    // The env claims to be the capability role itself; the DATABASE says the
    // authenticated principal is not a member. The database wins.
    const sql = {
      async $queryRawUnsafe() {
        return [
          goodProof({
            current_user: 'attacker_login',
            session_user: 'attacker_login',
            is_member: false,
            inherits_capability: false,
          }),
        ];
      },
    };

    await assert.rejects(
      () =>
        assertLiveJobCapability({
          mode: 'backfill-run',
          commit: true,
          sql,
          env: { DB_USER: 'capiro_defense_job', DEFENSE_JOB_DB_ROLE: CAPABILITY },
        }),
      /attacker_login" is not a member of/,
    );
  });

  it('rejects a non-identifier DEFENSE_JOB_DB_ROLE instead of interpolating it', () => {
    for (const hostile of ["capiro_defense_job'; DROP TABLE x --", 'a b', '1abc', 'x-y']) {
      assert.throws(
        () => resolveCapabilityRole({ DEFENSE_JOB_DB_ROLE: hostile }),
        /not a valid role identifier/,
        `expected rejection for ${hostile}`,
      );
    }
  });

  it('the removed PHASE9_ALLOW_NON_JOB_ROLE bypass has no executable code path', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const scripts = path.resolve(
      path.dirname(url.fileURLToPath(import.meta.url)),
      '../../scripts',
    );
    for (const file of ['job-preflight.mjs', 'job.mjs']) {
      const source = await fs.readFile(path.join(scripts, file), 'utf8');
      // Strip comments — the removal is documented in prose deliberately; what
      // must not exist is code that READS the variable.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      assert.ok(
        !code.includes('PHASE9_ALLOW_NON_JOB_ROLE'),
        `${file} must not read an authorisation bypass env var`,
      );
    }
  });

  it('a bypass env var set in the environment has no effect', async () => {
    const sql = {
      async $queryRawUnsafe() {
        return [goodProof({ current_user: 'capiro_app', is_member: false, inherits_capability: false })];
      },
    };
    await assert.rejects(
      () =>
        assertLiveJobCapability({
          mode: 'backfill-run',
          commit: true,
          sql,
          env: { PHASE9_ALLOW_NON_JOB_ROLE: 'true' },
        }),
      /is not a member of/,
    );
  });
});

describe('Phase 9 identity — proof plumbing', () => {
  it('a dry run performs no identity query at all', async () => {
    let called = false;
    const sql = {
      async $queryRawUnsafe() {
        called = true;
        return [goodProof()];
      },
    };
    const result = await assertLiveJobCapability({
      mode: 'backfill-run',
      commit: false,
      sql,
      env: {},
    });
    assert.equal(result, null);
    assert.equal(called, false, 'a dry run must not touch the database');
  });

  it('accepts the real production identity end to end', async () => {
    const sql = {
      async $queryRawUnsafe(_q: string, capability: string) {
        assert.equal(capability, CAPABILITY);
        return [goodProof()];
      },
    };
    const row = await assertLiveJobCapability({
      mode: 'backfill-run',
      commit: true,
      sql,
      env: {},
    });
    assert.equal((row as { current_user: string }).current_user, 'capiro_defense_job_login');
  });

  it('a failed identity query refuses rather than proceeding', async () => {
    const sql = {
      async $queryRawUnsafe() {
        throw new Error('permission denied for table pg_authid');
      },
    };
    await assert.rejects(
      () => assertLiveJobCapability({ mode: 'backfill-run', commit: true, sql, env: {} }),
      /could not verify database identity\/capability/,
    );
  });

  it('the proof SQL asks Postgres the required questions', () => {
    const sql = CAPABILITY_PROOF_SQL as string;
    assert.match(sql, /current_user/);
    assert.match(sql, /session_user/);
    assert.match(sql, /pg_has_role\(current_user, \$1::name, 'member'\)/);
    assert.match(sql, /pg_has_role\(current_user, \$1::name, 'usage'\)/);
    for (const attribute of [
      'rolsuper',
      'rolcreaterole',
      'rolcreatedb',
      'rolreplication',
      'rolbypassrls',
    ]) {
      assert.ok(sql.includes(attribute), `proof SQL must read ${attribute}`);
    }
    // Parameterised, not string-concatenated.
    assert.ok(!/\$\{/.test(sql), 'proof SQL must not interpolate values');
  });
});
