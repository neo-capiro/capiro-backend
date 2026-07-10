import fs from 'node:fs';
import path from 'node:path';
import {
  FIND_QUALIFYING_ALERTS_SQL,
  SURFACE_BRIEF_UPDATE_SQL,
  SURFACE_BRIEF_INSERT_SQL,
  POSTURE,
  findQualifyingAlerts,
  surfaceBrief,
} from './run-intel-workflows.js';

/**
 * REGRESSION (2026-07-10 hot-fix, W1.1 — the blocker): `findQualifyingAlerts`
 * referenced a non-existent table `client_facility` (the real ClientFacility
 * model maps to `client_facilities`), so the worker threw PG 42P01 on every
 * invocation, in both dry-run and --commit. This is a DB-free static check —
 * no live Postgres needed — that extracts every table identifier referenced
 * by the worker's raw SQL and asserts each exists in the union of apps/api's
 * AND apps/intel-api's @@map table-name sets (the union is mandatory: this
 * worker legitimately reads/writes intel-api-owned tables that apps/api's
 * own schema has no model for). It would have failed on `client_facility`
 * with zero infrastructure.
 *
 * Also confirms importing this module never boots Nest or touches a DB
 * (main() only auto-runs when this file is the process entrypoint).
 */

function mappedTableNames(schemaPath: string): Set<string> {
  const text = fs.readFileSync(schemaPath, 'utf8');
  const names = new Set<string>();
  const re = /@@map\("([^"]+)"\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) names.add(m[1]);
  }
  return names;
}

function referencedTables(sql: string): string[] {
  // Matches the table identifier immediately after FROM / JOIN / INTO / UPDATE,
  // tolerating an optional alias on the same capture boundary. UPDATE is
  // excluded when preceded by "DO " so an upsert's `ON CONFLICT ... DO
  // UPDATE SET col = ...` clause (no table name there — "SET" is not one)
  // is never misparsed as a second UPDATE statement.
  const re = /\b(?:FROM|JOIN|INTO|(?<!DO\s)UPDATE)\s+"?([a-z_][a-z0-9_]*)"?/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    if (m[1]) out.push(m[1].toLowerCase());
  }
  return out;
}

describe('run-intel-workflows raw SQL — table-name safety net (2026-07-10 hot-fix, W1.1)', () => {
  const apiSchema = path.resolve(__dirname, '../prisma/schema.prisma');
  const intelSchema = path.resolve(__dirname, '../../intel-api/prisma/schema.prisma');
  const validTables = new Set<string>([
    ...mappedTableNames(apiSchema),
    ...mappedTableNames(intelSchema),
  ]);

  it('sanity: the schema files were actually found and parsed (a non-trivial union)', () => {
    expect(validTables.size).toBeGreaterThan(50);
  });

  it('the union whitelists the cross-realm intel tables this worker legitimately touches', () => {
    expect(validTables.has('intel_alert')).toBe(true);
    expect(validTables.has('intel_action_item')).toBe(true);
  });

  it('FIND_QUALIFYING_ALERTS_SQL references only real tables (regression: would have failed on client_facility)', () => {
    const tables = referencedTables(FIND_QUALIFYING_ALERTS_SQL);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      expect(validTables.has(t)).toBe(true);
    }
    // Explicit regression pin: the FIXED table name is present, the OLD
    // (broken) singular name is not referenced anywhere in the query.
    expect(FIND_QUALIFYING_ALERTS_SQL).toMatch(/\bclient_facilities\b/);
    expect(FIND_QUALIFYING_ALERTS_SQL).not.toMatch(/\bclient_facility\b(?!ies)/);
  });

  it('SURFACE_BRIEF_UPDATE_SQL and SURFACE_BRIEF_INSERT_SQL reference only real tables', () => {
    for (const sql of [SURFACE_BRIEF_UPDATE_SQL, SURFACE_BRIEF_INSERT_SQL]) {
      const tables = referencedTables(sql);
      expect(tables.length).toBeGreaterThan(0);
      for (const t of tables) {
        expect(validTables.has(t)).toBe(true);
      }
    }
  });

  it("referencedTables never misparses an upsert's `DO UPDATE SET` clause as a second UPDATE statement", () => {
    // SURFACE_BRIEF_INSERT_SQL's ON CONFLICT ... DO UPDATE SET title = ...
    // clause has no table name to extract — a naive UPDATE-keyword match
    // would capture "SET" as a fake table name and fail the whitelist check.
    expect(SURFACE_BRIEF_INSERT_SQL).toMatch(/DO UPDATE SET/);
    expect(referencedTables(SURFACE_BRIEF_INSERT_SQL)).not.toContain('set');
    expect(referencedTables('UPDATE real_table SET x = 1')).toEqual(['real_table']);
  });

  it('SURFACE_BRIEF_UPDATE_SQL performs a targeted jsonb_set, never a top-level `||` merge that would clobber sibling enrichment keys (W1.3)', () => {
    expect(SURFACE_BRIEF_UPDATE_SQL).toMatch(/jsonb_set/i);
    expect(SURFACE_BRIEF_UPDATE_SQL).toMatch(/\{enrichment,targetingBrief\}/);
    expect(SURFACE_BRIEF_UPDATE_SQL).not.toMatch(/evidence\s*\|\|\s*\$1/);
  });

  it('a static-check backstop: this spec itself would fail if a future edit re-introduces a nonexistent table (simulated)', () => {
    // Proves the assertion mechanism actually red-flags a bad table name —
    // not just that the CURRENT queries happen to be well-formed.
    expect(validTables.has('client_facility')).toBe(false);
    expect(() => {
      const badTables = referencedTables('SELECT 1 FROM client_facility');
      for (const t of badTables) {
        if (!validTables.has(t)) throw new Error(`unknown table: ${t}`);
      }
    }).toThrow(/unknown table: client_facility/);
  });
});

describe('module import safety', () => {
  it('importing run-intel-workflows.ts does not boot Nest or touch a database', () => {
    // If the import had side effects (e.g. main() auto-running), this test
    // file would already have thrown/hung before reaching this assertion.
    expect(['dry', 'shadow', 'attach']).toContain(POSTURE);
  });
});

describe('findQualifyingAlerts / surfaceBrief — call shape', () => {
  it('findQualifyingAlerts runs the query under withSystem, passing LOOKBACK_HOURS as the sole bind param', async () => {
    const queryRawUnsafe = jest.fn(async () => [{ id: 'a1' }]);
    const prisma = {
      withSystem: jest.fn((fn: (tx: unknown) => unknown) =>
        fn({ $queryRawUnsafe: queryRawUnsafe }),
      ),
    };
    const rows = await findQualifyingAlerts(prisma);
    expect(prisma.withSystem).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafe).toHaveBeenCalledWith(FIND_QUALIFYING_ALERTS_SQL, expect.any(Number));
    expect(rows).toEqual([{ id: 'a1' }]);
  });

  it('surfaceBrief runs BOTH raw writes under a single withSystem call, in order, with the correct bind params', async () => {
    const calls: unknown[][] = [];
    const executeRawUnsafe = jest.fn(async (...args: unknown[]) => {
      calls.push(args);
      return 1;
    });
    const prisma = {
      withSystem: jest.fn((fn: (tx: unknown) => unknown) =>
        fn({ $executeRawUnsafe: executeRawUnsafe }),
      ),
    };
    const alert = {
      id: 'alert-1',
      tenant_id: 't1',
      client_id: 'c1',
      source_type: 'state_bill',
      source_ref: 'tx-2025-hb1234',
      title: 'An act relating to a study',
      severity: 'critical',
    };
    const brief = { targets: [{ memberId: 'D1' }], recommendedSequence: ['Engage D1'] };

    await surfaceBrief(prisma, alert, brief);

    expect(prisma.withSystem).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafe).toHaveBeenCalledTimes(2);
    // Call 1: the jsonb_set UPDATE, bound to (payload, alertId, tenantId).
    expect(calls[0]).toEqual([SURFACE_BRIEF_UPDATE_SQL, JSON.stringify(brief), 'alert-1', 't1']);
    // Call 2: the intel_action_item INSERT, bound to (tenantId, clientId, alertId, title).
    expect(calls[1]?.[0]).toBe(SURFACE_BRIEF_INSERT_SQL);
    expect(calls[1]?.[1]).toBe('t1');
    expect(calls[1]?.[2]).toBe('c1');
    expect(calls[1]?.[3]).toBe('alert-1');
    expect(calls[1]?.[4]).toBe('Targeting brief: An act relating to a study');
  });
});

describe('POSTURE (2026-07-10 hot-fix, W1.2 — R7 "new capability ships dark")', () => {
  const originalArgv = [...process.argv];
  const hadEnvFlag = Object.prototype.hasOwnProperty.call(
    process.env,
    'INTEL_WORKFLOWS_TARGETING_ENABLED',
  );
  const originalEnvFlag = process.env.INTEL_WORKFLOWS_TARGETING_ENABLED;

  afterEach(() => {
    process.argv = [...originalArgv];
    if (hadEnvFlag) process.env.INTEL_WORKFLOWS_TARGETING_ENABLED = originalEnvFlag;
    else delete process.env.INTEL_WORKFLOWS_TARGETING_ENABLED;
    jest.resetModules();
  });

  it('no --commit, no --shadow -> dry (zero LLM calls, the safest posture)', async () => {
    process.argv = originalArgv.filter((a) => a !== '--commit' && a !== '--shadow');
    delete process.env.INTEL_WORKFLOWS_TARGETING_ENABLED;
    jest.resetModules();
    const mod = await import('./run-intel-workflows.js');
    expect(mod.POSTURE).toBe('dry');
  });

  it('REGRESSION (R7): --commit alone, with NO env flag set, is SHADOW not attach — the deployed schedule hardcodes --commit and must stay dark by default regardless', async () => {
    process.argv = [...originalArgv, '--commit'];
    delete process.env.INTEL_WORKFLOWS_TARGETING_ENABLED;
    jest.resetModules();
    const mod = await import('./run-intel-workflows.js');
    expect(mod.POSTURE).toBe('shadow');
  });

  it('--shadow alone -> shadow', async () => {
    process.argv = [...originalArgv, '--shadow'];
    delete process.env.INTEL_WORKFLOWS_TARGETING_ENABLED;
    jest.resetModules();
    const mod = await import('./run-intel-workflows.js');
    expect(mod.POSTURE).toBe('shadow');
  });

  it('--commit AND INTEL_WORKFLOWS_TARGETING_ENABLED=true -> attach — the ONLY posture that performs a cross-realm write', async () => {
    process.argv = [...originalArgv, '--commit'];
    process.env.INTEL_WORKFLOWS_TARGETING_ENABLED = 'true';
    jest.resetModules();
    const mod = await import('./run-intel-workflows.js');
    expect(mod.POSTURE).toBe('attach');
  });

  it('--shadow AND the env flag enabled is STILL shadow — --commit is required to ever attach', async () => {
    process.argv = [...originalArgv, '--shadow'];
    process.env.INTEL_WORKFLOWS_TARGETING_ENABLED = 'true';
    jest.resetModules();
    const mod = await import('./run-intel-workflows.js');
    expect(mod.POSTURE).toBe('shadow');
  });

  it('accepts the repo-standard boolean-env spellings (1, yes, case-insensitive true) for the flag', async () => {
    for (const v of ['1', 'yes', 'TRUE']) {
      process.argv = [...originalArgv, '--commit'];
      process.env.INTEL_WORKFLOWS_TARGETING_ENABLED = v;
      jest.resetModules();
      const mod = await import('./run-intel-workflows.js');
      expect(mod.POSTURE).toBe('attach');
    }
  });
});
