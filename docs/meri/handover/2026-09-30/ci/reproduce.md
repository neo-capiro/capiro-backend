# Portable reproduction commands

Run from a clean, isolated checkout of the intended commit. Read current shared policy first. These are commands for a future agent to run; creating this handover did not execute CI, deploy, or contact a database.

Use Node 22 for the local reproductions and final-matrix parity (recorded local version: 22.23.3). The repository pins pnpm 9.12.0 in package.json. Use that version and the committed lockfile; do not update dependencies. Prefer a frozen offline install when the dependency store is already populated. A new machine needs normal authorized dependency setup before these commands. The Runtime Boundary workflow's existing Node 20 choice is a separate CI gate and remains unchanged.

Examples below use Bash on Linux, matching GitHub Actions. `pnpm` denotes the approved executable for the host; it is not a hardcoded path from the previous operator's machine. Choose an evidence directory outside the checkout. On Neo's Windows host, that directory must be under the drive-level development workspace, not a user-directory checkout.

## Verify the exact source and retrieve existing results

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
git config --get core.autocrlf
gh pr view 1915 --repo neo-capiro/capirov2 --json headRefOid,headRefName,statusCheckRollup
```

Read-only download of one completed job, with an explicitly chosen local output directory:

```bash
export CAPIRO_EVIDENCE_DIR="$(cd .. && pwd)/capiro-ci-evidence"
mkdir -p "$CAPIRO_EVIDENCE_DIR"
gh api repos/neo-capiro/capirov2/actions/jobs/109646986970/logs \
  --allow-escape-sequences > "$CAPIRO_EVIDENCE_DIR/final-matrix-0607.log"
```

Use the other exact job IDs in [README.md](README.md) for their logs. These are historical baseline logs, not current-head results. Do not commit raw logs or copied credentials, sessions, customer records or private test configuration files. Log line references in [failures.json](failures.json) refer to this unmodified baseline job log; each failed-suite header also identifies its own source path.

## Build and generate local prerequisites without migrating

```bash
pnpm --version                         # must match packageManager: 9.12.0
node --version
pnpm --filter @capiro/shared build
pnpm --filter @capiro/meriv2-core build
pnpm --filter @capiro/api exec prisma generate --schema prisma/schema.prisma
pnpm --filter @capiro/intel-api exec prisma generate --schema prisma/schema.prisma
```

Prisma generation is not migration deployment and needs no database connection. The first local Intel test attempt lacked its generated client; generation completed with exit 0, after which the unchanged tests passed. If other workspace outputs are missing in a fresh checkout, build their declared dependencies; do not confuse missing outputs with application defects or broaden the tested source.

## Re-run the focused repaired scope

```bash
export NODE_OPTIONS=--max-old-space-size=6144
pnpm --filter @capiro/api exec jest --runInBand --forceExit --runTestsByPath \
  scripts/lib/engagement-verifier-process.spec.ts
# Recorded result: 23 passed, exit 0.

pnpm --filter @capiro/api exec jest --runInBand --forceExit --runTestsByPath \
  src/ingestion/deadline-risk.spec.ts
# Recorded result: 22 passed, exit 0.

pnpm --filter @capiro/intel-api exec jest --runInBand --forceExit --runTestsByPath \
  src/tracker/state-bill-change-detector.spec.ts \
  src/tracker/change-detector.util.spec.ts
# Recorded result: 30 passed, exit 0.
```

The helper suite uses real child processes and Bash/coreutils for its shell-gate cases. Missing tools are setup failures, not permission to skip those cases. Retain actual exit codes when saving output; a pipeline to tee must preserve the test command's exit code.

## Reproduce the Tango setup defect

Both tests use the real SDK with a fake transport; no API key or provider connection is needed. The first command is intentionally expected to fail and should be run separately from a fail-fast script.

```bash
NODE_OPTIONS='--max-old-space-size=6144 --experimental-vm-modules' \
  pnpm --filter @capiro/api exec jest --runInBand --forceExit --runTestsByPath \
  src/external/tango/tango.client.spec.ts \
  src/external/tango/tango-capability-probe.service.spec.ts \
  --testNamePattern 'getEntity sends the audited entity shape|constructs a working client whose getVersion'
# Recorded: 2 failed, 138 unselected, exit 1; ESM loader error.

NODE_OPTIONS=--max-old-space-size=6144 \
  pnpm --filter @capiro/api exec jest --runInBand --forceExit --runTestsByPath \
  src/external/tango/tango.client.spec.ts \
  src/external/tango/tango-capability-probe.service.spec.ts
# Recorded: all 140 passed, no skips, exit 0.
```

## Check extraction separately from accumulated memory pressure

```bash
NODE_OPTIONS=--max-old-space-size=6144 \
  pnpm --filter @capiro/api exec jest --detectOpenHandles --forceExit --runTestsByPath \
  src/meri/meri-attachment-document.spec.ts \
  src/engagement/pptx-extract.spec.ts
# Recorded: 33 passed unchanged, exit 0.
```

This proves the suites can pass in a fresh process; it does not establish that a future Linux shard passes. Do not raise their test deadlines based solely on the old memory-saturated run.

## Prove proposed API shard coverage without executing tests

```bash
node docs/meri/handover/2026-09-30/ci/verify-api-shard-union.cjs \
  --output-dir "$CAPIRO_EVIDENCE_DIR/shard-discovery"
```

The script uses installed Jest's `--listTests --json --runInBand` once for the full set and once for each of four `--shard=N/4` sets. It records the actual source SHA, normalized repository-relative test paths, counts and digest. It fails on empty discovery, duplicate assignment or a non-exact union. It does **not** run tests, migrate, install, fetch, push or contact AWS.

Recorded on c785e566321943470978d66325952ed916951346: 1,762 suites; shard counts 441/441/440/440; zero duplicates; exact union; exit 0. The normalized full-list SHA-256 was `4d59db9c184d18a80e16d0cfb8761d86823faaf730557024ee6db185d89f8a17`. A future legitimate source change can alter discovery; review additions/removals against the source diff rather than treating the old digest as perpetual permission.

Only after owned disposable database and parser prerequisites are explicitly prepared, a shard execution uses the original command and flags plus its shard selector, for example:

```bash
# Example only: this runs integration tests and therefore requires the owned CI fixture setup.
pnpm --filter @capiro/api test --shard=1/4
```

Run **all four** shards with separate exit reporting; require every exit to be zero. This example is not a complete CI orchestration patch. Parallel mutating shards require isolated disposable databases. Retain the migration integrity, full downstream matrix, security and replay gates listed in [README.md](README.md). Never point these integration suites at the shared development database.
