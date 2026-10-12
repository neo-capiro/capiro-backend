/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * Read-only CLIENT-RESOLUTION BLAST-RADIUS report (Phase A step 0).
 *
 * Answers, BEFORE anyone runs sync-entity-resolution / prepopulateAllForTenant
 * against prod: for each EXISTING client, what does the registrant-anchored
 * resolution WOULD produce, and how would clients.lda_client_ids change?
 *
 * For every active tenant it reports:
 *   - tenant.lda_registrant_id (the firm anchor). If NULL, resolution falls back
 *     to GLOBAL fuzzy matching — flagged loudly, because that is the low-quality
 *     path the overhaul exists to replace.
 *   - per client: current confirmed LDA mappings + current clients.lda_client_ids,
 *     the registrant-anchored candidate count, the projected auto-confirm set
 *     (multi-token fingerprint-exact within the firm's own filings), and the
 *     PROJECTED lda_client_ids = union(current confirmed, projected auto-confirm).
 *   - whether the projection would ADD ids the client does not yet carry (the
 *     real blast radius: how many net-new associations a backfill would create).
 *
 * SAFE: SELECT-only. No writes, no upserts. Mirrors EntityResolutionService's
 * registrant-anchored SQL (matchLdaByRegistrant) + the fingerprint-exact /
 * multi-token auto-confirm rule from scoreCandidate, reimplemented in pure SQL so
 * it can run standalone (a raw PrismaClient diag cannot DI the Nest service).
 *
 * RLS: clients / client_intel_mapping / tenants are FORCED-RLS. A raw PrismaClient
 * sees ZERO rows unless app.bypass_rls is set, so every read of those tables runs
 * inside a transaction that sets set_config('app.bypass_rls','on',true) — the same
 * trusted cross-tenant admin path PrismaService.withSystem uses. lda_filing /
 * lda_client are tenant-agnostic (no RLS) and read directly.
 *
 * Run as a one-off ECS task (read-only):
 *   aws ecs run-task ... --overrides '{"containerOverrides":[{"name":"api","command":["diag-client-resolution"]}]}'
 *   # optional single-tenant focus: ["diag-client-resolution","--tenant","<uuid>"]
 *   # optional per-tenant client sample cap (default 40): ["diag-client-resolution","--limit","100"]
 */
import { PrismaClient } from '@prisma/client';
import { parseArgs } from 'node:util';

const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v);

/**
 * Pure-SQL fingerprint mirroring EntityResolutionService.fingerprint():
 * lowercase, strip legal suffixes (word-boundary), strip non-alphanumerics to
 * spaces, collapse whitespace, trim. NO backslashes — survives ECS/shell quoting.
 * The suffix list matches SUFFIX_RE in entity-resolution.service.ts.
 */
function fpExpr(col: string): string {
  return `trim(regexp_replace(
    regexp_replace(
      regexp_replace(lower(${col}), '[^a-z0-9 ]', ' ', 'g'),
      ' (inc|llc|corp|ltd|co|lp|llp|pa|pc|pllc|group|holdings|international|associates|partners|consulting|services|solutions|technologies|enterprises)( |$)',
      ' ', 'g'),
    ' +', ' ', 'g'))`;
}

/** Run fn inside an RLS-bypass transaction (trusted cross-tenant admin read). */
async function withBypass<T>(prisma: PrismaClient, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx as unknown as PrismaClient);
  });
}

interface TenantRow {
  id: string;
  slug: string | null;
  lda_registrant_id: number | null;
  lda_registrant_name: string | null;
}

interface ClientRow {
  id: string;
  name: string;
  lda_client_ids: number[] | null;
}

interface ClientReport {
  clientId: string;
  name: string;
  currentLdaClientIds: number[];
  currentConfirmedMappingIds: number[];
  anchoredCandidateCount: number;
  anchoredUsable: boolean;
  projectedAutoConfirmIds: number[];
  projectedLdaClientIds: number[];
  netNewIds: number[];
}

async function main(): Promise<void> {
  const usage = 'Usage: apps/api/scripts/diag-client-resolution.ts [--tenant UUID] [--limit N] requires DATABASE_URL (database configuration is required)';
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log(usage);
    process.exit(0);
  }
  let args: { tenant?: string; limit?: string };
  try {
    args = parseArgs({
      options: {
        tenant: { type: 'string' },
        limit: { type: 'string' },
      },
    }).values;
  } catch {
    console.error(usage);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error(usage);
    process.exit(2);
  }

  const CLIENT_SAMPLE_LIMIT = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0
    ? Math.floor(Number(args.limit))
    : 40;

  const prisma = new PrismaClient();
  try {
    const out: Record<string, unknown> = { generatedAt: new Date().toISOString() };

    // Active tenants (RLS-bypassed). Optional single-tenant focus.
    const tenants = await withBypass(prisma, (tx) =>
      tx.$queryRawUnsafe<TenantRow[]>(
        args.tenant
          ? `SELECT id, slug, lda_registrant_id, lda_registrant_name
             FROM tenants WHERE id = '${args.tenant}'`
          : `SELECT id, slug, lda_registrant_id, lda_registrant_name
             FROM tenants WHERE status = 'active' ORDER BY slug`,
      ),
    );

    const tenantReports: Array<Record<string, unknown>> = [];
    let totalClients = 0;
    let totalNetNewAssociations = 0;
    let tenantsMissingRegistrant = 0;

    for (const tenant of tenants) {
      const hasRegistrant = tenant.lda_registrant_id != null;
      if (!hasRegistrant) tenantsMissingRegistrant++;

      // Clients for this tenant (RLS-bypassed; filter by tenant_id explicitly).
      const clients = await withBypass(prisma, (tx) =>
        tx.$queryRawUnsafe<ClientRow[]>(
          `SELECT id, name, lda_client_ids
           FROM clients WHERE tenant_id = '${tenant.id}'
           ORDER BY name LIMIT ${CLIENT_SAMPLE_LIMIT}`,
        ),
      );

      const clientReports: ClientReport[] = [];
      let tenantNetNew = 0;

      for (const client of clients) {
        const safeName = client.name.replace(/'/g, "''");

        // Current confirmed LDA mapping external_ids (RLS-bypassed read).
        const confirmedRows = await withBypass(prisma, (tx) =>
          tx.$queryRawUnsafe<Array<{ external_id: string }>>(
            `SELECT external_id FROM client_intel_mapping
             WHERE client_id = '${client.id}' AND source = 'lda' AND confirmed = true`,
          ),
        );
        const currentConfirmedMappingIds = Array.from(
          new Set(
            confirmedRows
              .map((r) => Number(r.external_id))
              .filter((n) => Number.isInteger(n)),
          ),
        );
        const currentLdaClientIds = Array.from(
          new Set((client.lda_client_ids ?? []).map(Number).filter((n) => Number.isInteger(n))),
        );

        // Registrant-anchored candidate projection. Mirrors matchLdaByRegistrant:
        // DISTINCT client_id within THIS firm's filings, scored by name similarity.
        // We additionally compute the multi-token fingerprint-exact flag that
        // scoreCandidate uses to promote a candidate to auto-confirm (>=0.95).
        let anchoredCandidateCount = 0;
        let anchoredUsable = false;
        let projectedAutoConfirmIds: number[] = [];

        if (hasRegistrant) {
          const candidates = await prisma.$queryRawUnsafe<
            Array<{
              client_id: number;
              sim: number;
              fp_exact: boolean;
              fp_multi_token: boolean;
            }>
          >(
            `SELECT client_id,
                  max(sim) AS sim,
                  bool_or(fp_exact) AS fp_exact,
                  bool_or(fp_multi_token) AS fp_multi_token
             FROM (
               SELECT client_id,
                      similarity(client_name, '${safeName}') AS sim,
                      (${fpExpr('client_name')} = ${fpExpr(`'${safeName}'`)}) AS fp_exact,
                      (position(' ' in ${fpExpr(`'${safeName}'`)}) > 0) AS fp_multi_token
                 FROM lda_filing
                WHERE registrant_id = ${tenant.lda_registrant_id}
                  AND client_id IS NOT NULL
                  AND client_name <> ''
             ) s
            GROUP BY client_id`,
          );
          anchoredCandidateCount = candidates.length;
          // Usability gate mirrors ldaCandidates(): anchored pool is used when any
          // candidate is fingerprint-exact OR has similarity >= 0.4.
          anchoredUsable = candidates.some((c) => c.fp_exact || Number(c.sim) >= 0.4);
          // Auto-confirm projection: multi-token fingerprint-exact within the firm's
          // own pool (scoreCandidate -> 0.95 when anchored). Single-token exacts and
          // sub-threshold fuzzies are review-only, so they are NOT auto-added here.
          if (anchoredUsable) {
            projectedAutoConfirmIds = candidates
              .filter((c) => c.fp_exact && c.fp_multi_token)
              .map((c) => Number(c.client_id))
              .filter((n) => Number.isInteger(n));
          }
        }

        // Projected lda_client_ids = union(current confirmed, projected auto-confirm).
        // (prepopulateAllForTenant recomputes lda_client_ids from confirmed mappings,
        // and resolution would auto-confirm the projected set.)
        const projectedSet = new Set<number>([
          ...currentConfirmedMappingIds,
          ...projectedAutoConfirmIds,
        ]);
        const projectedLdaClientIds = Array.from(projectedSet).sort((a, b) => a - b);
        const currentSet = new Set(currentConfirmedMappingIds);
        const netNewIds = projectedLdaClientIds.filter((id) => !currentSet.has(id));
        tenantNetNew += netNewIds.length;

        clientReports.push({
          clientId: client.id,
          name: client.name,
          currentLdaClientIds,
          currentConfirmedMappingIds,
          anchoredCandidateCount,
          anchoredUsable,
          projectedAutoConfirmIds,
          projectedLdaClientIds,
          netNewIds,
        });
      }

      totalClients += clients.length;
      totalNetNewAssociations += tenantNetNew;

      tenantReports.push({
        tenantId: tenant.id,
        slug: tenant.slug,
        ldaRegistrantId: tenant.lda_registrant_id,
        ldaRegistrantName: tenant.lda_registrant_name,
        hasRegistrantAnchor: hasRegistrant,
        resolutionPath: hasRegistrant ? 'registrant-anchored' : 'GLOBAL-FUZZY-FALLBACK',
        clientsSampled: clients.length,
        clientSampleLimit: CLIENT_SAMPLE_LIMIT,
        projectedNetNewAssociations: tenantNetNew,
        clientsWithNetNew: clientReports.filter((c) => c.netNewIds.length > 0).length,
        clients: clientReports,
      });
    }

    out.summary = {
      tenants: tenants.length,
      tenantsMissingRegistrantAnchor: tenantsMissingRegistrant,
      totalClientsSampled: totalClients,
      projectedNetNewAssociations: totalNetNewAssociations,
      note:
        'projectedAutoConfirmIds counts ONLY multi-token fingerprint-exact matches ' +
        'within the firm pool (the auto-confirm path). Fuzzy/single-token candidates ' +
        'would land in the review queue, not auto-add — so real net-new associations ' +
        'after a human review pass will be >= projectedNetNewAssociations.',
    };
    out.tenants = tenantReports;

    console.log(
      'CLIENT_RESOLUTION_BLAST_RADIUS ' +
        JSON.stringify(out, (_k, v) => num(v), 2),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((err) => {
    console.error(
      'CLIENT_RESOLUTION_BLAST_RADIUS_ERR',
      err instanceof Error ? err.message : String(err),
    );
    process.exitCode = 1;
  });
}
