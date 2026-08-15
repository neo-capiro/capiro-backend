/**
 * persist-phase6-audit-projections-v1 (Gap 1 closeout) — the first real write
 * path for Phase 6 output, and it is explicitly noncanonical.
 *
 * Before this script existed, `phase6-stage-cycle.ts`'s `verify_full_stage_cycle`
 * and `report_cycle_certification` commands printed a certification to stdout
 * and nothing else — `Phase6AuditProjectionRepository` had a complete,
 * fully-transactional implementation and no caller anywhere in the repository.
 * This closes that gap: it certifies the same input, then persists the
 * certification and its projections to `phase6_audit_projection` /
 * `phase6_cycle_certification` through the main Prisma client, so
 * `PrismaPromotionProjectionSourceV1`'s `committee` family has something to
 * read.
 *
 * Deliberately kept out of `phase6-stage-cycle.ts`: that entrypoint's whole
 * contract is "every command is inspect/replay only", enforced by refusing
 * `--commit`/`--promote` unconditionally. A write path — even an audit-only,
 * explicitly-noncanonical one — does not belong inside a script whose name and
 * safety check both promise it never writes anything.
 *
 *   persist-phase6-audit-projections-v1 --input <cycle-input.json> \
 *     --audit-persistence-authorized
 *
 * Without `--audit-persistence-authorized`, prints the certification (same as
 * `phase6-stage-cycle.ts verify_full_stage_cycle`) and writes nothing —
 * matching `Phase6AuditProjectionRepository.persistAuditOnly`'s own required
 * literal, which this flag exists to supply deliberately rather than by
 * default.
 *
 * No canonical table is ever touched here, by any flag: `canonicalWrites` on
 * both the certification and the persistence receipt is a literal `false`, not
 * a runtime check this command could get wrong.
 *
 * Exit codes: 0 persisted or dry-run printed cleanly, 3 certification rejected
 * (persists nothing), 2 usage, 1 error.
 */
import * as fs from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  certifyPhase6CycleV1,
  phase6CycleCertificationInputV1Schema,
} from '../src/defense-budget/phase6/phase6-cycle-certification-v1.js';
import { Phase6AuditProjectionRepository } from '../src/defense-budget/phase6/phase6-audit-projection-repository.js';
import { PrismaPhase6AuditProjectionTransactionClientV1 } from '../src/defense-budget/phase6/phase6-audit-projection-repository-prisma-v1.js';

dotenvConfig();

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<number> {
  if (process.argv.includes('--commit') || process.argv.includes('--promote')) {
    throw new Error(
      'this command has no canonical commit/promote mode; canonical promotion is Phase 7 Workstream E',
    );
  }

  const inputPath = arg('input');
  if (inputPath == null) throw new Error('--input <cycle-input.json> is required');
  const authorized = flag('audit-persistence-authorized');

  const parsed = phase6CycleCertificationInputV1Schema.parse(
    JSON.parse(fs.readFileSync(inputPath, 'utf8')) as unknown,
  );
  const certification = certifyPhase6CycleV1(parsed);

  if (!authorized) {
    console.log(
      JSON.stringify(
        {
          mode: 'dry_run',
          reason: 'pass --audit-persistence-authorized to persist',
          certification,
        },
        null,
        2,
      ),
    );
    return certification.status === 'CERTIFIED' || certification.status === 'NEEDS_REVIEW' ? 0 : 3;
  }

  const prisma = new PrismaClient();
  try {
    const repository = new Phase6AuditProjectionRepository(
      new PrismaPhase6AuditProjectionTransactionClientV1(prisma),
    );
    const receipt = await repository.persistAuditOnly({
      projections: parsed.projections,
      certification,
      auditPersistenceAuthorized: true,
    });
    console.log(JSON.stringify({ mode: 'persisted', certification, receipt }, null, 2));
    return certification.status === 'CERTIFIED' || certification.status === 'NEEDS_REVIEW' ? 0 : 3;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
