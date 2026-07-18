/**
 * READ-ONLY canary for the shadow Meri auditor — the data needed to decide the
 * MERI_AUDITOR_MODE shadow→enforce flip SAFELY. The 8-check auditor runs in
 * shadow on chat/research/outreach/memo/alert and persists a verdict per turn to
 * meri_audit_ledger WITHOUT blocking anything. This report answers the question
 * the enforce flip hinges on: "if we flipped to enforce, how often would we HOLD
 * (withhold) a real answer, on which surfaces, and for which checks?" — so we can
 * gauge the false-positive exposure before turning teeth on.
 *
 * Under enforce, decision='hold' = the answer is WITHHELD (the false-positive
 * risk); 'repair' = auto-rewritten; 'deliver_with_flags'/'deliver' = shipped. The
 * headline is the HOLD RATE per surface (esp. outreach/research/memo, the first
 * enforce candidates — chat never blocks even under enforce, by design).
 *
 * SAFE: aggregate COUNT/GROUP BY reads only, RLS-bypassed for a cross-tenant view.
 * No writes, no mode change, no output content read (only sizes + check codes).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonSafe = (_k: string, v: any) => (typeof v === 'bigint' ? Number(v) : v);

async function main(): Promise<void> {
  const data = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);

    // 1. Per surface+mode: verdict volume + decision distribution + severity mix.
    const bySurfaceMode = await tx.$queryRawUnsafe(
      `SELECT surface, mode,
         COUNT(*)::int                                               AS total,
         COUNT(*) FILTER (WHERE decision='hold')::int                AS holds,
         COUNT(*) FILTER (WHERE decision='repair')::int              AS repairs,
         COUNT(*) FILTER (WHERE decision='deliver_with_flags')::int  AS flagged,
         COUNT(*) FILTER (WHERE decision='deliver')::int             AS clean,
         COUNT(*) FILTER (WHERE top_severity='critical')::int        AS crit,
         COUNT(*) FILTER (WHERE top_severity='high')::int            AS high,
         ROUND(100.0 * COUNT(*) FILTER (WHERE decision='hold') / NULLIF(COUNT(*),0), 1) AS hold_pct,
         MIN(created_at) AS oldest, MAX(created_at) AS newest
       FROM meri_audit_ledger
       GROUP BY surface, mode
       ORDER BY surface, mode`,
    );

    // 2. For the would-block/would-repair rows, which CHECKS fired (D1..D14) by
    //    surface + severity — tells us WHAT would drive holds (a check that fires
    //    constantly is a false-positive-lexicon suspect).
    const heldChecks = await tx.$queryRawUnsafe(
      `SELECT l.surface,
              f->>'check'    AS check,
              f->>'severity' AS severity,
              COUNT(*)::int  AS n
       FROM meri_audit_ledger l,
            LATERAL jsonb_array_elements(l.findings_jsonb) f
       WHERE l.decision IN ('hold','repair')
       GROUP BY l.surface, f->>'check', f->>'severity'
       ORDER BY n DESC
       LIMIT 40`,
    );

    // 3. A sample of the most recent would-hold turns for human eyeballing
    //    (surface, severity, which checks, output size — NO output content).
    const sampleHolds = await tx.$queryRawUnsafe(
      `SELECT surface, mode, decision, top_severity, finding_count, output_chars, created_at,
              (SELECT string_agg(DISTINCT f->>'check', ',')
                 FROM jsonb_array_elements(findings_jsonb) f) AS checks
       FROM meri_audit_ledger
       WHERE decision = 'hold'
       ORDER BY created_at DESC
       LIMIT 20`,
    );

    // 4. Per-tenant concentration: is enforce+holds fleet-wide or one tenant?
    const perTenant = await tx.$queryRawUnsafe(
      `SELECT tenant_id, mode,
              COUNT(*)::int                                AS total,
              COUNT(*) FILTER (WHERE decision='hold')::int AS holds
       FROM meri_audit_ledger
       GROUP BY tenant_id, mode
       ORDER BY holds DESC, total DESC`,
    );

    // 5. WHY the held turns were held — the auditor's reasoning (detail) + a SHORT
    //    span, so we can tell a real hold (identity/number error) from a
    //    false-positive lexicon fire. NOTE: `span` is a snippet of the HELD (never
    //    delivered) output — kept short; admin-only diagnostic.
    const holdFindings = await tx.$queryRawUnsafe(
      `SELECT l.surface, l.created_at,
              f->>'check'          AS check,
              f->>'severity'       AS severity,
              left(f->>'span', 80) AS span,
              left(f->>'detail', 240) AS detail
       FROM meri_audit_ledger l,
            LATERAL jsonb_array_elements(l.findings_jsonb) f
       WHERE l.decision = 'hold'
         AND l.surface IN ('outreach','research','memo','alert')
       ORDER BY l.created_at DESC
       LIMIT 25`,
    );

    return { bySurfaceMode, heldChecks, sampleHolds, perTenant, holdFindings };
  });

  console.log('AUDITOR_SHADOW ' + JSON.stringify(data, jsonSafe));

  // Human-readable summary: hold-rate per surface (the enforce-flip gate).
  const rows = data.bySurfaceMode as Array<{
    surface: string;
    mode: string;
    total: number;
    holds: number;
    repairs: number;
    flagged: number;
    clean: number;
    hold_pct: number | null;
  }>;
  console.log('\n=== would-BLOCK (hold) rate per surface × mode ===');
  for (const r of rows) {
    console.log(
      `  ${r.surface.padEnd(9)} ${r.mode.padEnd(8)} n=${String(r.total).padStart(6)}  ` +
        `hold=${String(r.holds).padStart(5)} (${r.hold_pct ?? 0}%)  repair=${String(r.repairs).padStart(5)}  ` +
        `flagged=${String(r.flagged).padStart(5)}  clean=${String(r.clean).padStart(5)}`,
    );
  }
  const enforceable = rows.filter((r) => ['outreach', 'research', 'memo'].includes(r.surface));
  const worst = enforceable.reduce((m, r) => Math.max(m, r.hold_pct ?? 0), 0);
  console.log(
    `\nEnforce-candidate surfaces (outreach/research/memo) worst hold-rate: ${worst}% ` +
      `— low (<~5%) + high-severity holds => enforce is likely safe; high => tune the lexicon first.`,
  );
  if (rows.length === 0) console.log('NOTE: meri_audit_ledger is EMPTY — no verdicts persisted yet.');

  console.log('\n=== per-tenant (mode × holds) — is enforce/holds concentrated? ===');
  for (const t of data.perTenant as Array<{
    tenant_id: string;
    mode: string;
    total: number;
    holds: number;
  }>) {
    console.log(`  ${t.tenant_id}  ${t.mode.padEnd(8)}  n=${String(t.total).padStart(5)}  holds=${t.holds}`);
  }

  console.log('\n=== WHY held (outreach/research/memo/alert): check/severity — detail ===');
  for (const h of data.holdFindings as Array<{
    surface: string;
    check: string;
    severity: string;
    detail: string | null;
    span: string | null;
    created_at: string;
  }>) {
    console.log(
      `  [${h.surface}] ${h.check}/${h.severity}: ${h.detail ?? ''}` +
        (h.span ? `  | span="${h.span}"` : ''),
    );
  }
}

main()
  .catch((err) => {
    console.error('AUDITOR_SHADOW ERROR', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
