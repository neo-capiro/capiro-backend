import { execFileSync } from 'node:child_process';
import type {
  AssuranceEvalResult,
  EvalProvenance,
  ReleaseGateReport,
  ReleaseGateThresholds,
} from '../../src/assurance';

/**
 * Persistence adapter for an evaluation run.
 *
 * WHY IT IS A NO-OP BY DEFAULT. This runner is the CI release gate and MUST keep
 * working with no database — that is how it runs today, on every PR, in a job with
 * no Aurora reachability. So the adapter writes only when a DATABASE_URL is
 * present, and a write failure NEVER changes the exit code: the gate's verdict is
 * decided by `evaluateReleaseGate`, and losing the audit row must not turn a real
 * regression green (nor a clean run red).
 *
 * The SQL is deliberately written here rather than through Prisma: this file runs
 * under tsx in a package that has no Prisma client, and importing apps/api's
 * client into packages/meriv2-core would invert the dependency direction. The
 * tables are the ones created by
 * apps/api/prisma/migrations/20260811020000_assurance_eval_runs.
 *
 * NOT VERIFIED AGAINST A DATABASE. There is no database in this checkout, so the
 * statements below are unexercised. They are written to be idempotent
 * (ON CONFLICT on the provenance hash) precisely because a first live run is the
 * first time anyone will find out.
 */

export interface EvalRunRecord {
  provenance: EvalProvenance;
  thresholds: ReleaseGateThresholds;
  report: ReleaseGateReport;
  results: readonly AssuranceEvalResult[];
}

export interface PersistOutcome {
  written: boolean;
  reason: string;
}

function quote(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function json(value: unknown): string {
  return `${quote(JSON.stringify(value ?? null))}::jsonb`;
}

export function buildEvalRunSql(record: EvalRunRecord, tenantId: string): string {
  const { provenance: p, report, thresholds, results } = record;
  const statements: string[] = [
    // Every table is RLS FORCED, so the tenant context must be set for the
    // INSERTs to be visible to the policy at all.
    `SELECT set_config('app.current_tenant', ${quote(tenantId)}, true);`,
    `INSERT INTO assurance_eval_run (
       tenant_id, git_sha, prompt_version, context_compiler_version, tool_manifest_hash,
       model, provider, dataset_version, run_date, provenance_hash, thresholds_jsonb,
       allowed, blockers_jsonb, warnings_jsonb
     ) VALUES (
       ${quote(tenantId)}, ${quote(p.gitSha)}, ${quote(p.promptVersion)},
       ${quote(p.contextCompilerVersion)}, ${quote(p.toolManifestHash)}, ${quote(p.model)},
       ${quote(p.provider)}, ${quote(p.datasetVersion)}, ${quote(p.date)}::timestamptz,
       ${quote(report.provenanceHash)}, ${json(thresholds)}, ${quote(report.allowed)},
       ${json(report.blockers)}, ${json(report.warnings)}
     )
     ON CONFLICT (tenant_id, provenance_hash) DO UPDATE SET
       allowed = EXCLUDED.allowed,
       blockers_jsonb = EXCLUDED.blockers_jsonb,
       warnings_jsonb = EXCLUDED.warnings_jsonb;`,
  ];
  for (const result of results) {
    statements.push(
      `INSERT INTO assurance_eval_result (
         tenant_id, eval_run_id, case_id, tier, domain, severity, passed, score, threshold,
         metric, detail
       )
       SELECT ${quote(tenantId)}, r.id, ${quote(result.id)}, ${quote(result.tier)},
              ${quote(result.domain)}, ${quote(result.severity)}, ${quote(result.passed)},
              ${quote(result.score ?? null)}, ${quote(result.threshold ?? null)},
              ${quote(result.metric ?? null)}, ${quote(result.detail)}
         FROM assurance_eval_run r
        WHERE r.tenant_id = ${quote(tenantId)}
          AND r.provenance_hash = ${quote(report.provenanceHash)}
       ON CONFLICT (eval_run_id, case_id) DO UPDATE SET
         passed = EXCLUDED.passed, detail = EXCLUDED.detail;`,
    );
  }
  for (const domain of report.domains) {
    statements.push(
      `INSERT INTO assurance_eval_domain_gate (
         tenant_id, eval_run_id, domain, passed, failed, critical_failed, high_failed,
         minimum_score, blocked, blocker_reasons_jsonb
       )
       SELECT ${quote(tenantId)}, r.id, ${quote(domain.domain)}, ${quote(domain.passed)},
              ${quote(domain.failed)}, ${quote(domain.criticalFailed)},
              ${quote(domain.highFailed)}, ${quote(domain.minimumScore ?? null)},
              ${quote(domain.criticalFailed > 0)},
              ${json(report.blockers.filter((blocker) => blocker.includes(domain.domain)))}
         FROM assurance_eval_run r
        WHERE r.tenant_id = ${quote(tenantId)}
          AND r.provenance_hash = ${quote(report.provenanceHash)}
       ON CONFLICT (eval_run_id, domain) DO UPDATE SET
         passed = EXCLUDED.passed, failed = EXCLUDED.failed,
         critical_failed = EXCLUDED.critical_failed, high_failed = EXCLUDED.high_failed,
         blocked = EXCLUDED.blocked;`,
    );
  }
  return statements.join('\n');
}

/**
 * Write the run if — and only if — a database is configured AND a tenant is named.
 * Both are required: an eval run recorded against the wrong tenant is worse than
 * an unrecorded one, so there is no default tenant.
 */
export function persistEvalRun(record: EvalRunRecord): PersistOutcome {
  const databaseUrl = process.env.DATABASE_URL;
  const tenantId = process.env.ASSURANCE_EVAL_TENANT_ID;
  if (!databaseUrl) return { written: false, reason: 'no DATABASE_URL — audit row skipped' };
  if (!tenantId) {
    return { written: false, reason: 'no ASSURANCE_EVAL_TENANT_ID — audit row skipped' };
  }
  try {
    execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], {
      input: buildEvalRunSql(record, tenantId),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    return { written: true, reason: 'persisted' };
  } catch (error) {
    // Never fail the gate on an audit-write problem. The verdict is already decided.
    return {
      written: false,
      reason: `audit write failed (non-fatal): ${
        error instanceof Error ? error.message.slice(0, 200) : String(error)
      }`,
    };
  }
}
