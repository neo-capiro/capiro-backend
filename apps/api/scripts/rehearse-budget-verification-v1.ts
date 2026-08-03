/**
 * R7 — Disposable PostgreSQL rehearsal script.
 *
 * Runs against a disposable PostgreSQL 16 database.
 * Exercises every migration replay, transaction, immutability, and review scenario.
 *
 * Usage:
 *   DATABASE_URL="postgresql://postgres:disposable@localhost:55432/verification_rehearsal" \
 *   pnpm exec tsx scripts/rehearse-budget-verification-v1.ts
 *
 * No AWS, no LlamaParse, no canonical writes, no shared database.
 */
import { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL must be set');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const VALID_SHA = 'a'.repeat(64);
const DIFFERENT_SHA = 'b'.repeat(64);

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS: ${name}`);
    pass++;
  } else {
    console.error(`  FAIL: ${name}`);
    fail++;
  }
}

async function expectThrows(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.error(`  FAIL: ${name} — expected an error but none was thrown`);
    fail++;
  } catch {
    console.log(`  PASS: ${name} — error thrown as expected`);
    pass++;
  }
}

async function main(): Promise<void> {
  console.log('=== R7 PostgreSQL Rehearsal ===');
  console.log(`Database: ${DATABASE_URL}`);

  // 1. Confirm all migrations applied
  console.log('\n--- 1. Migration state ---');
  const migrationCount = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint as count FROM _prisma_migrations WHERE migration_name LIKE '%budget_verification%'
  `;
  check('budget verification migrations applied', Number(migrationCount[0]?.count) >= 3);

  // 2. Confirm V1 tables exist
  console.log('\n--- 2. V1 tables exist ---');
  const v1Tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE tablename LIKE '%_v1' AND tablename LIKE 'budget%'
    ORDER BY tablename
  `;
  const tableNames = v1Tables.map((t) => t.tablename);
  check(
    'budget_extraction_candidate_v1 exists',
    tableNames.includes('budget_extraction_candidate_v1'),
  );
  check('budget_verification_run_v1 exists', tableNames.includes('budget_verification_run_v1'));
  check('budget_verification_check_v1 exists', tableNames.includes('budget_verification_check_v1'));
  check(
    'budget_verification_discrepancy_v1 exists',
    tableNames.includes('budget_verification_discrepancy_v1'),
  );
  check('budget_review_decision_v1 exists', tableNames.includes('budget_review_decision_v1'));

  const proofTables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE tablename = 'budget_verification_proof'
  `;
  check('budget_verification_proof exists', proofTables.length > 0);

  // 3. Insert a source_document (required FK target)
  console.log('\n--- 3. Insert source_document ---');
  const sourceDocId = '00000000-0000-0000-0000-0000000000aa';
  const sourceKey = 'test-r1-fy2027.pdf';
  await prisma.$executeRaw`
    INSERT INTO "source_document" (id, "source_key", "source_url", "fiscal_year", "component", "document_type", "budget_cycle", "title", "extraction_method", "sha256", "ingested_at")
    VALUES (${sourceDocId}::uuid, ${sourceKey}, 'file:///test.pdf', 2027, 'AF', 'R-1', 'PB2026', 'Test R-1 FY2027', 'native_structured', ${VALID_SHA}, now())
    ON CONFLICT (id) DO NOTHING
  `;
  check('source_document inserted', true);

  // 4. Insert candidate/run/check/proof/discrepancy set
  console.log('\n--- 4. Successful candidate/run/proof/check/discrepancy transaction ---');
  const candidateId = '00000000-0000-0000-0000-0000000000b0';
  const runId = '00000000-0000-0000-0000-0000000000b1';
  const checkId = 'vc1_test_check_001';
  const proofId = '00000000-0000-0000-0000-0000000000b2';
  const discrepancyId = 'vd1_test_discrepancy_001';

  // Clean any leftover from prior runs
  await prisma.$executeRaw`DELETE FROM "budget_review_decision_v1" WHERE candidate_id = ${candidateId}::uuid`;
  await prisma.$executeRaw`DELETE FROM "budget_verification_discrepancy_v1" WHERE run_id = ${runId}::uuid`;
  await prisma.$executeRaw`DELETE FROM "budget_verification_proof" WHERE run_id = ${runId}::uuid`;
  await prisma.$executeRaw`DELETE FROM "budget_verification_check_v1" WHERE run_id = ${runId}::uuid`;
  await prisma.$executeRaw`DELETE FROM "budget_verification_run_v1" WHERE id = ${runId}::uuid`;
  await prisma.$executeRaw`DELETE FROM "budget_extraction_candidate_v1" WHERE id = ${candidateId}::uuid`;

  // Delete will fail due to RESTRICT FKs — but the delete trigger only blocks UPDATE, not DELETE.
  // We need to clean in the right order. Use raw SQL with CASCADE disable.
  // Actually the triggers only prevent UPDATE, not DELETE. So we can delete in FK order.

  try {
    await prisma.$transaction([
      prisma.$executeRaw`
        INSERT INTO "budget_extraction_candidate_v1"
        ("id", "cycle_id", "manifest_content_sha256", "manifest_document_key",
         "extraction_artifact_id", "extraction_artifact_sha256", "extraction_artifact_locator",
         "source_document_id", "source_sha256", "verifier_version", "policy_version", "policy_sha256",
         "status", "current_run_id", "created_at", "updated_at")
        VALUES (${candidateId}::uuid, 'fy2027', ${VALID_SHA}, 'r1_fy2027',
         'art-1', ${VALID_SHA}, '/test/art.json',
         ${sourceDocId}::uuid, ${VALID_SHA}, 'defense_budget_verifier_v1', 'defense_budget_verification_policy_v1', ${VALID_SHA},
         'NEEDS_REVIEW', ${runId}::uuid, now(), now())
      `,
      prisma.$executeRaw`
        INSERT INTO "budget_verification_run_v1"
        ("id", "candidate_id", "verifier_version", "policy_version", "policy_sha256",
         "decision", "status", "route", "risk_score", "started_at", "completed_at",
         "manifest_content_sha256", "extraction_artifact_sha256", "source_sha256", "result_snapshot_jsonb", "created_at")
        VALUES (${runId}::uuid, ${candidateId}::uuid, 'defense_budget_verifier_v1', 'defense_budget_verification_policy_v1', ${VALID_SHA},
         'REVIEW', 'NEEDS_REVIEW', 'human_review', 50, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z',
         ${VALID_SHA}, ${VALID_SHA}, ${VALID_SHA}, '{}', now())
      `,
      prisma.$executeRaw`
        INSERT INTO "budget_verification_check_v1"
        ("check_id", "run_id", "code", "rule_version", "outcome", "required", "blocking", "risk_points", "message",
         "assertion_ids_jsonb", "evidence_ids_jsonb", "reference_artifact_ids_jsonb", "passed", "created_at")
        VALUES (${checkId}, ${runId}::uuid, 'test_check', 'defense_budget_verification_rule_v1', 'PASS', true, false, 0, 'test',
         '[]', '[]', '[]', true, now())
      `,
      prisma.$executeRaw`
        INSERT INTO "budget_verification_proof"
        ("id", "run_id", "proof_kind", "status", "source_document_id", "artifact_id", "reference_artifact_id",
         "evidence_jsonb", "created_at")
        VALUES (${proofId}::uuid, ${runId}::uuid, 'manifest', 'verified', NULL, 'art-1', NULL,
         '{}', now())
      `,
      prisma.$executeRaw`
        INSERT INTO "budget_verification_discrepancy_v1"
        ("discrepancy_id", "run_id", "candidate_id", "code", "severity", "description",
         "assertion_ids_jsonb", "evidence_ids_jsonb", "reference_artifact_ids_jsonb", "created_at")
        VALUES (${discrepancyId}, ${runId}::uuid, ${candidateId}::uuid, 'test_discrepancy', 'review', 'test',
         '[]', '[]', '[]', now())
      `,
    ]);
    check('full transaction committed', true);
  } catch (err) {
    check('full transaction committed', false);
    console.error('  Error:', err);
    // If the transaction failed, we need to insert individually for subsequent tests
  }

  // 5. Idempotent replay — inserting same candidate identity should conflict
  console.log('\n--- 5. Idempotent replay (unique constraint) ---');
  await expectThrows('duplicate candidate identity rejected', async () => {
    await prisma.$executeRaw`
      INSERT INTO "budget_extraction_candidate_v1"
      ("id", "cycle_id", "manifest_content_sha256", "manifest_document_key",
       "extraction_artifact_id", "extraction_artifact_sha256", "extraction_artifact_locator",
       "source_document_id", "source_sha256", "verifier_version", "policy_version", "policy_sha256",
       "status", "created_at", "updated_at")
      VALUES ('00000000-0000-0000-0000-0000000000ee'::uuid, 'fy2027', ${VALID_SHA}, 'r1_fy2027',
       'art-1', ${VALID_SHA}, '/test/art.json',
       ${sourceDocId}::uuid, ${VALID_SHA}, 'defense_budget_verifier_v1', 'defense_budget_verification_policy_v1', ${VALID_SHA},
       'EXTRACTED', now(), now())
    `;
  });

  // 6. Invalid status value
  console.log('\n--- 6. Invalid status value ---');
  await expectThrows('CANONICAL status rejected', async () => {
    await prisma.$executeRaw`
      INSERT INTO "budget_extraction_candidate_v1"
      ("id", "cycle_id", "manifest_content_sha256", "manifest_document_key",
       "extraction_artifact_id", "extraction_artifact_sha256", "extraction_artifact_locator",
       "source_document_id", "source_sha256", "verifier_version", "policy_version", "policy_sha256",
       "status", "created_at", "updated_at")
      VALUES ('00000000-0000-0000-0000-0000000000ff'::uuid, 'fy2027', ${VALID_SHA}, 'r1_other',
       'art-2', ${VALID_SHA}, '/test/art2.json',
       ${sourceDocId}::uuid, ${VALID_SHA}, 'defense_budget_verifier_v1', 'defense_budget_verification_policy_v1', ${VALID_SHA},
       'CANONICAL', now(), now())
    `;
  });

  // 7. Invalid check outcome
  console.log('\n--- 7. Invalid check outcome ---');
  await expectThrows('invalid check outcome rejected', async () => {
    await prisma.$executeRaw`
      INSERT INTO "budget_verification_check_v1"
      ("check_id", "run_id", "code", "rule_version", "outcome", "required", "blocking", "risk_points", "message",
       "assertion_ids_jsonb", "evidence_ids_jsonb", "reference_artifact_ids_jsonb", "passed", "created_at")
      VALUES ('vc1_bad_outcome', ${runId}::uuid, 'test', 'v1', 'INVALID', true, false, 0, 'test',
       '[]', '[]', '[]', false, now())
    `;
  });

  // 8. Mismatched candidate/run discrepancy
  console.log('\n--- 8. Mismatched candidate/run discrepancy ---');
  const otherCandidateId = '00000000-0000-0000-0000-000000000099';
  await expectThrows('mismatched discrepancy candidate/run rejected', async () => {
    await prisma.$executeRaw`
      INSERT INTO "budget_verification_discrepancy_v1"
      ("discrepancy_id", "run_id", "candidate_id", "code", "severity", "description",
       "assertion_ids_jsonb", "evidence_ids_jsonb", "reference_artifact_ids_jsonb", "created_at")
      VALUES ('vd1_mismatch', ${runId}::uuid, ${otherCandidateId}::uuid, 'test', 'review', 'mismatch',
       '[]', '[]', '[]', now())
    `;
  });

  // 9. Mismatched candidate/run review
  console.log('\n--- 9. Mismatched candidate/run review ---');
  await expectThrows('mismatched review candidate/run rejected', async () => {
    await prisma.$executeRaw`
      INSERT INTO "budget_review_decision_v1"
      ("id", "candidate_id", "run_id", "reviewer_id", "decision", "notes",
       "source_sha256", "extraction_artifact_sha256", "manifest_content_sha256",
       "evidence_jsonb", "created_at")
      VALUES ('00000000-0000-0000-0000-0000000000a1'::uuid, ${otherCandidateId}::uuid, ${runId}::uuid,
       'reviewer-1', 'accept', 'test',
       ${VALID_SHA}, ${VALID_SHA}, ${VALID_SHA}, '{}', now())
    `;
  });

  // 10. Review SHA mismatch
  console.log('\n--- 10. Review SHA mismatch ---');
  await expectThrows('review with wrong source_sha256 rejected', async () => {
    await prisma.$executeRaw`
      INSERT INTO "budget_review_decision_v1"
      ("id", "candidate_id", "run_id", "reviewer_id", "decision", "notes",
       "source_sha256", "extraction_artifact_sha256", "manifest_content_sha256",
       "evidence_jsonb", "created_at")
      VALUES ('00000000-0000-0000-0000-0000000000a2'::uuid, ${candidateId}::uuid, ${runId}::uuid,
       'reviewer-1', 'accept', 'sha mismatch test',
       ${DIFFERENT_SHA}, ${VALID_SHA}, ${VALID_SHA}, '{}', now())
    `;
  });

  // 11. Update/delete immutable rows
  console.log('\n--- 11. Update/delete immutable rows ---');
  await expectThrows('update of immutable run rejected', async () => {
    await prisma.$executeRaw`
      UPDATE "budget_verification_run_v1" SET "risk_score" = 99 WHERE "id" = ${runId}::uuid
    `;
  });
  await expectThrows('update of immutable check rejected', async () => {
    await prisma.$executeRaw`
      UPDATE "budget_verification_check_v1" SET "outcome" = 'FAIL' WHERE "check_id" = ${checkId}
    `;
  });
  // Delete is blocked by RESTRICT FKs on child tables (checks, proofs, discrepancies reference run)
  // The run itself has ON DELETE RESTRICT from candidate, and checks/proofs/discrepancies have FK to run with RESTRICT
  await expectThrows('delete of immutable run with children rejected', async () => {
    await prisma.$executeRaw`
      DELETE FROM "budget_verification_run_v1" WHERE "id" = ${runId}::uuid
    `;
  });

  // 12. Successful accepted review
  console.log('\n--- 12. Accepted review ---');
  const reviewId = '00000000-0000-0000-0000-0000000000c1';
  try {
    await prisma.$executeRaw`
      INSERT INTO "budget_review_decision_v1"
      ("id", "candidate_id", "run_id", "reviewer_id", "decision", "notes",
       "source_sha256", "extraction_artifact_sha256", "manifest_content_sha256",
       "evidence_jsonb", "created_at")
      VALUES (${reviewId}::uuid, ${candidateId}::uuid, ${runId}::uuid,
       'reviewer-1', 'accept', 'accepted review test',
       ${VALID_SHA}, ${VALID_SHA}, ${VALID_SHA}, '{}', now())
    `;
    check('accepted review inserted', true);
  } catch (err) {
    check('accepted review inserted', false);
    console.error('  Error:', err);
  }

  // 13. Second terminal review rejected (single terminal decision)
  console.log('\n--- 13. Second terminal review rejected ---');
  await expectThrows('second terminal review rejected', async () => {
    await prisma.$executeRaw`
      INSERT INTO "budget_review_decision_v1"
      ("id", "candidate_id", "run_id", "reviewer_id", "decision", "notes",
       "source_sha256", "extraction_artifact_sha256", "manifest_content_sha256",
       "evidence_jsonb", "created_at")
      VALUES ('00000000-0000-0000-0000-0000000000c2'::uuid, ${candidateId}::uuid, ${runId}::uuid,
       'reviewer-2', 'reject', 'second review attempt',
       ${VALID_SHA}, ${VALID_SHA}, ${VALID_SHA}, '{}', now())
    `;
  });

  // 14. Review update rejected (immutable)
  console.log('\n--- 14. Review update rejected (immutable) ---');
  await expectThrows('review update rejected', async () => {
    await prisma.$executeRaw`
      UPDATE "budget_review_decision_v1" SET "notes" = 'tampered' WHERE "id" = ${reviewId}::uuid
    `;
  });

  // 15. No canonical table changes
  console.log('\n--- 15. No canonical table changes ---');
  const peRowCount = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint as count FROM "program_element"
  `;
  check('program_element table unchanged (empty)', Number(peRowCount[0]?.count) === 0);
  const peYearCount = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint as count FROM "program_element_year"
  `;
  check('program_element_year table unchanged (empty)', Number(peYearCount[0]?.count) === 0);

  // 16. Re-run migration deploy confirms stable state
  console.log('\n--- 16. Migration state stable ---');
  const pendingMigrations = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint as count FROM _prisma_migrations WHERE finished_at IS NULL
  `;
  check('no pending migrations', Number(pendingMigrations[0]?.count) === 0);

  // 17. Risk score bounds
  console.log('\n--- 17. Risk score bounds ---');
  await expectThrows('risk_score > 100 rejected', async () => {
    const badRunId = '00000000-0000-0000-0000-0000000000d1';
    const badCandidateId = '00000000-0000-0000-0000-0000000000d2';
    await prisma.$executeRaw`
      INSERT INTO "budget_extraction_candidate_v1"
      ("id", "cycle_id", "manifest_content_sha256", "manifest_document_key",
       "extraction_artifact_id", "extraction_artifact_sha256", "extraction_artifact_locator",
       "source_document_id", "source_sha256", "verifier_version", "policy_version", "policy_sha256",
       "status", "created_at", "updated_at")
      VALUES (${badCandidateId}::uuid, 'fy2027', ${VALID_SHA}, 'r1_risk_test',
       'art-risk', ${VALID_SHA}, '/test/risk.json',
       ${sourceDocId}::uuid, ${VALID_SHA}, 'defense_budget_verifier_v1', 'defense_budget_verification_policy_v1', ${VALID_SHA},
       'EXTRACTED', now(), now())
    `;
    await prisma.$executeRaw`
      INSERT INTO "budget_verification_run_v1"
      ("id", "candidate_id", "verifier_version", "policy_version", "policy_sha256",
       "decision", "status", "route", "risk_score", "started_at", "completed_at",
       "manifest_content_sha256", "extraction_artifact_sha256", "source_sha256", "result_snapshot_jsonb", "created_at")
      VALUES (${badRunId}::uuid, ${badCandidateId}::uuid, 'defense_budget_verifier_v1', 'defense_budget_verification_policy_v1', ${VALID_SHA},
       'PASS', 'VERIFICATION_PASSED', 'none', 101, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z',
       ${VALID_SHA}, ${VALID_SHA}, ${VALID_SHA}, '{}', now())
    `;
  });

  // 18. Blank notes review rejected
  console.log('\n--- 18. Blank notes review rejected ---');
  const blankNotesCandidateId = '00000000-0000-0000-0000-0000000000e1';
  const blankNotesRunId = '00000000-0000-0000-0000-0000000000e2';
  await prisma.$executeRaw`
    INSERT INTO "budget_extraction_candidate_v1"
    ("id", "cycle_id", "manifest_content_sha256", "manifest_document_key",
     "extraction_artifact_id", "extraction_artifact_sha256", "extraction_artifact_locator",
     "source_document_id", "source_sha256", "verifier_version", "policy_version", "policy_sha256",
     "status", "current_run_id", "created_at", "updated_at")
    VALUES (${blankNotesCandidateId}::uuid, 'fy2027', ${VALID_SHA}, 'r1_blank_notes',
     'art-blank', ${VALID_SHA}, '/test/blank.json',
     ${sourceDocId}::uuid, ${VALID_SHA}, 'defense_budget_verifier_v1', 'defense_budget_verification_policy_v1', ${VALID_SHA},
     'NEEDS_REVIEW', ${blankNotesRunId}::uuid, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
  await prisma.$executeRaw`
    INSERT INTO "budget_verification_run_v1"
    ("id", "candidate_id", "verifier_version", "policy_version", "policy_sha256",
     "decision", "status", "route", "risk_score", "started_at", "completed_at",
     "manifest_content_sha256", "extraction_artifact_sha256", "source_sha256", "result_snapshot_jsonb", "created_at")
    VALUES (${blankNotesRunId}::uuid, ${blankNotesCandidateId}::uuid, 'defense_budget_verifier_v1', 'defense_budget_verification_policy_v1', ${VALID_SHA},
     'REVIEW', 'NEEDS_REVIEW', 'human_review', 50, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z',
     ${VALID_SHA}, ${VALID_SHA}, ${VALID_SHA}, '{}', now())
    ON CONFLICT (id) DO NOTHING
  `;
  await expectThrows('blank notes review rejected', async () => {
    await prisma.$executeRaw`
      INSERT INTO "budget_review_decision_v1"
      ("id", "candidate_id", "run_id", "reviewer_id", "decision", "notes",
       "source_sha256", "extraction_artifact_sha256", "manifest_content_sha256",
       "evidence_jsonb", "created_at")
      VALUES ('00000000-0000-0000-0000-0000000000e3'::uuid, ${blankNotesCandidateId}::uuid, ${blankNotesRunId}::uuid,
       'reviewer-1', 'accept', '',
       ${VALID_SHA}, ${VALID_SHA}, ${VALID_SHA}, '{}', now())
    `;
  });

  // 19. SHA format validation
  console.log('\n--- 19. SHA format validation ---');
  await expectThrows('invalid SHA format rejected', async () => {
    await prisma.$executeRaw`
      INSERT INTO "budget_extraction_candidate_v1"
      ("id", "cycle_id", "manifest_content_sha256", "manifest_document_key",
       "extraction_artifact_id", "extraction_artifact_sha256", "extraction_artifact_locator",
       "source_document_id", "source_sha256", "verifier_version", "policy_version", "policy_sha256",
       "status", "created_at", "updated_at")
      VALUES ('00000000-0000-0000-0000-0000000000f1'::uuid, 'fy2027', 'not-a-sha', 'r1_bad_sha',
       'art-bad-sha', ${VALID_SHA}, '/test/bad.json',
       ${sourceDocId}::uuid, ${VALID_SHA}, 'defense_budget_verifier_v1', 'defense_budget_verification_policy_v1', ${VALID_SHA},
       'EXTRACTED', now(), now())
    `;
  });

  // 20. Rejected review (on a fresh candidate)
  console.log('\n--- 20. Rejected review ---');
  const rejectCandidateId = '00000000-0000-0000-0000-000000000011';
  const rejectRunId = '00000000-0000-0000-0000-000000000012';
  await prisma.$executeRaw`
    INSERT INTO "budget_extraction_candidate_v1"
    ("id", "cycle_id", "manifest_content_sha256", "manifest_document_key",
     "extraction_artifact_id", "extraction_artifact_sha256", "extraction_artifact_locator",
     "source_document_id", "source_sha256", "verifier_version", "policy_version", "policy_sha256",
     "status", "current_run_id", "created_at", "updated_at")
    VALUES (${rejectCandidateId}::uuid, 'fy2027', ${VALID_SHA}, 'r1_reject_test',
     'art-reject', ${VALID_SHA}, '/test/reject.json',
     ${sourceDocId}::uuid, ${VALID_SHA}, 'defense_budget_verifier_v1', 'defense_budget_verification_policy_v1', ${VALID_SHA},
     'NEEDS_REVIEW', ${rejectRunId}::uuid, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
  await prisma.$executeRaw`
    INSERT INTO "budget_verification_run_v1"
    ("id", "candidate_id", "verifier_version", "policy_version", "policy_sha256",
     "decision", "status", "route", "risk_score", "started_at", "completed_at",
     "manifest_content_sha256", "extraction_artifact_sha256", "source_sha256", "result_snapshot_jsonb", "created_at")
    VALUES (${rejectRunId}::uuid, ${rejectCandidateId}::uuid, 'defense_budget_verifier_v1', 'defense_budget_verification_policy_v1', ${VALID_SHA},
     'REVIEW', 'NEEDS_REVIEW', 'human_review', 50, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z',
     ${VALID_SHA}, ${VALID_SHA}, ${VALID_SHA}, '{}', now())
    ON CONFLICT (id) DO NOTHING
  `;
  try {
    await prisma.$executeRaw`
      INSERT INTO "budget_review_decision_v1"
      ("id", "candidate_id", "run_id", "reviewer_id", "decision", "notes",
       "source_sha256", "extraction_artifact_sha256", "manifest_content_sha256",
       "evidence_jsonb", "created_at")
      VALUES ('00000000-0000-0000-0000-000000000013'::uuid, ${rejectCandidateId}::uuid, ${rejectRunId}::uuid,
       'reviewer-1', 'reject', 'rejected review test',
       ${VALID_SHA}, ${VALID_SHA}, ${VALID_SHA}, '{}', now())
    `;
    check('rejected review inserted', true);
  } catch (err) {
    check('rejected review inserted', false);
    console.error('  Error:', err);
  }

  // 21. Review against non-NEEDS_REVIEW candidate rejected
  console.log('\n--- 21. Review against non-NEEDS_REVIEW candidate rejected ---');
  const passedCandidateId = '00000000-0000-0000-0000-000000000021';
  const passedRunId = '00000000-0000-0000-0000-000000000022';
  await prisma.$executeRaw`
    INSERT INTO "budget_extraction_candidate_v1"
    ("id", "cycle_id", "manifest_content_sha256", "manifest_document_key",
     "extraction_artifact_id", "extraction_artifact_sha256", "extraction_artifact_locator",
     "source_document_id", "source_sha256", "verifier_version", "policy_version", "policy_sha256",
     "status", "current_run_id", "created_at", "updated_at")
    VALUES (${passedCandidateId}::uuid, 'fy2027', ${VALID_SHA}, 'r1_passed',
     'art-passed', ${VALID_SHA}, '/test/passed.json',
     ${sourceDocId}::uuid, ${VALID_SHA}, 'defense_budget_verifier_v1', 'defense_budget_verification_policy_v1', ${VALID_SHA},
     'VERIFICATION_PASSED', ${passedRunId}::uuid, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
  await prisma.$executeRaw`
    INSERT INTO "budget_verification_run_v1"
    ("id", "candidate_id", "verifier_version", "policy_version", "policy_sha256",
     "decision", "status", "route", "risk_score", "started_at", "completed_at",
     "manifest_content_sha256", "extraction_artifact_sha256", "source_sha256", "result_snapshot_jsonb", "created_at")
    VALUES (${passedRunId}::uuid, ${passedCandidateId}::uuid, 'defense_budget_verifier_v1', 'defense_budget_verification_policy_v1', ${VALID_SHA},
     'PASS', 'VERIFICATION_PASSED', 'none', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z',
     ${VALID_SHA}, ${VALID_SHA}, ${VALID_SHA}, '{}', now())
    ON CONFLICT (id) DO NOTHING
  `;
  await expectThrows('review against VERIFICATION_PASSED candidate rejected', async () => {
    await prisma.$executeRaw`
      INSERT INTO "budget_review_decision_v1"
      ("id", "candidate_id", "run_id", "reviewer_id", "decision", "notes",
       "source_sha256", "extraction_artifact_sha256", "manifest_content_sha256",
       "evidence_jsonb", "created_at")
      VALUES ('00000000-0000-0000-0000-000000000023'::uuid, ${passedCandidateId}::uuid, ${passedRunId}::uuid,
       'reviewer-1', 'accept', 'attempting to review a passed candidate',
       ${VALID_SHA}, ${VALID_SHA}, ${VALID_SHA}, '{}', now())
    `;
  });

  // Summary
  console.log('\n=== Rehearsal Summary ===');
  console.log(`  Passed: ${pass}`);
  console.log(`  Failed: ${fail}`);
  if (fail > 0) {
    console.error('REHEARSAL FAILED');
    process.exit(1);
  } else {
    console.log('REHEARSAL PASSED');
  }
}

main()
  .catch((err) => {
    console.error('Rehearsal script error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
