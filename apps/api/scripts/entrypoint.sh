#!/bin/sh
# Program Elements and MeriV2 trust-safety wrapper for the API container entrypoint.
#
# It owns the trust-critical verbs that must not pass through the legacy
# entrypoint behavior: migration status/deployment (fail closed; never edits
# Prisma's migration ledger), SELECT-only diagnostics, and bounded operational
# monitors. Every other command delegates byte-for-byte to the existing dispatcher.
set -e

select_writable_tmpdir() {
  probe_name=".capiro-tmp-probe-$$"

  for candidate in "${TMPDIR:-}" /dev/shm /tmp; do
    [ -n "$candidate" ] || continue
    probe_path="$candidate/$probe_name"

    if [ -d "$candidate" ] \
      && touch "$probe_path" 2>/dev/null \
      && rm -f "$probe_path" 2>/dev/null; then
      TMPDIR="$candidate"
      export TMPDIR
      return 0
    fi

    rm -f "$probe_path" 2>/dev/null || true
  done

  echo "No writable runtime temporary directory (tried TMPDIR, /dev/shm, /tmp)" >&2
  exit 73
}

compose_database_url() {
  if [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
    echo "Missing DB_* env vars (got DB_HOST=$DB_HOST DB_PORT=$DB_PORT DB_USER=$DB_USER DB_NAME=$DB_NAME)" >&2
    exit 1
  fi
  # Real URL via node helper (image path). Never embed a masked password marker here.
  # entrypoint is installed at /usr/local/bin; helper lives with scripts in the image.
  COMPOSE_HELPER="${PE_COMPOSE_DATABASE_URL_JS:-/app/apps/api/scripts/lib/pe-compose-database-url.js}"
  if [ ! -f "$COMPOSE_HELPER" ]; then
    if [ -f "./scripts/lib/pe-compose-database-url.js" ]; then
      COMPOSE_HELPER="./scripts/lib/pe-compose-database-url.js"
    elif [ -f "./lib/pe-compose-database-url.js" ]; then
      COMPOSE_HELPER="./lib/pe-compose-database-url.js"
    fi
  fi
  export DATABASE_URL="$(node "$COMPOSE_HELPER")"
  # Diagnostics must never substitute an ECS metadata URI for a Git commit.
  # Deployment automation may set a real GIT_SHA; otherwise report UNVERIFIED.
  : "${GIT_SHA:=UNVERIFIED}"
  export GIT_SHA
}

select_writable_tmpdir

case "${1:-serve}" in
  migration-status)
    compose_database_url
    echo "Running prisma migrate status (READ-ONLY; migration history is never edited)"
    exec node ./node_modules/prisma/build/index.js migrate status --schema=./prisma/schema.prisma
    ;;
  migrate-resolve-rolled-back)
    shift
    if [ -z "${1:-}" ]; then
      echo "Usage: migrate-resolve-rolled-back <migration_name>" >&2
      exit 1
    fi
    compose_database_url
    # Controlled recovery only -- docs/runbooks/prisma-failed-migration-recovery.md
    # requires a ticket, an operator, and a separate approver before this runs
    # against a real environment. Never invoked by any automated path; the failed
    # migration's DDL/DML must already be verified absent (this command records
    # that fact in Prisma's own ledger, it does not itself reverse anything).
    echo "Running prisma migrate resolve --rolled-back $1 (controlled recovery, see runbook)"
    exec node ./node_modules/prisma/build/index.js migrate resolve --schema=./prisma/schema.prisma --rolled-back "$1"
    ;;
  migrate-resolve-applied)
    shift
    if [ -z "${1:-}" ]; then
      echo "Usage: migrate-resolve-applied <migration_name>" >&2
      exit 1
    fi
    compose_database_url
    # Same controlled-recovery gate as migrate-resolve-rolled-back above, for the
    # case where every statement and postcondition was independently verified
    # present rather than absent.
    echo "Running prisma migrate resolve --applied $1 (controlled recovery, see runbook)"
    exec node ./node_modules/prisma/build/index.js migrate resolve --schema=./prisma/schema.prisma --applied "$1"
    ;;
  migrate)
    compose_database_url
    echo "Running prisma migrate deploy (failed migration history is never auto-resolved)"
    node ./node_modules/prisma/build/index.js migrate deploy --schema=./prisma/schema.prisma
    echo "Seeding workflow templates"
    exec ./node_modules/.bin/tsx prisma/seed-workflows.ts
    ;;
  meri-hermes-staging-continuity-proof)
    shift
    compose_database_url
    echo "Running guarded Meri Hermes staging continuity proof (synthetic tenant only)"
    exec ./node_modules/.bin/tsx scripts/meri-hermes-staging-continuity-proof.ts "$@"
    ;;
  sync-florida-official-committees)
    shift
    compose_database_url
    echo "Running sync-florida-official-committees (dry run unless --apply; non-local apply requires explicit opt-in and confirmation)"
    exec ./node_modules/.bin/tsx scripts/sync-florida-official-committees.ts "$@"
    ;;
  ingest-florida-legislative-directories)
    shift
    compose_database_url
    echo "Running ingest-florida-legislative-directories (dry run unless --apply; exact manifest and plan confirmations required)"
    exec ./node_modules/.bin/tsx scripts/ingest-florida-legislative-directories.ts "$@"
    ;;
  diag-pe-trust)
    shift
    compose_database_url
    echo "Running diag-pe-trust (SELECT-only Program Elements trust baseline)"
    exec ./node_modules/.bin/tsx scripts/diag-program-element-trust-baseline.ts "$@"
    ;;
  snapshot-defense-budget-package0-v1)
    shift
    compose_database_url
    echo "Running snapshot-defense-budget-package0-v1 (SELECT-only Package 0 inventory)"
    exec ./node_modules/.bin/tsx scripts/snapshot-defense-budget-package0-v1.ts "$@"
    ;;
  snapshot-defense-budget-package1-v1)
    shift
    compose_database_url
    echo "Running snapshot-defense-budget-package1-v1 (SELECT-only exact recovery inventory)"
    exec ./node_modules/.bin/tsx scripts/snapshot-defense-budget-package1-v1.ts "$@"
    ;;
  audit-llamaparse-pe-units)
    shift
    compose_database_url
    echo "Running audit-llamaparse-pe-units (SELECT-only historical money-unit evidence report)"
    exec ./node_modules/.bin/tsx scripts/audit-llamaparse-pe-units.ts "$@"
    ;;
  pe-phase-10-live-proofs)
    shift
    compose_database_url
    export TSX_TSCONFIG_PATH="${TSX_TSCONFIG_PATH:-./tsconfig.json}"
    echo "Running pe-phase-10-live-proofs (sole-live Aurora; synthetic pe10_closeout domain only; TMPDIR=$TMPDIR)"
    exec ./node_modules/.bin/tsx scripts/pe-phase-10-live-proofs.ts "$@"
    ;;
  emit-meriv2-control-metrics)
    shift
    compose_database_url
    echo "Running emit-meriv2-control-metrics (read-only bounded control snapshot)"
    exec ./node_modules/.bin/tsx scripts/emit-meriv2-control-metrics.ts "$@"
    ;;
  demo-meriv2-control-alarms)
    shift
    echo "Running demo-meriv2-control-alarms (refuses dev/prod; explicit non-prod confirmation required)"
    exec ./node_modules/.bin/tsx scripts/demo-meriv2-control-alarms.ts "$@"
    ;;
  # Phase 7 Workstream N. Trust-critical promotion-operator verbs belong here,
  # not in entrypoint-dispatcher.inc — that file is the frozen legacy include
  # Workstream M's containment gate wraps, not where new promotion verbs go
  # (docs/defense-budget/PHASE-7-PRE-IMPLEMENTATION-DEPENDENCY-MAP.md §4). All
  # eight of the plan's own promotion verbs are wired as of session 9 (Gap 3
  # closeout): authorize-defense-budget-promotion-v1 was the last, blocked on
  # segregation-of-duties evidence needing the full eligibility record, and no
  # table stored one. defense_budget_promotion_eligibility (append-only, FK'd
  # from defense_budget_promotion_plan.eligibility_hash) now does.
  #
  # file-defense-budget-promotion-plan-v1 is a NINTH verb, not in the original
  # plan: plan-defense-budget-promotion-v1's own header always said "the plan
  # is filed by a separate authorized step, not by this command," and that
  # step never existed anywhere — validate/authorize/execute all read a plan
  # row that nothing wrote. Session 9 found this (Gap 4) and closed it; see
  # docs/defense-budget/PHASE-7-ARCHITECTURE-GAPS.md Gap 4.
  #
  # execute and rollback deliberately read PROMOTER_DATABASE_URL and never fall
  # back to the composed DATABASE_URL, so compose_database_url is not called for
  # them; promoting as the serve role is the boundary Workstream D exists to
  # enforce. authorize and file-plan run under the general serve role — neither
  # carries promotion authority of its own — so both are grouped with
  # plan/validate/status/compare, not execute/rollback.
  plan-defense-budget-promotion-v1)
    shift
    compose_database_url
    echo "Running plan-defense-budget-promotion-v1 (READ-ONLY; no write statement issued)"
    exec ./node_modules/.bin/tsx scripts/plan-defense-budget-promotion-v1.ts "$@"
    ;;
  file-defense-budget-promotion-plan-v1)
    shift
    compose_database_url
    echo "Running file-defense-budget-promotion-plan-v1 (dry run unless --commit; writes only this one plan row)"
    exec ./node_modules/.bin/tsx scripts/file-defense-budget-promotion-plan-v1.ts "$@"
    ;;
  authorize-defense-budget-promotion-v1)
    shift
    compose_database_url
    echo "Running authorize-defense-budget-promotion-v1 (writes only an immutable, one-use authorization record)"
    exec ./node_modules/.bin/tsx scripts/authorize-defense-budget-promotion-v1.ts "$@"
    ;;
  validate-defense-budget-promotion-v1)
    shift
    compose_database_url
    echo "Running validate-defense-budget-promotion-v1 (READ-ONLY; no write statement issued)"
    exec ./node_modules/.bin/tsx scripts/validate-defense-budget-promotion-v1.ts "$@"
    ;;
  status-defense-budget-promotion-v1)
    shift
    compose_database_url
    echo "Running status-defense-budget-promotion-v1 (READ-ONLY; no write statement issued)"
    exec ./node_modules/.bin/tsx scripts/status-defense-budget-promotion-v1.ts "$@"
    ;;
  compare-defense-budget-canonical-reads-v1)
    shift
    compose_database_url
    echo "Running compare-defense-budget-canonical-reads-v1 (READ-ONLY; no write statement issued)"
    exec ./node_modules/.bin/tsx scripts/compare-defense-budget-canonical-reads-v1.ts "$@"
    ;;
  execute-defense-budget-promotion-v1)
    shift
    echo "Running execute-defense-budget-promotion-v1 (promoter role; dry run unless --commit --confirm <env>)"
    exec ./node_modules/.bin/tsx scripts/execute-defense-budget-promotion-v1.ts "$@"
    ;;
  rollback-defense-budget-snapshot-v1)
    shift
    echo "Running rollback-defense-budget-snapshot-v1 (promoter role; dry run unless --commit --confirm <env>; deletes nothing)"
    exec ./node_modules/.bin/tsx scripts/rollback-defense-budget-snapshot-v1.ts "$@"
    ;;
  resume-defense-budget-promotion-side-effects-v1)
    shift
    compose_database_url
    echo "Running resume-defense-budget-promotion-side-effects-v1 (writes only this scope's drain-pause row; dry run unless --commit)"
    exec ./node_modules/.bin/tsx scripts/resume-defense-budget-promotion-side-effects-v1.ts "$@"
    ;;
  # Phase 7 Gap 5 decision 3 — not one of the promotion chain's nine verbs
  # above (it belongs to the Phase 4/5/6 producer boundary, not to promotion
  # itself), but the same shape: serve role, dry run unless --commit, writes
  # only one immutable plan row. Was runnable only via a raw `tsx` invocation
  # from a shell with repo access; every sibling verb in this file has its own
  # case, so this one gets one too rather than staying the sole exception.
  persist-defense-budget-projection-plan-v1)
    shift
    compose_database_url
    echo "Running persist-defense-budget-projection-plan-v1 (dry run unless --commit; writes only this one plan row)"
    exec ./node_modules/.bin/tsx scripts/persist-defense-budget-projection-plan-v1.ts "$@"
    ;;
  # Phase 10B-10 Part I. Governed terminal-replay for the ingestion outbox --
  # same shape as the promotion-chain verbs above: serve role (composed via
  # compose_database_url, never PROMOTER_DATABASE_URL -- the outbox is not a
  # promotion table), dry run unless --commit --confirm <env>, exact-row
  # only. Given its own explicit case rather than falling through to the
  # legacy dispatcher, exactly like every other trust-critical verb in this
  # file.
  replay-defense-budget-ingestion-outbox-v1)
    shift
    compose_database_url
    echo "Running replay-defense-budget-ingestion-outbox-v1 (exact-row only; dry run unless --commit --confirm <env>)"
    exec ./node_modules/.bin/tsx scripts/replay-defense-budget-ingestion-outbox-v1.ts "$@"
    ;;
  # Phase 10B-15 Parts E/F. Governed REVIEW acceptance for the ingestion
  # outbox -- the mirror-image verb to the replay above, for the opposite
  # terminal disposition (verifierDecision=REVIEW, not REJECT). Same shape:
  # serve role (compose_database_url), dry run unless --commit --confirm
  # <env>, exact-row only. Never reuses replay-defense-budget-ingestion-
  # outbox-v1 -- that command's own SQL predicate refuses any row whose
  # verifierDecision is not exactly 'REJECT'.
  accept-defense-budget-ingestion-review-v1)
    shift
    compose_database_url
    echo "Running accept-defense-budget-ingestion-review-v1 (exact-row only; dry run unless --commit --confirm <env>)"
    exec ./node_modules/.bin/tsx scripts/accept-defense-budget-ingestion-review-v1.ts "$@"
    ;;
  reextract-defense-budget-candidate-v1)
    shift
    compose_database_url
    echo "Running reextract-defense-budget-candidate-v1 (app role; preview unless --commit --confirm <env>; --status reads one operation)"
    exec ./node_modules/.bin/tsx scripts/reextract-defense-budget-candidate-v1.ts "$@"
    ;;
  run-defense-budget-ingestion-manifest-v1)
    shift
    compose_database_url
    echo "Running run-defense-budget-ingestion-manifest-v1 (preview by default; exact immutable manifest only)"
    exec ./node_modules/.bin/tsx scripts/run-defense-budget-ingestion-manifest-v1.ts "$@"
    ;;
  # Phase 10B-18/19. Governed operator-attested import for an expected
  # source/bundle member whose official publisher host blocks production
  # fetches (asafm.army.mil's Akamai block). Same shape as the promotion-
  # chain/outbox-replay verbs above: serve role (compose_database_url, never
  # PROMOTER_DATABASE_URL — this never touches a canonical PE/budget row,
  # only lifecycle observation/SourceDocument/audit rows through the same
  # governed pipeline drain-defense-budget-ingestion-outbox-v1 already uses),
  # dry run unless --commit --confirm <environment>, exact expected-source-
  # id/member-id only — no batch mode, no family mode, no wildcard source.
  import-defense-budget-source-v1)
    shift
    compose_database_url
    echo "Running import-defense-budget-source-v1 (dry run unless --commit --confirm <env>)"
    exec ./node_modules/.bin/tsx scripts/import-defense-budget-source-v1.ts "$@"
    ;;
  # Phase 10B-19 Part N. Seeds the ten DefenseBudgetSourceBundleMember rows
  # (ARMY_RDTE_VOLUME_CATALOG) under one existing Army FY24 pb_r2 expected
  # source. Never marks a member observed/verified, never writes
  # expected_state. Dry run unless --commit --confirm <environment>.
  seed-army-r2-bundle-members-v1)
    shift
    compose_database_url
    echo "Running seed-army-r2-bundle-members-v1 (dry run unless --commit --confirm <env>)"
    exec ./node_modules/.bin/tsx scripts/seed-army-r2-bundle-members-v1.ts "$@"
    ;;
  # Phase 10B-36. Release-qualification driver for a new
  # defense-budget-ingestion-drain image, run only inside the isolated
  # 3-container Fargate task shape (qual + pg + minio sidecars) on the
  # capiro-dev-defense-budget-qualification task-definition family.
  # Deliberately does NOT call compose_database_url: DATABASE_URL for this
  # verb must stay exactly what the task-definition's own environment (or a
  # local rehearsal) already set -- the isolated `pg` sidecar at
  # 127.0.0.1:5432 -- never the composed real production Aurora connection
  # string compose_database_url would produce from DB_HOST/DB_PORT/DB_USER/
  # DB_PASSWORD/DB_NAME secrets. Never mutates production; see
  # scripts/qualify-defense-budget-drain-image-v1.ts's own header for the
  # full contract and exit-code meanings.
  qualify-defense-budget-drain-image-v1)
    shift
    echo "Running qualify-defense-budget-drain-image-v1 (isolated Postgres+MinIO only; never touches production)"
    exec ./node_modules/.bin/tsx scripts/qualify-defense-budget-drain-image-v1.ts "$@"
    ;;
  *)
    exec /bin/sh /usr/local/lib/capiro/entrypoint-legacy.sh "$@"
    ;;
esac
