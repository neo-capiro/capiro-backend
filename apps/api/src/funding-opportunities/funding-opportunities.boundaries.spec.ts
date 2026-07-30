import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { FundingOpportunitiesController } from './funding-opportunities.controller.js';
import {
  FUNDING_OPPORTUNITIES_FEATURE,
  FundingOpportunitiesFlagGuard,
} from './funding-opportunities-flag.guard.js';
import {
  HUMAN_DECISION_STATUSES,
  OPPORTUNITY_WORKFLOW_STATUSES,
  WORKFLOW_SORT_PRIORITY,
} from './funding-opportunities.types.js';

const MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20260810010000_funding_opportunities/migration.sql',
);
const CLOSEOUT_MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20260810020000_funding_opportunities_closeout/migration.sql',
);
const LIFECYCLE_MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20260810040000_funding_opportunities_lifecycle_truth/migration.sql',
);
const SCHEMA = join(__dirname, '../../prisma/schema.prisma');

// ── Role matrix, against the REAL RolesGuard and the real decorator metadata ──

function contextFor(role: string, handler: (...args: never[]) => unknown): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => FundingOpportunitiesController,
    switchToHttp: () => ({
      getRequest: () => ({ tenantContext: { tenantId: 't', userId: 'u', role } }),
    }),
  } as unknown as ExecutionContext;
}

describe('role matrix (real RolesGuard, real @Roles metadata)', () => {
  const guard = new RolesGuard(new Reflector());
  const proto = FundingOpportunitiesController.prototype;
  const handlers: Array<[string, (...args: never[]) => unknown]> = [
    ['list', proto.list],
    ['getOne', proto.getOne],
    ['listForClient', proto.listForClient],
    ['summaryForClient', proto.summaryForClient],
    ['save', proto.save],
    ['patch', proto.patch],
    ['dismiss', proto.dismiss],
    ['restore', proto.restore],
  ];

  test('the controller declares standard_user as its minimum', () => {
    const declared = Reflect.getMetadata(ROLES_KEY, FundingOpportunitiesController);
    expect(declared).toEqual(['standard_user']);
  });

  test.each(handlers)('standard_user may reach %s', (_name, handler) => {
    expect(guard.canActivate(contextFor('standard_user', handler))).toBe(true);
  });

  test.each(handlers)('user_admin may reach %s', (_name, handler) => {
    expect(guard.canActivate(contextFor('user_admin', handler))).toBe(true);
  });

  test.each(handlers)('capiro_admin may reach %s', (_name, handler) => {
    expect(guard.canActivate(contextFor('capiro_admin', handler))).toBe(true);
  });

  test.each(handlers)('client_portal_user is DENIED %s', (_name, handler) => {
    // Portal users rank below standard_user, so the same rank comparison that
    // admits the three roles above excludes them. There is deliberately no
    // separate portal read path in this module for one to leak through.
    expect(() => guard.canActivate(contextFor('client_portal_user', handler))).toThrow(
      ForbiddenException,
    );
  });

  test('an unrecognized role fails CLOSED', () => {
    expect(() => guard.canActivate(contextFor('legacy_owner', proto.list))).toThrow(
      ForbiddenException,
    );
  });

  test('mapping MANAGEMENT is not on this controller', () => {
    // Splitting one review surface across two controllers with two different
    // guards is how a route ends up gated by neither. The user_admin mapping
    // actions live on IntelligenceController with the other mapping routes.
    const names = Object.getOwnPropertyNames(proto);
    for (const n of names) {
      expect(n.toLowerCase()).not.toContain('mapping');
      expect(n.toLowerCase()).not.toContain('confirm');
    }
  });
});

// ── The flag guard ships the feature dark ───────────────────────────────────

describe('FundingOpportunitiesFlagGuard fails closed', () => {
  function ctx(tenantId: string | undefined): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ tenantContext: tenantId ? { tenantId } : undefined }),
      }),
    } as unknown as ExecutionContext;
  }

  test('no tenant context → 404, leaking nothing', async () => {
    const guard = new FundingOpportunitiesFlagGuard({ withSystem: jest.fn() } as never);
    await expect(guard.canActivate(ctx(undefined))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('no enabled flag row → 404 (not 403: a 403 advertises the feature)', async () => {
    const guard = new FundingOpportunitiesFlagGuard({
      withSystem: jest.fn(async () => []),
    } as never);
    await expect(guard.canActivate(ctx('t1'))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('an enabled flag row → allowed', async () => {
    const guard = new FundingOpportunitiesFlagGuard({
      withSystem: jest.fn(async () => [{ ok: 1 }]),
    } as never);
    await expect(guard.canActivate(ctx('t1'))).resolves.toBe(true);
  });

  test('a flag read that ERRORS fails closed rather than opening the feature', async () => {
    const guard = new FundingOpportunitiesFlagGuard({
      withSystem: jest.fn(async () => {
        throw new Error('42883 operator does not exist: text = uuid');
      }),
    } as never);
    await expect(guard.canActivate(ctx('t1'))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('there is NO implicit internal-tenant fallback in the CODE', () => {
    // DistrictNexusFlagGuard treats the capiro-internal slug as implicitly
    // enabled, which meant merging it enabled the feature for a tenant. This
    // guard requires an explicit row for EVERY tenant, so merging changes nothing
    // anywhere — turning it on is a reviewable flag write.
    //
    // Comments are stripped first: the docblock explains the difference from
    // District Nexus and legitimately names both, so scanning raw text would fail
    // on the explanation rather than on any behaviour.
    const src = stripComments(
      readFileSync(join(__dirname, 'funding-opportunities-flag.guard.ts'), 'utf8'),
    );
    expect(src).not.toContain('capiro-internal');
    expect(src).not.toContain('CAPIRO_INTERNAL_TENANT_ID');
    // The only tenant-membership test in the code is the flag row itself.
    expect(src).not.toMatch(/FROM\s+tenants/i);
  });

  test('the flag key is the one the runbook and the web nav use', () => {
    expect(FUNDING_OPPORTUNITIES_FEATURE).toBe('funding_opportunities');
  });

  test('the flag read does NOT cast tenant_id to uuid', () => {
    // intel_feature_flag.tenant_id is TEXT. The District Nexus rollout shipped a
    // ::uuid cast, every read threw 42883, hit the catch, and the feature 404'd
    // for a tenant whose flag was genuinely on.
    const src = readFileSync(join(__dirname, 'funding-opportunities-flag.guard.ts'), 'utf8');
    const flagQuery = src.slice(src.indexOf('intel_feature_flag'));
    expect(flagQuery).not.toMatch(/tenant_id\s*=\s*\$\{tenantId\}::uuid/);
  });
});

// ── Migration guards ────────────────────────────────────────────────────────

describe('migration: RLS, uniqueness, check constraints', () => {
  const sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, 'utf8') : '';

  test('the migration exists', () => {
    expect(sql.length).toBeGreaterThan(0);
  });

  test('the new tenant-scoped table carries tenant_id NOT NULL', () => {
    expect(sql).toMatch(/"tenant_id"\s+UUID\s+NOT\s+NULL/);
  });

  test('RLS is ENABLED and FORCED', () => {
    expect(sql).toContain('ALTER TABLE "client_funding_opportunity" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "client_funding_opportunity" FORCE ROW LEVEL SECURITY');
  });

  test('all four RLS policies exist and every one is tenant-predicated', () => {
    for (const op of ['select', 'insert', 'update', 'delete']) {
      expect(sql).toContain(`client_funding_opportunity_${op}`);
    }
    const policyCount = (sql.match(/rls_bypass\(\) OR tenant_id = current_tenant_id\(\)/g) ?? [])
      .length;
    // select + insert + update(using) + update(with check) + delete = 5 predicates.
    expect(policyCount).toBeGreaterThanOrEqual(5);
  });

  test('duplicate workflow rows are blocked by PARTIAL unique indexes, one per source', () => {
    // Postgres treats NULLs as distinct, so a single unique index across the
    // nullable pair would admit unlimited duplicates for the other source.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "client_funding_opportunity_grant_uniq"[\s\S]*?WHERE "grant_opportunity_id" IS NOT NULL/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "client_funding_opportunity_sam_uniq"[\s\S]*?WHERE "sam_opportunity_id" IS NOT NULL/,
    );
  });

  test('exactly one source record is enforced by a CHECK, not trusted to the writer', () => {
    expect(sql).toContain('client_funding_opportunity_one_source_chk');
    expect(sql).toMatch(
      /"source" = 'grants_gov' AND "grant_opportunity_id" IS NOT NULL AND "sam_opportunity_id" IS NULL/,
    );
    expect(sql).toMatch(
      /"source" = 'sam_gov' AND "sam_opportunity_id" IS NOT NULL AND "grant_opportunity_id" IS NULL/,
    );
  });

  test('workflow status and eligibility vocabularies are CHECK-constrained', () => {
    for (const s of OPPORTUNITY_WORKFLOW_STATUSES) {
      expect(sql).toContain(`'${s}'`);
    }
    expect(sql).toContain('client_funding_opportunity_status_chk');
    expect(sql).toContain('client_funding_opportunity_eligibility_chk');
  });

  test('every statement is retry-safe (IF NOT EXISTS / guarded policy creation)', () => {
    // A retry after a partial failure must be a no-op: a failed migration blocks
    // every later one.
    const creates = sql.match(/CREATE (TABLE|INDEX|UNIQUE INDEX)\s+(IF NOT EXISTS\s+)?/g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const c of creates) expect(c).toContain('IF NOT EXISTS');
    expect(sql).toContain('SELECT 1 FROM pg_policies');
  });

  test('the migration is ADDITIVE — no DROP, no NOT NULL added to an existing table', () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b/i);
    // Additive columns on existing tables must all be nullable.
    const alters =
      sql.match(/ALTER TABLE "(sam_opportunity|client_intel_mapping)"[\s\S]*?;/g) ?? [];
    expect(alters.length).toBe(2);
    for (const a of alters) expect(a).not.toMatch(/NOT\s+NULL/i);
  });

  test('every ALTER TABLE names a table the schema actually maps', () => {
    // The @@map trap that broke main on 2026-07-28: `client` vs `clients`.
    const schema = readFileSync(SCHEMA, 'utf8');
    const mapped = new Set([...schema.matchAll(/@@map\("([^"]+)"\)/g)].map((m) => m[1]!));
    for (const m of sql.matchAll(/ALTER TABLE "([a-z_]+)"/g)) {
      expect(mapped.has(m[1]!)).toBe(true);
    }
  });

  test('this feature’s newest migration is last among feature-owned migrations and has a unique prefix', () => {
    // Independent feature streams legitimately add later migrations. Requiring a
    // Funding Opportunities migration to remain the final directory repo-wide
    // makes unrelated additive work fail this suite and does not prove anything
    // about this feature's own ordering. The clean-database migration step in the
    // workflow proves the complete repository sequence is deployable.
    const dir = join(__dirname, '../../prisma/migrations');
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const ours = names.filter((n) => /_funding_opportunities/.test(n));
    expect(ours.length).toBeGreaterThanOrEqual(3);
    const newestOurs = ours[ours.length - 1]!;
    expect(newestOurs).toBe('20260810040000_funding_opportunities_lifecycle_truth');
    expect(ours.indexOf(newestOurs)).toBe(ours.length - 1);
    const prefix = newestOurs.slice(0, 14);
    expect(names.filter((n) => n.startsWith(prefix))).toEqual([newestOurs]);
  });

  describe('lifecycle-truth migration: fingerprint, active snapshot, cursor', () => {
    const lifecycle = existsSync(LIFECYCLE_MIGRATION)
      ? readFileSync(LIFECYCLE_MIGRATION, 'utf8')
      : '';

    test('it exists and is additive', () => {
      expect(lifecycle.length).toBeGreaterThan(0);
      expect(lifecycle).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b/i);
    });

    test('both snapshot columns are nullable and retry-safe', () => {
      // NULL is load-bearing: it means "no baseline yet", which the lifecycle pass
      // treats as a SILENT first observation. A NOT NULL default would make every
      // legacy row look like it had been observed.
      for (const column of ['source_fingerprint', 'source_active_snapshot']) {
        expect(lifecycle).toMatch(
          new RegExp(
            `ALTER TABLE "client_funding_opportunity"[\\s\\S]*?ADD COLUMN IF NOT EXISTS "${column}"`,
          ),
        );
      }
      expect(lifecycle).not.toMatch(
        /ADD COLUMN IF NOT EXISTS "source_(fingerprint|active_snapshot)"[^;]*NOT\s+NULL/i,
      );
    });

    test('the lifecycle keyset cursor index exists', () => {
      expect(lifecycle).toMatch(
        /CREATE INDEX IF NOT EXISTS "client_funding_opportunity_tenant_cursor_idx"[\s\S]*?\("tenant_id", "id"\)/,
      );
    });

    test('discovery indexes cover the predicated reads', () => {
      expect(lifecycle).toContain('federal_grant_lifecycle_enrichment_idx');
      expect(lifecycle).toContain('sam_opportunity_lifecycle_idx');
    });

    test('every statement is retry-safe', () => {
      const creates =
        lifecycle.match(/CREATE (TABLE|INDEX|UNIQUE INDEX)\s+(IF NOT EXISTS\s+)?/g) ?? [];
      expect(creates.length).toBeGreaterThan(0);
      for (const c of creates) expect(c).toContain('IF NOT EXISTS');
      const adds = lifecycle.match(/ADD COLUMN\s+(IF NOT EXISTS\s+)?/g) ?? [];
      expect(adds.length).toBeGreaterThan(0);
      for (const a of adds) expect(a).toContain('IF NOT EXISTS');
    });

    test('every index it creates is declared in schema.prisma', () => {
      // Drift here is invisible until someone runs `prisma migrate dev` and gets a
      // spurious diff, or until a planner regression traces back to an index the
      // schema never knew about.
      const schema = readFileSync(SCHEMA, 'utf8');
      for (const m of lifecycle.matchAll(/CREATE INDEX IF NOT EXISTS "([a-z_]+)"/g)) {
        expect(schema).toContain(m[1]!);
      }
    });
  });
  describe('closeout migration: reviewed identities and lifecycle state', () => {
    const closeout = existsSync(CLOSEOUT_MIGRATION) ? readFileSync(CLOSEOUT_MIGRATION, 'utf8') : '';

    test('the closeout migration exists and is additive', () => {
      expect(closeout.length).toBeGreaterThan(0);
      expect(closeout).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b/i);
    });

    test('client qualification and lifecycle snapshot columns are retry-safe', () => {
      expect(closeout).toMatch(
        /ALTER TABLE "clients"[\s\S]*ADD COLUMN IF NOT EXISTS "set_aside_certifications" TEXT\[\] NOT NULL DEFAULT/,
      );
      for (const column of [
        'source_status_snapshot',
        'response_deadline_snapshot',
        'source_updated_at_snapshot',
        'alert_state_jsonb',
      ]) {
        expect(closeout).toContain(`ADD COLUMN IF NOT EXISTS "${column}"`);
      }
      expect(closeout).toContain(
        'CREATE INDEX IF NOT EXISTS "client_funding_opportunity_lifecycle_idx"',
      );
    });

    test('mapping review state is backfilled before NOT NULL is enforced', () => {
      const add = closeout.indexOf('ADD COLUMN IF NOT EXISTS "review_status"');
      const backfill = closeout.indexOf('UPDATE "client_intel_mapping"');
      const notNull = closeout.indexOf('ALTER COLUMN "review_status" SET NOT NULL');
      expect(add).toBeGreaterThanOrEqual(0);
      expect(backfill).toBeGreaterThan(add);
      expect(notNull).toBeGreaterThan(backfill);
      expect(closeout).toContain(
        "CHECK (\"review_status\" IN ('candidate','confirmed','rejected','superseded'))",
      );
    });

    test('every closeout ALTER TABLE names a real mapped table', () => {
      const schema = readFileSync(SCHEMA, 'utf8');
      const mapped = new Set([...schema.matchAll(/@@map\("([^"]+)"\)/g)].map((m) => m[1]!));
      for (const m of closeout.matchAll(/ALTER TABLE "([a-z_]+)"/g)) {
        expect(mapped.has(m[1]!)).toBe(true);
      }
    });
  });
});

// ── The new model is covered by the tenant-scope guard ───────────────────────

describe('tenant-scope coverage', () => {
  test('ClientFundingOpportunity declares tenantId, so the guard auto-covers it', () => {
    // tenant-scope-guard.spec.ts derives its model list from the schema by looking
    // for a `tenantId` field, so declaring one is what enrols the model.
    const schema = readFileSync(SCHEMA, 'utf8');
    const model = /model\s+ClientFundingOpportunity\s*\{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';
    expect(model).toMatch(/\n\s*tenantId\s/);
  });

  test('the service never touches the workflow model outside withTenant', () => {
    const src = readFileSync(join(__dirname, 'funding-opportunities.service.ts'), 'utf8');
    // Bare `this.prisma.clientFundingOpportunity.<op>` would silently return every
    // tenant's rows: the runtime role bypasses RLS.
    expect(src).not.toMatch(/this\.prisma\.clientFundingOpportunity\./);
  });

  test('every global-catalog read is explicitly marked exempt with a reason', () => {
    const src = readFileSync(join(__dirname, 'funding-opportunities.service.ts'), 'utf8');
    const globalReads = (src.match(/this\.prisma\.(federalGrant|samOpportunity)\./g) ?? []).length;
    const exemptions = (src.match(/tenant-scope-exempt:/g) ?? []).length;
    expect(globalReads).toBeGreaterThan(0);
    expect(exemptions).toBeGreaterThan(0);
  });
});

// ── Corporate award attribution must be explicitly reviewed ────────────────

describe('award attribution requires a confirmed reviewed mapping with opt-in roll-up', () => {
  const files = [
    join(__dirname, 'funding-opportunities.service.ts'),
    join(__dirname, '../district-nexus/district-nexus.service.ts'),
    join(__dirname, '../intelligence/report-card.service.ts'),
    join(__dirname, '../intelligence/intelligence.service.ts'),
  ];

  test('no award-attribution consumer treats null roll-up as enabled', () => {
    for (const file of files) {
      const src = stripComments(readFileSync(file, 'utf8'));
      expect(src).not.toMatch(/rollUpAwards\s*!==\s*false/);
    }
  });

  test('contracting and assistance award consumers require review + roll-up', () => {
    for (const file of files) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const match of src.matchAll(
        /source:\s*(?:\{\s*in:\s*\[[^\]]*(?:contracting|assistance_recipient)[^\]]*\]\s*\}|['"](?:contracting|assistance_recipient)['"])/g,
      )) {
        const nearby = src.slice(Math.max(0, match.index! - 180), match.index! + 360);
        if (!/confirmed:\s*true/.test(nearby)) continue;
        expect(nearby).toMatch(/reviewStatus:\s*['"]confirmed['"]/);
        expect(nearby).toMatch(/rollUpAwards:\s*true/);
      }
    }
  });
});

// ── Opportunities must not feed District Nexus scoring ──────────────────────

describe('a future opportunity never contributes to a District Nexus score', () => {
  const dnDir = join(__dirname, '../district-nexus');

  test('no District Nexus source file reads the funding-opportunity workflow model', () => {
    const files = readdirSync(dnDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(dnDir, f), 'utf8');
      if (/clientFundingOpportunity/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test('the District Nexus scorer SUPPRESSES awarded-funding credit for opportunity-only evidence', () => {
    // The guarantee is not "the scorer never hears about opportunities" — it does,
    // via `opportunityOnly`, and that is how the guarantee is IMPLEMENTED: an
    // awarded-funding component backed only by forecasts earns a zero multiplier,
    // not a reduced one. Asserting the absence of the word would have passed only
    // until someone deleted the protection.
    const src = readFileSync(join(dnDir, 'district-nexus-scoring.ts'), 'utf8');
    expect(src).toContain('opportunityOnly');
    expect(src).toMatch(
      /suppressedByOpportunityOnly[\s\S]{0,400}multiplier\s*=\s*suppressedByOpportunityOnly\s*\?\s*0/,
    );
  });

  test('the Funding Opportunities service never writes District Nexus evidence', () => {
    // A pursuit decision is not geographic evidence. If saving an opportunity
    // wrote a ClientGrantNexus row, it would start contributing to a district
    // nexus score — the exact false claim the two-table split exists to prevent.
    const src = readFileSync(join(__dirname, 'funding-opportunities.service.ts'), 'utf8');
    expect(src).not.toMatch(/clientGrantNexus/);
  });
});

/** Strip block and line comments so a source assertion tests code, not prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n\r]*/g, '');
}

// ── Contract-shape invariants ───────────────────────────────────────────────

describe('contract invariants', () => {
  test('there is no generic totalAmount anywhere in the types', () => {
    const src = readFileSync(join(__dirname, 'funding-opportunities.types.ts'), 'utf8');
    expect(src).not.toMatch(/\btotalAmount\b\s*[:?]/);
  });

  test('every human decision status is protected from the producer', () => {
    for (const s of ['saved', 'pursuing', 'dismissed', 'won', 'lost'] as const) {
      expect(HUMAN_DECISION_STATUSES.has(s)).toBe(true);
    }
    // 'suggested' is the producer's own output and 'expired' is mechanical.
    expect(HUMAN_DECISION_STATUSES.has('suggested')).toBe(false);
    expect(HUMAN_DECISION_STATUSES.has('expired')).toBe(false);
  });

  test('what a team is actively doing sorts above what a machine suggested', () => {
    expect(WORKFLOW_SORT_PRIORITY.pursuing).toBeLessThan(WORKFLOW_SORT_PRIORITY.saved);
    expect(WORKFLOW_SORT_PRIORITY.saved).toBeLessThan(WORKFLOW_SORT_PRIORITY.suggested);
    expect(WORKFLOW_SORT_PRIORITY.suggested).toBeLessThan(WORKFLOW_SORT_PRIORITY.dismissed);
  });

  test('every workflow status has a sort priority', () => {
    for (const s of OPPORTUNITY_WORKFLOW_STATUSES) {
      expect(typeof WORKFLOW_SORT_PRIORITY[s]).toBe('number');
    }
  });
});
