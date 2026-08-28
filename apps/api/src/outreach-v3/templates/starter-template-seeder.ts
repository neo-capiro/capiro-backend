import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  BLANK_TEMPLATE_GUIDANCE,
  DEFAULT_TEMPLATE_DEFAULTS_POLICY,
  DEFAULT_TEMPLATE_GUARDRAILS,
  OUTREACH_TEMPLATE_SPEC_VERSION,
  hashOutreachTemplateSpecV1,
  parseOutreachTemplateSpecV1,
  type OutreachTemplateSpecV1,
} from './outreach-template.contract.js';
import {
  STARTER_CONTENT_TEMPLATES,
  type StarterContentTemplate,
} from './starter-content-templates.js';

/**
 * Seeds the starter content templates into a tenant's template library.
 *
 * `starter-content-templates.ts` has held seven ready skeletons since it was
 * written, and its header states the intent: "seeded as `firm`-scope templates
 * so a whole tenant gets them and any member can duplicate one into a private
 * edit". Nothing ever called it — the array was imported only by its own spec
 * file, so the templates existed, were unit-tested, and were unreachable. This
 * is the missing half.
 *
 * ## Scope: firm, deliberately not a new "capiro" scope
 *
 * `outreach-template.contract.ts` records that a "release-controlled
 * system/Capiro origin" was explicitly deferred, because it "would either
 * fabricate governance that doesn't exist or block on unrelated
 * infrastructure", and instructs keeping the UI truthful via the empty Capiro
 * category instead. So these seed as ordinary `firm` rows and the Capiro
 * category stays empty and honest. A member sees them under All and Firm with
 * real, server-computed capabilities — nothing about the library UI changes.
 *
 * ## Idempotency has two halves, and both are load-bearing
 *
 * 1. **Deterministic ids.** A template's id is a stable function of
 *    (tenant, starter key), so a concurrent double-run collides on the primary
 *    key instead of inserting twice. No new column, no advisory lock.
 * 2. **A seed marker that is NOT the rows.** `outreach_v3_template_seed_state`
 *    records that a tenant has been seeded. Deciding from the rows' own
 *    presence would resurrect a starter that a tenant deliberately deleted —
 *    and these are explicitly deletable rows. Deletion has to be permanent.
 *
 * Bump `STARTER_TEMPLATE_SEED_VERSION` to roll a revised starter set out to
 * every tenant deliberately; tenants already at that version are untouched.
 *
 * ## Ownership: a tenant admin, never "whoever loaded the page first"
 *
 * `computeTemplateCapabilities` derives `isManager = isOwner || (isAdmin &&
 * scope !== 'private')`, so the owner of a firm template gets `canEdit` and
 * `canArchive`. Seeding as the triggering user would therefore hand edit and
 * archive rights over shared firm templates to whichever member happened to
 * open the Templates tab first — a privilege grant with no product intent
 * behind it. Owning them as a tenant admin grants nothing that admin did not
 * already have through `isAdmin`. If a tenant has no admin, seeding is skipped
 * rather than guessing an owner.
 */

/** Bump to roll a revised starter set out to every tenant. */
export const STARTER_TEMPLATE_SEED_VERSION = 1;

/**
 * Fixed namespace so ids are reproducible across processes and deploys. Not the
 * DNS namespace used by `deterministicUuid` in the defense-budget module — a
 * separate namespace keeps the two id spaces from ever colliding.
 */
const SEED_NAMESPACE = 'capiro:outreach-v3:starter-template:v1';

function deterministicUuid(input: string): string {
  const bytes = new Uint8Array(createHash('sha256').update(SEED_NAMESPACE).update(input).digest());
  // Version 5 / RFC-4122 variant bits. SHA-256 rather than SHA-1, so this is
  // "v5-shaped" rather than a literal v5 — the only property required here is
  // that it is a stable, well-formed UUID.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function starterTemplateId(tenantId: string, key: string): string {
  return deterministicUuid(`template:${tenantId}:${key}`);
}

export function starterTemplateVersionId(tenantId: string, key: string): string {
  return deterministicUuid(`version:${tenantId}:${key}`);
}

/**
 * The reusable intent a starter carries.
 *
 * Everything except the skeleton is left `undecided`/null on purpose. A starter
 * supplies STRUCTURE, not a campaign: it must not pre-decide the goal, the
 * sponsor, the delivery pattern or the audience, because those are the
 * decisions the builder exists to walk a user through. Pre-filling them would
 * make a template that looks complete and is wrong.
 *
 * `strategy.length` is the one exception — a skeleton's slot instructions
 * already imply a length, so leaving it `undecided` would let generation pick a
 * length that fights the structure.
 */
export function starterTemplateSpec(starter: StarterContentTemplate): OutreachTemplateSpecV1 {
  return parseOutreachTemplateSpecV1({
    schemaVersion: OUTREACH_TEMPLATE_SPEC_VERSION,
    goal: {
      goal: null,
      objective: null,
      topic: null,
      desiredOutcome: null,
      ask: { mode: 'undecided', text: null },
      whyNow: null,
    },
    sponsor: { kind: 'undecided', label: null },
    targeting: { criteria: null },
    delivery: { pattern: 'undecided', personalization: 'undecided' },
    strategy: {
      campaignAngle: null,
      tone: null,
      length: 'short',
      customLengthInstruction: null,
    },
    styleSamples: [],
    contentSkeleton: starter.skeleton,
    variables: [],
    defaultsPolicy: DEFAULT_TEMPLATE_DEFAULTS_POLICY,
    guidance: BLANK_TEMPLATE_GUIDANCE,
    guardrails: DEFAULT_TEMPLATE_GUARDRAILS,
  });
}

interface SeedOwnerRow {
  userId: string;
}

interface SeedStateRow {
  seedVersion: number;
}

export interface StarterSeedResult {
  /** 'seeded' — rows were considered; 'skipped' — nothing was attempted. */
  outcome: 'seeded' | 'already_current' | 'no_admin' | 'failed';
  created: number;
}

@Injectable()
export class StarterTemplateSeeder {
  private readonly logger = new Logger(StarterTemplateSeeder.name);
  /**
   * Tenants already found current in this process. Purely an optimisation to
   * keep the steady-state cost of a list() call at zero queries; correctness
   * still rests on the marker row, so a restart or a second replica is fine.
   */
  private readonly known = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Best-effort and never throws.
   *
   * This runs on the read path, so a seeding problem must degrade to "the
   * library shows what already exists" rather than turning a GET into a 500. A
   * failure is logged with the tenant and swallowed.
   */
  async ensureSeeded(tenantId: string): Promise<StarterSeedResult> {
    if (this.known.has(tenantId)) return { outcome: 'already_current', created: 0 };
    try {
      const result = await this.seed(tenantId);
      if (result.outcome === 'seeded' || result.outcome === 'already_current') {
        this.known.add(tenantId);
      }
      return result;
    } catch (error) {
      this.logger.warn(
        `Starter template seeding failed for tenant ${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { outcome: 'failed', created: 0 };
    }
  }

  private async seed(tenantId: string): Promise<StarterSeedResult> {
    /*
     * Both pre-flight reads run inside `withSystem`, which sets
     * `app.bypass_rls`.
     *
     * They originally used `this.prisma.$queryRaw` directly, and that was a real
     * bug, not a style choice. `tenant_memberships` is RLS-protected, and a bare
     * query establishes no tenant context — so `current_tenant_id()` is null,
     * the policy matches nothing, and the admin lookup returns zero rows for
     * EVERY tenant. The seeder would then take the `no_admin` branch forever and
     * never seed anything, on any tenant, while looking like it had simply found
     * nothing to do. (Confirmed empirically: the same query run without a tenant
     * context reports 0 tenants and 0 memberships against a database that has
     * plenty of both.)
     *
     * `withSystem` is the sanctioned path for exactly this: its own doc comment
     * names "cross-tenant admin tooling" as the use case, and choosing an owner
     * for a tenant is cross-tenant by nature — the caller's tenant context
     * cannot authorize reading a membership row to decide who should own a
     * template.
     *
     * Everything that WRITES template rows still runs inside `withTenantUser`
     * below, under RLS, as the chosen admin.
     */
    const { admin, currentVersion } = await this.prisma.withSystem(async (tx) => ({
      admin: await this.findTenantAdmin(tx, tenantId),
      currentVersion: await this.readSeedVersion(tx, tenantId),
    }));
    if (!admin) {
      /*
       * Not an error: a tenant genuinely may not have an active admin yet
       * during onboarding, and seeding will happen on a later read once one
       * exists.
       *
       * But it MUST be logged. This branch returned silently at first, and that
       * was the wrong call: "no active admin" is the most likely reason seeding
       * does nothing in practice, and it is also the one outcome that leaves no
       * evidence anywhere — no rows, no marker, no log line. Debugging "the
       * starter templates never appeared" then means reading this source to
       * discover the branch exists at all. `warn` rather than `log` because the
       * steady state for a working tenant is that this never fires.
       */
      this.logger.warn(
        `Starter template seeding skipped for tenant ${tenantId}: no ACTIVE tenant_memberships row with role user_admin or capiro_admin. Seeding will retry on the next template-library read.`,
      );
      return { outcome: 'no_admin', created: 0 };
    }

    if (currentVersion !== null && currentVersion >= STARTER_TEMPLATE_SEED_VERSION) {
      return { outcome: 'already_current', created: 0 };
    }

    let created = 0;
    await this.prisma.withTenantUser(tenantId, admin.userId, async (tx) => {
      for (const starter of STARTER_CONTENT_TEMPLATES) {
        created += await this.insertStarter(tx, tenantId, admin.userId, starter);
      }
      await this.writeSeedMarker(tx, tenantId, created);
    });

    this.logger.log(
      `Seeded ${created} starter outreach template(s) for tenant ${tenantId} (seed version ${STARTER_TEMPLATE_SEED_VERSION}).`,
    );
    return { outcome: 'seeded', created };
  }

  /**
   * Lowest-`created_at` ACTIVE admin, so the choice is stable across runs and
   * across replicas rather than depending on row order.
   *
   * `status = 'active'` is not incidental. `tenant_memberships.status` defaults
   * to 'invited', so a tenant can carry an admin membership for someone who has
   * never signed in — and 'removed' rows persist rather than being deleted.
   * Owning a tenant's shared firm templates as an invited-but-never-joined or
   * since-removed user would attach `canEdit`/`canArchive` to an account that
   * cannot or should not exercise them.
   */
  private async findTenantAdmin(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<SeedOwnerRow | null> {
    const rows = await tx.$queryRaw<SeedOwnerRow[]>`
      SELECT user_id AS "userId"
      FROM tenant_memberships
      WHERE tenant_id = CAST(${tenantId} AS uuid)
        AND status = 'active'
        AND role IN ('user_admin', 'capiro_admin')
      ORDER BY created_at ASC, user_id ASC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async readSeedVersion(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<number | null> {
    const rows = await tx.$queryRaw<SeedStateRow[]>`
      SELECT seed_version AS "seedVersion"
      FROM outreach_v3_template_seed_state
      WHERE tenant_id = CAST(${tenantId} AS uuid)
    `;
    return rows[0]?.seedVersion ?? null;
  }

  /**
   * Inserts one starter as a PUBLISHED firm template, or does nothing if it is
   * already there.
   *
   * Published immediately, in the same statement pair, because
   * `computeTemplateCapabilities` gates `canUse` on `publishedVersionId` — a
   * starter left as a draft would render in the library with "Publish before
   * use" and no non-admin could publish it (`canPublish` requires `isAdmin` for
   * non-private scopes). A seeded template that nobody can use is worse than no
   * seeded template.
   *
   * Returns 1 if a row was created, 0 if it already existed.
   */
  private async insertStarter(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ownerUserId: string,
    starter: StarterContentTemplate,
  ): Promise<number> {
    const templateId = starterTemplateId(tenantId, starter.key);
    const versionId = starterTemplateVersionId(tenantId, starter.key);
    const spec = starterTemplateSpec(starter);
    const specJson = JSON.stringify(spec);
    const contentHash = hashOutreachTemplateSpecV1(spec);

    // ON CONFLICT DO NOTHING makes a concurrent second run a no-op rather than
    // a unique-violation, which matters because this fires from a GET that any
    // number of tabs can issue at once.
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO outreach_v3_templates (
        id, tenant_id, owner_user_id, client_id, scope, name, description,
        campaign_type, status, current_draft_version_id, published_version_id,
        duplicated_from_template_id, duplicated_from_version_id
      ) VALUES (
        CAST(${templateId} AS uuid), CAST(${tenantId} AS uuid),
        CAST(${ownerUserId} AS uuid), NULL, 'firm',
        ${starter.name}, ${starter.description}, ${starter.workflow},
        'active', NULL, CAST(${versionId} AS uuid), NULL, NULL
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;
    if (inserted.length === 0) return 0;

    await tx.$executeRaw`
      INSERT INTO outreach_v3_template_versions (
        id, tenant_id, template_id, version_number, lifecycle,
        template_spec_jsonb, content_hash, source_session_id,
        source_state_version, created_by_user_id, published_at
      ) VALUES (
        CAST(${versionId} AS uuid), CAST(${tenantId} AS uuid),
        CAST(${templateId} AS uuid), 1, 'published',
        CAST(${specJson} AS jsonb), ${contentHash}, NULL, NULL,
        CAST(${ownerUserId} AS uuid), now()
      )
      ON CONFLICT (id) DO NOTHING
    `;

    // 'create' + 'publish' rather than a 'seed' action: the audit table's
    // action CHECK constraint does not include 'seed', and widening it would be
    // a schema change for no analytical gain. `safeMetadata.starterKey` is what
    // identifies these rows as seeded.
    for (const action of ['create', 'publish'] as const) {
      await tx.$executeRaw`
        INSERT INTO outreach_v3_template_audit_log (
          id, tenant_id, actor_user_id, action, template_id, template_version_id,
          scope, outcome, reason_code, safe_metadata
        ) VALUES (
          CAST(${deterministicUuid(`audit:${action}:${tenantId}:${starter.key}`)} AS uuid),
          CAST(${tenantId} AS uuid), CAST(${ownerUserId} AS uuid),
          ${action}, CAST(${templateId} AS uuid), CAST(${versionId} AS uuid),
          'firm', 'allowed', NULL,
          CAST(${JSON.stringify({
            starterKey: starter.key,
            seedVersion: STARTER_TEMPLATE_SEED_VERSION,
          })} AS jsonb)
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }

    return 1;
  }

  private async writeSeedMarker(
    tx: Prisma.TransactionClient,
    tenantId: string,
    created: number,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO outreach_v3_template_seed_state (tenant_id, seed_version, created_count)
      VALUES (CAST(${tenantId} AS uuid), ${STARTER_TEMPLATE_SEED_VERSION}, ${created})
      ON CONFLICT (tenant_id) DO UPDATE
        SET seed_version = EXCLUDED.seed_version,
            created_count = EXCLUDED.created_count,
            seeded_at = now()
    `;
  }
}
