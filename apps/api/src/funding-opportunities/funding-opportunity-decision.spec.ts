import { describe, expect, test } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HUMAN_DECISIONS, OPPORTUNITY_WORKFLOW_STATUSES } from './funding-opportunities.types.js';

/**
 * P07 — the human decision, as a schema and migration contract.
 *
 * The service behaviour (pursue moves workflow, monitor saves, pass leaves it
 * alone, the pursuit guard still applies) is exercised by
 * funding-opportunities.service.spec.ts against the real service. What lives here
 * is the part a unit test cannot see: that the MIGRATION says what the code
 * assumes, and that the three concepts stayed separate.
 *
 * The migration itself was rehearsed against pgvector/pgvector:pg16 — clean replay
 * from empty, ordered upgrade from the prior FO schema, retry-as-no-op, all three
 * CHECKs proven to reject bad data, and RLS confirmed still ENABLED + FORCED with
 * exactly four policies. Those are recorded in the completion matrix; the CI gate
 * re-runs the schema assertions on every PR.
 */

const MIGRATION_DIR = join(__dirname, '../../prisma/migrations');
const MIGRATION_NAME = '20260819010000_funding_opportunity_decisions';
const SQL_RAW = readFileSync(join(MIGRATION_DIR, MIGRATION_NAME, 'migration.sql'), 'utf8');
/**
 * Comments stripped. The migration legitimately EXPLAINS what it is not doing —
 * "widening the vocabulary later is one DROP/ADD CONSTRAINT" — and counting
 * statements in prose is how a test starts asserting the docblock instead of the
 * SQL. Same technique as funding-opportunities.boundaries.spec.ts.
 */
const SQL = SQL_RAW.replace(/--[^\n]*/g, '');
const SCHEMA = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');

const COLUMNS = [
  'human_decision',
  'decision_reason',
  'decision_at',
  'decision_by_user_id',
  'next_action',
  'next_action_due_at',
];

// ── The vocabulary is not the workflow vocabulary ────────────────────────────

describe('a decision is not a workflow status', () => {
  test('the vocabularies are different lists', () => {
    // The whole reason the columns exist. Reusing workflowStatus would make "we
    // chose not to bid this" indistinguishable from "the source closed", and only
    // one of those is a decision somebody can be asked about later.
    expect([...HUMAN_DECISIONS]).toEqual(['pursue', 'monitor', 'pass']);
    expect([...HUMAN_DECISIONS]).not.toEqual([...OPPORTUNITY_WORKFLOW_STATUSES]);
  });

  test('monitor and pass have no workflow equivalent', () => {
    for (const decision of ['monitor', 'pass'] as const) {
      expect([...OPPORTUNITY_WORKFLOW_STATUSES]).not.toContain(decision);
    }
  });

  test('machine states are not decisions', () => {
    for (const machineOnly of ['suggested', 'expired'] as const) {
      expect([...HUMAN_DECISIONS]).not.toContain(machineOnly);
    }
  });

  test('the CHECK constraint admits exactly the three decisions', () => {
    const chk = /human_decision" IS NULL OR "human_decision" IN \(([^)]*)\)/.exec(SQL);
    expect(chk).not.toBeNull();
    const admitted = [...chk![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(admitted.sort()).toEqual([...HUMAN_DECISIONS].sort());
  });
});

// ── The migration is additive and reversible-by-omission ────────────────────

describe('the migration is additive', () => {
  test('it exists and drops nothing', () => {
    expect(SQL.length).toBeGreaterThan(0);
    expect(SQL).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i);
  });

  test.each(COLUMNS)('%s is added, and NOT NULL is never applied to it', (column) => {
    expect(SQL).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`));
    expect(SQL).not.toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"[^,;]*NOT\\s+NULL`, 'i'));
  });

  test('no column gets a DEFAULT', () => {
    // A default would fabricate a decision for the entire existing corpus. NULL is
    // the only honest value for a row nobody has looked at.
    for (const column of COLUMNS) {
      const decl = new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"[^,;]*`, 'i').exec(SQL);
      expect(decl).not.toBeNull();
      expect(decl![0]).not.toMatch(/DEFAULT/i);
    }
  });

  test('there is no backfill — an undecided row stays undecided', () => {
    expect(SQL).not.toMatch(/\bUPDATE\s+"?client_funding_opportunity"?/i);
  });

  test('every statement is retry-safe, so a partial failure can be re-run', () => {
    // A failed migration blocks every later one, so a retry must be a no-op.
    const adds = SQL.match(/ADD COLUMN\s+(IF NOT EXISTS\s+)?/g) ?? [];
    expect(adds.length).toBe(COLUMNS.length);
    for (const a of adds) expect(a).toContain('IF NOT EXISTS');

    const creates = SQL.match(/CREATE (UNIQUE )?INDEX\s+(IF NOT EXISTS\s+)?/g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const c of creates) expect(c).toContain('IF NOT EXISTS');

    // Constraints have no IF NOT EXISTS in Postgres, so each is guarded by a
    // pg_constraint existence check instead.
    const constraintAdds = SQL.match(/ADD CONSTRAINT/g) ?? [];
    const guards = SQL.match(/FROM pg_constraint WHERE conname/g) ?? [];
    expect(constraintAdds.length).toBe(guards.length);
    expect(constraintAdds.length).toBe(3);
  });

  test('it does not re-create the RLS policies', () => {
    // The table already has four tenant-predicated policies from 20260810010000.
    // Re-issuing them risks replacing one with a subtly different predicate, and
    // adding columns does not affect RLS at all.
    expect(SQL).not.toMatch(/CREATE POLICY/i);
    expect(SQL).not.toMatch(/ROW LEVEL SECURITY/i);
  });

  test('it only ever touches client_funding_opportunity', () => {
    const tables = new Set(
      [...SQL.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]!),
    );
    expect([...tables]).toEqual(['client_funding_opportunity']);
  });

  test('every ALTER TABLE names a table the schema actually maps', () => {
    // The @@map trap that broke main on 2026-07-28: `client` vs `clients`.
    const mapped = new Set([...SCHEMA.matchAll(/@@map\("([^"]+)"\)/g)].map((m) => m[1]!));
    for (const m of SQL.matchAll(/ALTER TABLE "([a-z_]+)"/g)) {
      expect(mapped.has(m[1]!)).toBe(true);
    }
  });
});

// ── The integrity CHECKs ────────────────────────────────────────────────────

describe('a decision cannot exist without an actor and a timestamp', () => {
  test('the three-way all-or-nothing CHECK is present', () => {
    // Written as one three-way constraint rather than three NOT NULLs because each
    // column is legitimately NULL on an undecided row — they are only meaningful
    // together.
    expect(SQL).toContain('client_funding_opportunity_decision_actor_chk');
    const chk = /decision_actor_chk[\s\S]*?CHECK \(([\s\S]*?)\);/.exec(SQL);
    expect(chk).not.toBeNull();
    const body = chk![1]!;
    for (const column of ['human_decision', 'decision_at', 'decision_by_user_id']) {
      expect(body).toContain(`"${column}" IS NULL`);
      expect(body).toContain(`"${column}" IS NOT NULL`);
    }
  });

  test('a due date requires an action, but not the reverse', () => {
    // A due date with no action is a reminder about nothing. An action with no
    // deadline is perfectly normal.
    expect(SQL).toContain('client_funding_opportunity_next_action_chk');
    const chk = /next_action_chk[\s\S]*?CHECK \(([\s\S]*?)\);/.exec(SQL);
    expect(chk![1]!).toMatch(/"next_action_due_at" IS NULL OR "next_action" IS NOT NULL/);
  });
});

// ── The index ───────────────────────────────────────────────────────────────

describe('the decision index', () => {
  test('is partial, so it covers only decided rows', () => {
    // The table is overwhelmingly machine suggestions. A full index would be mostly
    // NULLs and cost write throughput for nothing.
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS "client_funding_opportunity_decision_idx"[\s\S]*?WHERE "human_decision" IS NOT NULL/,
    );
  });

  test('is declared in schema.prisma, so `prisma migrate dev` sees no drift', () => {
    // An index that exists only in SQL reads as drift to the next person running
    // migrate dev; one declared only in Prisma never gets created at all.
    for (const m of SQL.matchAll(/CREATE INDEX IF NOT EXISTS "([a-z_]+)"/g)) {
      expect(SCHEMA).toContain(m[1]!);
    }
  });

  test('leads on tenant_id, like every other index on this table', () => {
    const idx = /"client_funding_opportunity_decision_idx"\s*\n?\s*ON "client_funding_opportunity" \(([^)]*)\)/.exec(SQL);
    expect(idx).not.toBeNull();
    expect(idx![1]!.trim().startsWith('"tenant_id"')).toBe(true);
  });
});

// ── Ordering, so the migration actually applies ─────────────────────────────

describe('migration ordering', () => {
  test('it sorts after every Funding Opportunities migration that precedes it', () => {
    // Prisma applies by directory name. A migration stamped EARLIER than one
    // already applied is never run — silently — on every environment where the
    // earlier one landed first.
    const names = readdirSync(MIGRATION_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const fo = names.filter((n) => /_funding_opportunit/.test(n));
    expect(fo).toContain(MIGRATION_NAME);
    expect(fo[fo.length - 1]).toBe(MIGRATION_NAME);
    expect([...fo].sort()).toEqual(fo);
  });

  test('its timestamp prefix is unique', () => {
    const names = readdirSync(MIGRATION_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const prefix = MIGRATION_NAME.slice(0, 14);
    expect(names.filter((n) => n.startsWith(prefix))).toEqual([MIGRATION_NAME]);
  });
});

// ── Prisma schema agreement ─────────────────────────────────────────────────

describe('schema.prisma agrees with the migration', () => {
  const model = /model\s+ClientFundingOpportunity\s*\{([\s\S]*?)\n\}/.exec(SCHEMA)?.[1] ?? '';

  test.each([
    ['humanDecision', 'human_decision'],
    ['decisionReason', 'decision_reason'],
    ['decisionAt', 'decision_at'],
    ['decisionByUserId', 'decision_by_user_id'],
    ['nextAction', 'next_action'],
    ['nextActionDueAt', 'next_action_due_at'],
  ])('%s maps to %s and is optional', (field, column) => {
    const decl = new RegExp(`\\n\\s*${field}\\s+([^\\n]*)`).exec(model);
    expect(decl).not.toBeNull();
    expect(decl![1]!).toContain(`@map("${column}")`);
    // Optional in Prisma, nullable in SQL. Both, or the client and the database
    // disagree about what an undecided row looks like.
    expect(decl![1]!).toMatch(/\?/);
  });

  test('the model still declares tenantId, so the tenant-scope guard covers it', () => {
    expect(model).toMatch(/\n\s*tenantId\s/);
  });
});

// ── The endpoint is dedicated, and carries no row identity in its body ──────

describe('the decision endpoint', () => {
  const controller = readFileSync(join(__dirname, 'funding-opportunities.controller.ts'), 'utf8');

  test('is its own route, not an overload of the generic PATCH', () => {
    // A decision is one atomic assertion that always carries an actor and a
    // timestamp; the generic patch takes any subset of five independent fields.
    // Threading one through the other means a body with only `{notes}` cannot be
    // told apart from one that also meant to clear a decision.
    expect(controller).toContain("@Post('clients/:clientId/opportunities/:source/:id/decision')");
  });

  test('requires the decision — it is not an optional field', () => {
    const dto = /class DecideOpportunityDto \{([\s\S]*?)\n\}/.exec(controller);
    expect(dto).not.toBeNull();
    const decisionField = /@IsIn\(HUMAN_DECISIONS\)\s*\n\s*decision!/.exec(dto![1]!);
    expect(decisionField).not.toBeNull();
  });

  test('takes client, source and id from the PATH only', () => {
    // Same reason P05 removed `id` from the mapping DTO: a request must not be able
    // to name one opportunity in its URL and another in its payload.
    const dto = /class DecideOpportunityDto \{([\s\S]*?)\n\}/.exec(controller)![1]!;
    for (const forbidden of ['clientId', 'source', 'sourceRecordId']) {
      expect(dto).not.toContain(forbidden);
    }
    // `id` would also match `nextActionDueAt`, so match a declaration instead.
    expect(dto).not.toMatch(/\n\s*id[?!]?:/);
  });
});
