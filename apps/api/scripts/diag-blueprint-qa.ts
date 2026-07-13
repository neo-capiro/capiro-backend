/**
 * Read-only verification for the Blueprint v2 build (Phases 0–3, G1–G5, P2/P3).
 *
 * Confirms, against LIVE prod data, the backend-observable half of the QA
 * checklist: that scheduled jobs are firing, that the governance/context/outcome
 * machinery has produced real rows under real traffic, and that RLS is actually
 * active AND filtering under the app role. The chat/UI half (memory verbs,
 * held-deliverable flows) needs an authenticated user and is not covered here.
 *
 * SAFE: every statement is a SELECT / read. No INSERT/UPDATE/DELETE/DDL. The
 * role switches (SET LOCAL ROLE capiro_app) are inside interactive transactions
 * and scoped with SET LOCAL / set_config(is_local=true), so they never leak past
 * the tx onto a pooled connection. Exits non-zero on error.
 *
 * Usage (ECS one-off; container name is "api"):
 *   run-task capiro-dev-api-sql-exec  command=["diag-blueprint-qa","capiro-internal"]
 *   (tenant slug optional; defaults to capiro-internal)
 *
 * Output: one `QA_CHECK <id> <json>` line per check, then `QA_DONE`.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// COUNT() etc. come back as bigint over raw SQL; Prisma numerics as Decimal.
const jsonReplacer = (_k: string, v: unknown) => {
  if (typeof v === 'bigint') return Number(v);
  if (v && typeof v === 'object' && 'toNumber' in (v as Record<string, unknown>)) {
    return Number((v as { toNumber(): number }).toNumber());
  }
  return v;
};

function emit(id: string, payload: unknown): void {
  console.log(`QA_CHECK ${id} ` + JSON.stringify(payload, jsonReplacer));
}

async function q<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql, ...params);
}

async function main(): Promise<void> {
  const slug = (process.argv[2] ?? 'capiro-internal').trim();

  // --- resolve tenant ------------------------------------------------------
  const tenantRows = await q<{ id: string; name: string }>(
    `SELECT id, name FROM tenants WHERE slug = $1::citext LIMIT 1`,
    slug,
  );
  if (tenantRows.length === 0) {
    console.error('QA_ERR no tenant for slug ' + slug);
    process.exitCode = 1;
    return;
  }
  // NB: $queryRawUnsafe binds positional params as text, and Postgres will not
  // implicitly coerce uuid = text — every tenant_id/id comparison casts ::uuid.
  const tenantId = tenantRows[0].id;
  emit('TENANT', { slug, tenantId, name: tenantRows[0].name });

  // === P0-2  proactive alerts firing (emit-clio-alerts) ====================
  emit('P0-2', {
    tenantScoped: await q(
      `SELECT source_type, count(*)::int AS n, max(created_at) AS newest
         FROM clio_proactive_alerts
        WHERE tenant_id = $1::uuid AND source_type IN ('meeting_prep','stale_client')
        GROUP BY source_type ORDER BY source_type`,
      tenantId,
    ),
    allTenantsLast48h: await q(
      `SELECT count(*)::int AS n, max(created_at) AS newest
         FROM clio_proactive_alerts
        WHERE source_type IN ('meeting_prep','stale_client')
          AND created_at > now() - interval '48 hours'`,
    ),
  });

  // === P0-3  meeting briefings firing (generate-meeting-briefings) =========
  emit('P0-3', {
    tenantScoped: await q(
      `SELECT count(*)::int AS n, max(created_at) AS newest
         FROM clio_proactive_alerts
        WHERE tenant_id = $1::uuid AND source_type = 'meeting_briefing'`,
      tenantId,
    ),
    allTenantsLast8d: await q(
      `SELECT count(*)::int AS n, max(created_at) AS newest
         FROM clio_proactive_alerts
        WHERE source_type = 'meeting_briefing'
          AND created_at > now() - interval '8 days'`,
    ),
  });

  // === G1-2 / TM contextParity  Context Compiler packets + exclusion trace ==
  emit('G1', {
    total: await q(`SELECT count(*)::int AS n, max(created_at) AS newest FROM context_packet`),
    bySurface: await q(
      `SELECT surface, count(*)::int AS packets,
              sum(item_count)::int AS items, sum(exclusion_count)::int AS exclusions
         FROM context_packet GROUP BY surface ORDER BY packets DESC`,
    ),
    // Distinct exclusion reasons recorded. jsonb_typeof guard: a non-array value
    // would otherwise abort the whole query with "cannot extract elements".
    exclusionReasons: await q(
      `SELECT ex->>'reason' AS reason, count(*)::int AS n
         FROM context_packet cp
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(cp.exclusions_jsonb) = 'array'
                THEN cp.exclusions_jsonb ELSE '[]'::jsonb END) ex
        GROUP BY ex->>'reason' ORDER BY n DESC`,
    ),
  });

  // === G3-3 / TM outcomes  outcome_event telemetry =========================
  emit('G3', {
    byKind: await q(
      `SELECT kind, count(*)::int AS n FROM outcome_event GROUP BY kind ORDER BY n DESC`,
    ),
    bySourceType: await q(
      `SELECT source_type, count(*)::int AS n FROM outcome_event GROUP BY source_type ORDER BY n DESC`,
    ),
    systemMirrored: await q(
      `SELECT count(*)::int AS n, max(observed_at) AS newest
         FROM outcome_event WHERE recorded_by IS NULL`,
    ),
    total: await q(`SELECT count(*)::int AS n, max(observed_at) AS newest FROM outcome_event`),
  });

  // === G4-1  review_request queue (enforce -> hold -> review pipeline) ======
  emit('G4', {
    byStatusTierSurface: await q(
      `SELECT status, risk_tier, surface, count(*)::int AS n
         FROM review_request GROUP BY status, risk_tier, surface
        ORDER BY n DESC`,
    ),
    assignedCount: await q(
      `SELECT count(*)::int AS n FROM review_request WHERE assigned_to IS NOT NULL`,
    ),
    total: await q(`SELECT count(*)::int AS n, max(created_at) AS newest FROM review_request`),
  });

  // === G5-1/2/3  mark-impact action cards ==================================
  emit('G5', {
    byActionType: await q(
      `SELECT action_type, count(*)::int AS n FROM action_recommendation
        GROUP BY action_type ORDER BY n DESC`,
    ),
    addReportLanguage: await q(
      `SELECT count(*)::int AS n FROM action_recommendation WHERE action_type = 'add_report_language'`,
    ),
    // Evidence-kind census across all cards' evidence_jsonb arrays (guarded).
    evidenceKinds: await q(
      `SELECT ev->>'kind' AS kind, count(*)::int AS n
         FROM action_recommendation ar
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(ar.evidence_jsonb) = 'array'
                THEN ar.evidence_jsonb ELSE '[]'::jsonb END) ev
        GROUP BY ev->>'kind' ORDER BY n DESC`,
    ),
    // G5-3: regenerated after creation + a recent-sweep window (26h) so
    // "never ran" vs "ran, nothing changed" vs "all cards newer than last run"
    // are distinguishable instead of one ambiguous zero.
    freshness: await q(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE updated_at > created_at + interval '1 minute')::int AS regenerated,
              count(*) FILTER (WHERE updated_at > now() - interval '26 hours')::int AS "touchedLast26h",
              max(created_at) AS "newestCreated", max(updated_at) AS "newestUpdated"
         FROM action_recommendation`,
    ),
  });

  // === TM auditor / enforce evidence  meri_audit_ledger ====================
  emit('TM-auditor', {
    bySurface: await q(
      `SELECT surface, count(*)::int AS n FROM meri_audit_ledger GROUP BY surface ORDER BY n DESC`,
    ),
    byDecision: await q(
      `SELECT decision, count(*)::int AS n FROM meri_audit_ledger GROUP BY decision ORDER BY n DESC`,
    ),
    byMode: await q(
      `SELECT mode, count(*)::int AS n FROM meri_audit_ledger GROUP BY mode ORDER BY n DESC`,
    ),
    bySeverity: await q(
      `SELECT top_severity, count(*)::int AS n FROM meri_audit_ledger GROUP BY top_severity ORDER BY n DESC`,
    ),
    holds: await q(`SELECT count(*)::int AS n FROM meri_audit_ledger WHERE decision = 'hold'`),
  });

  // === P1-6/7/8 + WS-3  memory_candidate lifecycle =========================
  emit('memory-candidate', {
    byStatus: await q(
      `SELECT status, count(*)::int AS n FROM memory_candidate GROUP BY status ORDER BY n DESC`,
    ),
    byScope: await q(
      `SELECT scope, count(*)::int AS n FROM memory_candidate GROUP BY scope ORDER BY n DESC`,
    ),
    bySourceKind: await q(
      `SELECT source_kind, count(*)::int AS n FROM memory_candidate GROUP BY source_kind ORDER BY n DESC`,
    ),
    medianDecisionMinutes: await q(
      `SELECT round(percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (decided_at - created_at))/60)::numeric, 1)::float8 AS "medianMin"
         FROM memory_candidate WHERE decided_at IS NOT NULL`,
    ),
  });

  // === G2-3 (data-loss regression) + RD-1 (review-due) memory governance ===
  emit('memory-governance', {
    memoryItems: await q(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE client_id IS NOT NULL)::int AS "clientScoped",
              count(*) FILTER (WHERE expires_at IS NOT NULL)::int AS "ephemeral",
              count(*) FILTER (WHERE visibility = 'user')::int AS "userPrivate",
              count(*) FILTER (WHERE review_cadence_days IS NOT NULL AND review_cadence_days > 0)::int AS "withCadence",
              count(*) FILTER (WHERE status = 'active')::int AS "active"
         FROM memory_items WHERE tenant_id = $1::uuid`,
      tenantId,
    ),
    // Faithful mirror of MemoryStoreService.listReviewDue predicate.
    reviewDue: await q(
      `SELECT count(*)::int AS n FROM memory_items
        WHERE tenant_id = $1::uuid
          AND review_cadence_days IS NOT NULL AND review_cadence_days > 0
          AND COALESCE(last_confirmed_at, created_at) + (review_cadence_days * interval '1 day') < now()
          AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())`,
      tenantId,
    ),
    clioMemory: await q(
      `SELECT scope, count(*)::int AS n,
              count(*) FILTER (WHERE client_id IS NOT NULL)::int AS "withClient",
              count(*) FILTER (WHERE expires_at IS NOT NULL)::int AS "ephemeral"
         FROM clio_memory WHERE tenant_id = $1::uuid GROUP BY scope ORDER BY scope`,
      tenantId,
    ),
    // G2-3: ROW-LEVEL regression detector. The #453 bug nulled client_id /
    // expires_at on the projected memory_items row during the nightly sweep.
    // Projection key: memory_items(type='note', slug='clio:'||clio_memory.id).
    // Anti-join expects 0 dropped on each field. "exercised" is the denominator
    // so a vacuous 0 (no client/ephemeral clio rows yet) is distinguishable.
    g2_3_regression: await q(
      `SELECT
         (SELECT count(*)::int FROM clio_memory
            WHERE tenant_id = $1::uuid AND scope = 'client' AND client_id IS NOT NULL) AS "clientExercised",
         (SELECT count(*)::int FROM clio_memory cm
            JOIN memory_items mi
              ON mi.tenant_id = cm.tenant_id AND mi.type = 'note'
             AND mi.slug = 'clio:' || cm.id::text
           WHERE cm.tenant_id = $1::uuid AND cm.scope = 'client' AND cm.client_id IS NOT NULL
             AND mi.client_id IS NULL) AS "clientDropped",
         (SELECT count(*)::int FROM clio_memory
            WHERE tenant_id = $1::uuid AND expires_at IS NOT NULL) AS "ephemeralExercised",
         (SELECT count(*)::int FROM clio_memory cm
            JOIN memory_items mi
              ON mi.tenant_id = cm.tenant_id AND mi.type = 'note'
             AND mi.slug = 'clio:' || cm.id::text
           WHERE cm.tenant_id = $1::uuid AND cm.expires_at IS NOT NULL
             AND mi.expires_at IS NULL) AS "ephemeralDropped"`,
      tenantId,
    ),
  });

  // === P1-9 / G7  RLS is ACTIVE + FILTERING under the app role =============
  // pg_policies + baselines read as master (RLS-transparent).
  emit('rls-policies', {
    memoryItems: await q(
      `SELECT policyname, cmd, qual FROM pg_policies
        WHERE tablename = 'memory_items' ORDER BY policyname`,
    ),
    tablesWithPolicies: await q(
      `SELECT tablename, count(*)::int AS policies FROM pg_policies
        WHERE tablename IN ('memory_items','clio_memory','context_packet','review_request','outcome_event','meri_audit_ledger','memory_candidate')
        GROUP BY tablename ORDER BY tablename`,
    ),
  });

  const baseline = await q<{
    all: number; priv: number; expired: number; probeId: string | null; probeOwner: string | null;
  }>(
    `SELECT
       (SELECT count(*)::int FROM memory_items WHERE tenant_id = $1::uuid) AS all,
       (SELECT count(*)::int FROM memory_items WHERE tenant_id = $1::uuid AND visibility = 'user') AS priv,
       (SELECT count(*)::int FROM memory_items
          WHERE tenant_id = $1::uuid AND expires_at IS NOT NULL AND expires_at <= now()) AS expired,
       (SELECT id::text FROM memory_items
          WHERE tenant_id = $1::uuid AND visibility = 'user' AND owner_user_id IS NOT NULL
            AND (expires_at IS NULL OR expires_at > now())
          ORDER BY created_at LIMIT 1) AS "probeId",
       (SELECT owner_user_id::text FROM memory_items
          WHERE tenant_id = $1::uuid AND visibility = 'user' AND owner_user_id IS NOT NULL
            AND (expires_at IS NULL OR expires_at > now())
          ORDER BY created_at LIMIT 1) AS "probeOwner"`,
    tenantId,
  );
  const base = baseline[0];

  // All-tenant totals (master) for the tenant-isolation discriminator.
  const global = await q<{ allTenants: number; tenants: number }>(
    `SELECT count(*)::int AS "allTenants",
            count(DISTINCT tenant_id)::int AS "tenants"
       FROM memory_items`,
  );

  const NONEXISTENT = '00000000-0000-0000-0000-000000000000';

  // App-role, impersonating a NON-owner. Proves: RLS active; tenant isolation
  // (no-predicate count == this tenant only); private row hidden from non-owner.
  const asNonOwner = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE capiro_app`);
    await tx.$queryRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, tenantId);
    await tx.$queryRawUnsafe(`SELECT set_config('app.current_user', $1, true)`, NONEXISTENT);
    await tx.$queryRawUnsafe(`SELECT set_config('app.bypass_rls', 'off', true)`);
    const rsa = await tx.$queryRawUnsafe<{ active: boolean }[]>(
      `SELECT row_security_active('memory_items') AS active`,
    );
    const scoped = await tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM memory_items WHERE tenant_id = $1::uuid`,
      tenantId,
    );
    const noPredicate = await tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM memory_items`,
    );
    const probe = base.probeId
      ? await tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM memory_items WHERE id = $1::uuid`,
          base.probeId,
        )
      : [{ n: -1 }];
    // RLS-active for all seven policy-bearing tables (not just memory_items).
    const rlsActiveAll = await tx.$queryRawUnsafe<{ tbl: string; active: boolean }[]>(
      `SELECT tbl, row_security_active(tbl::regclass) AS active FROM (VALUES
         ('memory_items'),('clio_memory'),('context_packet'),('review_request'),
         ('outcome_event'),('meri_audit_ledger'),('memory_candidate')) v(tbl)`,
    );
    return {
      rowSecurityActive: rsa[0]?.active,
      visibleTenantScoped: scoped[0]?.n,
      visibleNoTenantPredicate: noPredicate[0]?.n,
      probeRowVisible: probe[0]?.n,
      rlsActiveByTable: rlsActiveAll,
    };
  });

  // App-role as the ACTUAL owner of the probe row — positive control.
  const asOwner = base.probeOwner
    ? await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE capiro_app`);
        await tx.$queryRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, tenantId);
        await tx.$queryRawUnsafe(`SELECT set_config('app.current_user', $1, true)`, base.probeOwner);
        await tx.$queryRawUnsafe(`SELECT set_config('app.bypass_rls', 'off', true)`);
        const probe = await tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM memory_items WHERE id = $1::uuid`,
          base.probeId,
        );
        return { probeRowVisible: probe[0]?.n };
      })
    : { probeRowVisible: -1 };

  emit('rls-canary', {
    asMaster: { all: base.all, priv: base.priv, expired: base.expired },
    global: global[0],
    probe: { exists: !!base.probeId, id: base.probeId, ownerUserId: base.probeOwner },
    asAppRoleNonOwner: asNonOwner,
    asAppRoleOwner: asOwner,
    // Which assertions are load-bearing here (else the check is vacuous):
    discriminating: {
      userPrivateFilter: base.priv > 0 || base.expired > 0,
      tenantIsolation: (global[0]?.tenants ?? 0) > 1 && (global[0]?.allTenants ?? 0) > base.all,
      positiveControl: !!base.probeId,
    },
    // Pre-computed verdicts so a reader can't accidentally PASS a vacuous case.
    verdicts: {
      rlsActive: asNonOwner.rowSecurityActive === true,
      tenantIsolationHeld:
        (global[0]?.tenants ?? 0) > 1 && (global[0]?.allTenants ?? 0) > base.all
          ? asNonOwner.visibleNoTenantPredicate === asNonOwner.visibleTenantScoped
          : null,
      privateRowHiddenFromNonOwner: base.probeId ? asNonOwner.probeRowVisible === 0 : null,
      privateRowVisibleToOwner: base.probeId ? asOwner.probeRowVisible === 1 : null,
    },
  });

  console.log('QA_DONE');
}

main()
  .catch((err) => {
    console.error('QA_ERR', err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
