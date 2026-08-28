import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { parseOutreachTemplateSpecV1 } from './outreach-template.contract.js';
import { STARTER_CONTENT_TEMPLATES } from './starter-content-templates.js';
import {
  STARTER_TEMPLATE_SEED_VERSION,
  StarterTemplateSeeder,
  starterTemplateId,
  starterTemplateSpec,
  starterTemplateVersionId,
} from './starter-template-seeder.js';

function apiRoot(): string {
  const cwd = process.cwd();
  return existsSync(resolve(cwd, 'prisma')) ? cwd : resolve(cwd, 'apps/api');
}
const read = (path: string) => readFileSync(resolve(apiRoot(), path), 'utf8');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('starter template ids', () => {
  it('are well-formed and stable across calls', () => {
    for (const starter of STARTER_CONTENT_TEMPLATES) {
      const first = starterTemplateId(TENANT_A, starter.key);
      expect(first).toMatch(UUID_RE);
      expect(starterTemplateId(TENANT_A, starter.key)).toBe(first);
    }
  });

  it('differs per tenant, so one tenant cannot collide with another', () => {
    for (const starter of STARTER_CONTENT_TEMPLATES) {
      expect(starterTemplateId(TENANT_A, starter.key)).not.toBe(
        starterTemplateId(TENANT_B, starter.key),
      );
    }
  });

  it('differs per starter, and template ids never collide with version ids', () => {
    const ids = new Set<string>();
    for (const starter of STARTER_CONTENT_TEMPLATES) {
      ids.add(starterTemplateId(TENANT_A, starter.key));
      ids.add(starterTemplateVersionId(TENANT_A, starter.key));
    }
    // 7 starters x (template + version), all distinct.
    expect(ids.size).toBe(STARTER_CONTENT_TEMPLATES.length * 2);
  });
});

describe('starter template spec', () => {
  it.each(STARTER_CONTENT_TEMPLATES.map((s) => [s.key, s] as const))(
    '%s produces a spec that parses against the v1 contract',
    (_key, starter) => {
      const spec = starterTemplateSpec(starter);
      expect(() => parseOutreachTemplateSpecV1(spec)).not.toThrow();
    },
  );

  it.each(STARTER_CONTENT_TEMPLATES.map((s) => [s.key, s] as const))(
    '%s carries its skeleton verbatim, which is the whole point of seeding it',
    (_key, starter) => {
      const spec = starterTemplateSpec(starter);
      expect(spec.contentSkeleton).toEqual(starter.skeleton);
    },
  );

  /*
   * A starter supplies STRUCTURE, not a campaign. If it pre-decided the goal,
   * the sponsor, the delivery pattern or the audience, a user would land in the
   * builder with a campaign that looks answered and is wrong — and the readiness
   * model would report steps as satisfied that nobody had actually reviewed.
   */
  it.each(STARTER_CONTENT_TEMPLATES.map((s) => [s.key, s] as const))(
    '%s pre-decides nothing the builder exists to ask',
    (_key, starter) => {
      const spec = starterTemplateSpec(starter);
      expect(spec.goal).toEqual({
        goal: null,
        objective: null,
        topic: null,
        desiredOutcome: null,
        ask: { mode: 'undecided', text: null },
        whyNow: null,
      });
      expect(spec.sponsor).toEqual({ kind: 'undecided', label: null });
      expect(spec.targeting.criteria).toBeNull();
      expect(spec.delivery).toEqual({ pattern: 'undecided', personalization: 'undecided' });
      expect(spec.strategy.campaignAngle).toBeNull();
      expect(spec.strategy.tone).toBeNull();
      expect(spec.variables).toEqual([]);
      expect(spec.styleSamples).toEqual([]);
    },
  );

  it('sets a length, because a skeleton already implies one', () => {
    for (const starter of STARTER_CONTENT_TEMPLATES) {
      // Leaving this 'undecided' would let generation choose a length that
      // fights the structure the skeleton just fixed.
      expect(starterTemplateSpec(starter).strategy.length).toBe('short');
    }
  });
});

/**
 * Orchestration, against a mocked Prisma. The SQL itself is asserted as a
 * source/migration contract in the block below and exercised for real by the
 * DB-backed suite — these tests cover the decisions the seeder makes ABOUT
 * running, which is where the behaviour that matters lives.
 */
describe('StarterTemplateSeeder orchestration', () => {
  interface Harness {
    seeder: StarterTemplateSeeder;
    queryRaw: jest.Mock;
    withTenantUser: jest.Mock;
    txExecuteRaw: jest.Mock;
    txQueryRaw: jest.Mock;
  }

  function harness(
    options: { admin?: boolean; seededVersion?: number | null; insertConflicts?: boolean } = {},
  ): Harness {
    const { admin = true, seededVersion = null, insertConflicts = false } = options;

    const queryRaw = jest.fn(async (strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join('') : String(strings);
      if (sql.includes('tenant_memberships')) {
        return admin ? [{ userId: ADMIN }] : [];
      }
      if (sql.includes('outreach_v3_template_seed_state')) {
        return seededVersion === null ? [] : [{ seedVersion: seededVersion }];
      }
      return [];
    });

    const txQueryRaw = jest.fn(async () => (insertConflicts ? [] : [{ id: 'inserted' }]));
    const txExecuteRaw = jest.fn(async () => 1);
    const withTenantUser = jest.fn(
      async (_tenantId: string, _userId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $queryRaw: txQueryRaw, $executeRaw: txExecuteRaw }),
    );

    const prisma = { $queryRaw: queryRaw, withTenantUser } as unknown as PrismaService;
    return {
      seeder: new StarterTemplateSeeder(prisma),
      queryRaw,
      withTenantUser,
      txExecuteRaw,
      txQueryRaw,
    };
  }

  it('seeds every starter on a fresh tenant and records the marker', async () => {
    const h = harness();
    const result = await h.seeder.ensureSeeded(TENANT_A);

    expect(result).toEqual({ outcome: 'seeded', created: STARTER_CONTENT_TEMPLATES.length });
    // One template INSERT per starter.
    expect(h.txQueryRaw).toHaveBeenCalledTimes(STARTER_CONTENT_TEMPLATES.length);
    // Marker written exactly once, after the rows.
    const markerCalls = h.txExecuteRaw.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join('').includes('outreach_v3_template_seed_state'),
    );
    expect(markerCalls).toHaveLength(1);
  });

  it('does nothing when the tenant is already at the current seed version', async () => {
    const h = harness({ seededVersion: STARTER_TEMPLATE_SEED_VERSION });
    const result = await h.seeder.ensureSeeded(TENANT_A);

    expect(result).toEqual({ outcome: 'already_current', created: 0 });
    expect(h.withTenantUser).not.toHaveBeenCalled();
  });

  /*
   * The regression this whole marker table exists to prevent. Starters are
   * ordinary, deletable rows; if the seeder decided from the rows' own presence
   * it would silently resurrect a template the tenant chose to remove.
   */
  it('never resurrects a deleted starter — an at-version tenant is left alone even with zero rows', async () => {
    const h = harness({ seededVersion: STARTER_TEMPLATE_SEED_VERSION, insertConflicts: true });
    const result = await h.seeder.ensureSeeded(TENANT_A);

    expect(result.outcome).toBe('already_current');
    expect(h.txQueryRaw).not.toHaveBeenCalled();
  });

  it('re-runs when the starter set has been revised past the tenant version', async () => {
    const h = harness({ seededVersion: STARTER_TEMPLATE_SEED_VERSION - 1 });
    const result = await h.seeder.ensureSeeded(TENANT_A);
    expect(result.outcome).toBe('seeded');
  });

  it('counts only rows it actually inserted, so a partial re-run is honest', async () => {
    const h = harness({ seededVersion: STARTER_TEMPLATE_SEED_VERSION - 1, insertConflicts: true });
    const result = await h.seeder.ensureSeeded(TENANT_A);
    expect(result).toEqual({ outcome: 'seeded', created: 0 });
  });

  /*
   * Owning shared firm templates as whoever opened the tab first would hand
   * that person canEdit/canArchive over templates their peers cannot touch
   * (computeTemplateCapabilities: isManager = isOwner || (isAdmin && !private)).
   * With no admin to own them, skipping is the only non-arbitrary choice.
   */
  it('skips seeding rather than guessing an owner when the tenant has no active admin', async () => {
    const h = harness({ admin: false });
    const result = await h.seeder.ensureSeeded(TENANT_A);

    expect(result).toEqual({ outcome: 'no_admin', created: 0 });
    expect(h.withTenantUser).not.toHaveBeenCalled();
  });

  it('retries on a later read after an admin exists, rather than caching the skip', async () => {
    const h = harness({ admin: false });
    await h.seeder.ensureSeeded(TENANT_A);
    await h.seeder.ensureSeeded(TENANT_A);
    // Two membership lookups: 'no_admin' must NOT be memoised as known-current.
    const adminLookups = h.queryRaw.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join('').includes('tenant_memberships'),
    );
    expect(adminLookups).toHaveLength(2);
  });

  it('never throws — a seeding failure must not turn a library read into a 500', async () => {
    const prisma = {
      $queryRaw: jest.fn(async () => {
        throw new Error('connection reset');
      }),
      withTenantUser: jest.fn(),
    } as unknown as PrismaService;
    const seeder = new StarterTemplateSeeder(prisma);

    await expect(seeder.ensureSeeded(TENANT_A)).resolves.toEqual({
      outcome: 'failed',
      created: 0,
    });
  });

  it('keeps the steady-state cost at zero queries once a tenant is known current', async () => {
    const h = harness({ seededVersion: STARTER_TEMPLATE_SEED_VERSION });
    await h.seeder.ensureSeeded(TENANT_A);
    const afterFirst = h.queryRaw.mock.calls.length;
    await h.seeder.ensureSeeded(TENANT_A);
    await h.seeder.ensureSeeded(TENANT_A);
    expect(h.queryRaw.mock.calls.length).toBe(afterFirst);
  });
});

describe('starter template seed persistence authority', () => {
  const migration = read(
    'prisma/migrations/20280102010000_outreach_v3_template_seed_state/migration.sql',
  );
  const seeder = read('src/outreach-v3/templates/starter-template-seeder.ts');
  const service = read('src/outreach-v3/templates/outreach-template.service.ts');

  it('puts the marker table under the same forced RLS as the template tables', () => {
    expect(migration).toContain(
      'ALTER TABLE outreach_v3_template_seed_state ENABLE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ALTER TABLE outreach_v3_template_seed_state FORCE ROW LEVEL SECURITY',
    );
  });

  it('uses the canonical RLS helpers rather than re-deriving tenancy', () => {
    expect(migration).toContain('current_tenant_id()');
    expect(migration).toContain('rls_bypass()');
    // A WITH CHECK is required, not just USING — without it a tenant could
    // insert a marker row for a different tenant.
    expect(migration).toMatch(/WITH CHECK/);
  });

  it('keeps the marker separate from the template rows', () => {
    // If the marker ever became a count of template rows, deletion would stop
    // being permanent. The table must key on tenant alone.
    expect(migration).toContain('tenant_id    uuid PRIMARY KEY');
    expect(migration).not.toMatch(/REFERENCES\s+outreach_v3_templates/);
  });

  it('seeds firm scope, never a Capiro scope the contract defers', () => {
    // outreach-template.contract.ts records that a release-controlled
    // system/Capiro origin is deliberately deferred because it would
    // "fabricate governance that doesn't exist".
    expect(seeder).toContain("'firm'");
    expect(seeder).not.toMatch(/scope['"]?\s*[:,]\s*['"]capiro['"]/);
  });

  it('publishes what it seeds, so a seeded template is actually usable', () => {
    // canUse gates on publishedVersionId, and canPublish requires an admin for
    // non-private scopes — a starter left as a draft would be unusable by every
    // non-admin member.
    expect(seeder).toContain("'published'");
    expect(seeder).toContain('published_version_id');
  });

  it('inserts idempotently so concurrent first reads cannot double-seed', () => {
    const conflictGuards = seeder.match(/ON CONFLICT/g) ?? [];
    // template, version, 2 audit rows, marker upsert.
    expect(conflictGuards.length).toBeGreaterThanOrEqual(5);
  });

  it('is awaited on the library read, so the first visit shows the starters', () => {
    expect(service).toContain('await this.starters.ensureSeeded(ctx.tenantId)');
  });
});
