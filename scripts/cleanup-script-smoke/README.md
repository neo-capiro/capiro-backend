# CleanUp1 §6.2 — isolated, audited script smoke

Runtime smoke for the repository's script surfaces. **Nothing is executed on the
host**: every entry point runs inside a container with a kernel-enforced
boundary, against a disposable staging tree of tracked source only, and **under
the real `strace -f` denied-syscall audit** — the audit is wired into the actual
invocations (`run-smoke.mjs` → `runWithAttemptAudit`), not only the proof
boundary.

**Honest result semantics.** A check is reported as passed ONLY when a real
command produced the evidence. A proposed or planned command is never recorded as
a pass. A `--limit` run is `partial: true`; a run whose isolation, audit, staging
or container lifecycle is unavailable fails closed (`isolation-unavailable` /
`attempt-audit-unavailable` / `stage-failed` / `container-residual` / …). Neither
a partial nor a failed run is ever whole-scope acceptance.

## Files

| File | Purpose |
| --- | --- |
| `discover.mjs` | Runtime-generated, source-based classification of every script (`entrypoint` / `module` / `test` / `unsafe` / `undiscovered-declared`). No checked-in list. Literal-aware, conservative: comments/strings are stripped before brace counting, a `const x = run()` initializer is execution, and malformed/unsupported source fails closed as an entry point. Every package.json-declared command that is missing or resolves outside the walked scope is surfaced as an explicit packet, never dropped. |
| `contract.mjs` | Derives EACH entry point's DOCUMENTED CLI contract from its OWN source (TypeScript AST): a no-args usage branch bound to the real `process.argv`, and a reachable, positive `--help`/`-h` handler. Exit codes are only accepted when the branch names an explicit `process.exit(N)` — an arbitrary integer is never accepted and a conventional exit is never invented. |
| `run-smoke.mjs` | Orchestrates discovery + VALIDATED staging + deps + audited isolation; fail-closed classification combining audit completeness with the per-entrypoint DERIVED contract; `--self-test` adversarial fixtures; fail-closed argument parser (unknown flag / missing value / invalid bound ⇒ usage error, exit 2); empty scope fails closed. |
| `tar-validate.mjs` | The ONE canonical tar validator (`parseAndValidateTar`, `validateTarAgainstManifest`, `validateTarContainment`). Strict byte-level parsing: PAX global/record handling, two-zero-block termination, strict octal/base-256 numeric fields, path safety. Any refusal fails closed. (Root-owned; read-only to the harness.) |
| `tar-materialize.mjs` | The ONE archive materialiser (`materializeValidatedArchive`): it validates with `tar-validate.mjs` **before writing any payload**, then writes each regular file's payload slice into a FRESH EMPTY dir with resolved-lexical containment and Windows-unsafe-name refusal (backslash, colon/device, UNC, drive, `.`/`..`, trailing dot/space, reserved device names, control chars). No `tar -xf`, no drive translation. Also re-exports the validator and `bindArchiveToSource`. |
| `isolation.mjs` | Runs one entry point via `docker create --name <owned> --label cleanup-smoke.run=<runId> --network none --read-only` with a `/tmp` tmpfs and a disposable `/evidence` mount. NEVER `--rm`-managed: the exact 64-hex container id is recorded (`--cidfile`) BEFORE start, ownership is verified by exact id **and** exact `cleanup-smoke.run` label, and removal is proven by `rm -f` exit 0 **plus** a single, fully-anchored Docker absence diagnostic naming that exact id (`bindsExactContainerAbsence`). A mismatch, a generic/ambiguous/transport absence result, or a residual container fails closed. Also records the heuristic stderr `denials` signal (NOT an audit). |
| `attempt-audit.mjs` | **Genuine denied-syscall/attempt audit**: runs an entry under `strace -f -yy -qq -s 65535` inside the same boundary and parses the trace (rejoining split `<unfinished>`/`<... resumed>` lines) for attempted network (AF_INET socket/connect/send) and FORBIDDEN writes (open-for-write to a non-disposable path, or mkdir/rename/unlink/truncate, refused `EROFS/EACCES/EPERM/EBADF`). Writes confined to the owned disposable area (`/tmp`, `/evidence`, `/dev`,`/proc`,`/sys`) are the permitted artefacts and are recorded separately. `classifyAttemptAudit` requires a complete native run (trace present, definite integer exit, no timeout/setup error, entry point actually exec'd) — a nonempty loader trace is not proof. The `-s 65535` string limit keeps the long TS subject path and the FULL mode argv verbatim so `entrypointExecutedFromTrace` can prove the EXACT subject + EXACT, ordered mode argv + a SUCCESSFUL exec — never a substring/short-subject/relaxed match. |
| `prove-boundary.mjs` | End-to-end proof that the boundary surfaces a denied net connect, a denied read-only-tree write, a SUPPRESSED (caught) attempt the stderr signal misses, an ignored `--help`, a no-args exit with no usage, and verified container termination — all through the real audit path. |
| `emit-evidence.mjs` | Runs the WHOLE discovered scope and emits the evidence artifact in the **schema-v4** shape the CI worker's validator (`scripts/cleanup-gates/lib/smoke-evidence.mjs::validateSmokeEvidence`, `schemaVersion 4`) accepts. Fails closed: the committed artifact is only written when every result is `ok` and the isolation proof was exercised; otherwise a `*.diagnostic.json`. |
| `ts-runtime.mjs` | Task-owned, Linux-native tsx runtime Docker VOLUME (mounted read-only into the `--network none` audit container). Owned-container lifecycle reuses the canonical `removeOwnedContainerById`; exact-name binding for volume/image absence. |
| `isolation-lifecycle-controls.mjs` | Executable lifecycle POLICY controls (pure `_inject` seam; no Docker). Includes the removal proof: exact-id-bound definite absence ⇒ removed, while a wrong id, wrong label, nonzero `rm`, daemon/unknown inspect, a GENERIC non-exact-id diagnostic, an absence diagnostic naming ANOTHER id / carrying SUFFIX text / only MENTIONING the id / containing MULTIPLE diagnostics, and a transport error each fail closed. |
| `archive-staging-controls.mjs` | Executable controls for the public `stageTrackedSource`, against a newly owned fixture Git repo: tracked UTF-8 bytes preserved, ignored sentinel absent, unsafe committed archive refused with the destination untouched, nonempty destination refused, non-Git root refused. |
| `attempt-audit-controls.mjs` | Executable controls for the exact subject/mode-argv proof: long TS subject + mode argv proven, truncation rejected, wrong subject / extra / missing / reordered mode arguments / unsuccessful exec / substring-only token rejected, and the `-s 65535` wrapper asserted. |
| `Dockerfile.audit` | `node:22-alpine` + `strace` + `openssl` (Linux-only audit tooling; `openssl` ships the libssl3 Prisma engines probe at runtime). Built with no host mounts; the run still uses `--network none --read-only`. |
| `fixtures/` | Task-owned adversarial fixtures (excluded from discovery): `net-attempt`/`write-attempt` (report the error), `net-caught`/`write-caught` (swallow it and exit 0), `help-ignored`. |

The controls above are pure policy/fixture checks that root runs — they do NOT
constitute physical Docker execution evidence. Real Docker execution and the CI
matrix are run by root.

## Isolation model

1. **Stage tracked source only.** The `git archive HEAD` bytes are materialised
   through the reviewed `materializeValidatedArchive` (NO host `tar`, NO MSYS
   `C:\...`→`/c/...` translation) into a FRESH EMPTY owned dir; the explicit safe
   runtime tool deps (`STAGE_TOOL_DEPS`, e.g. `tsx`) are copied in. Validation
   happens before any payload write; an unsafe entry, a nonempty destination or a
   non-Git root is refused with the destination untouched. Ignored `.env`/
   credentials and build output (`node_modules`, `dist`, `generated`) are **not**
   staged.
2. **Container boundary.** `--network none`, `--read-only` root and a read-only
   bind of the stage, `/tmp` tmpfs, disposable writable `/evidence`. The host
   environment is **not** inherited — only `NODE_ENV`/`CI`/`CLEANUP_SMOKE_ISOLATED`.
   **No full host drive, parent workspace, or user tree is mounted.**
3. **Owned container lifecycle.** Each run has an owned `--name` and a
   `cleanup-smoke.run=<runId>` label; the exact 64-hex id is captured (`--cidfile`)
   before start. Removal targets that exact id, and ONLY after verifying its
   exact id + label, and is proven by a single, fully-anchored Docker absence
   diagnostic naming that exact id. A mismatch, a generic/ambiguous/transport
   absence result, or a residual container fails closed. CLI timeout alone never
   leaves a container alive.
4. **The audit is authoritative.** `--network none` still has loopback, so any
   reach is an attempt; the strace audit records the attempt even when the script
   catches and suppresses the error. Denials of network / forbidden host writes
   are failures (`attempt-audit-network` / `attempt-audit-write`). The trace is
   taken with `-s 65535` so the full argv is available to the exact-subject proof.

## Documented CLI contract (per entrypoint)

There is **no universal "no-args exit 2 / `--help` exit 0"** policy. `contract.mjs`
DERIVES each entry point's documented contract from ITS OWN source, and the
runner asserts it per entry point:

- a documented **no-args usage branch that names an explicit `process.exit(N)`** —
  the no-args invocation must print usage and exit `N`. A branch with no named
  exit fails closed as `noargs-unresolved-exit`; a branch that is absent fails as
  `noargs-undocumented`. An arbitrary integer is never accepted.
- for error adapters, dedicated role settings and other control flow outside the
  conservative scanner, a leading source comment may explicitly document the
  isolated invocation: `@cleanup-smoke noArgsExit=2 helpExit=0` (help is optional).
  This states expected exits; it does not claim execution or printed usage.
  The runner still requires matching native exits, actual usage output, complete
  syscall evidence, no network or forbidden writes, bounded termination and
  container removal. Duplicate, malformed and contradictory declarations fail.
- a reachable, positive **`--help`** handler with a documented exit, asserted ONLY
  when the source has one. An entry point without a `--help` handler is not forced
  to exit 0.
- an **unknown flag** must be rejected (usage / non-zero), never silently accepted
  (`unknown-option-accepted`).

Fail-closed non-`ok` outcomes include: `attempt-audit-network` /
`attempt-audit-write` / `attempt-audit-unavailable` / `attempt-audit-timeout` /
`attempt-audit-no-definite-exit` / `attempt-audit-loader-only` /
`attempt-audit-container-residual`; `container-residual`; `setup-incompatibility`;
`timeout`; `spawn-error`; `signalled`; `no-definite-exit`; `missing-invocation`;
`entrypoint-not-executed`; `noargs-undocumented`; `noargs-unresolved-exit`;
`noargs-contract`; `help-contract`; `unknown-option-accepted`;
`declaration-discovery-mismatch` (`UNDISCOVERED-DECLARED-COMMAND`);
`unsafe-executed-no-attempt` (`UNSAFE-ENTRYPOINT`); `isolation-unavailable` /
`isolation-image-missing` / `stage-failed`; `empty-scope`.

## CI contract

The emitted evidence must satisfy the CI worker's
`scripts/cleanup-gates/lib/smoke-evidence.mjs` (`validateSmokeEvidence`)
**schema-v4** checks: complete runtime discovery equal to the result set,
per-result documented `noArgs`/`help` contract + real per-invocation `audit` +
hashed committed raw log, provenance via the `sha256-ls-tree-v2` fingerprint, and
an exercised isolation proof. A coordination proof
(`smoke-evidence-contract-proof.json`) validates the emitter's bytes against that
validator with a real filesystem ctx.

## Usage

```bash
node scripts/cleanup-script-smoke/run-smoke.mjs --root . \
     [--subject apps/api/scripts|root/scripts] [--limit N] [--timeout-ms N] \
     [--out report.json] [--raw-log-dir <dir>]
node scripts/cleanup-script-smoke/run-smoke.mjs --self-test
node scripts/cleanup-script-smoke/prove-boundary.mjs .
node scripts/cleanup-script-smoke/emit-evidence.mjs --root .
# pure controls (no Docker, no application subject on the host):
node scripts/cleanup-script-smoke/isolation-lifecycle-controls.mjs
node scripts/cleanup-script-smoke/archive-staging-controls.mjs
node scripts/cleanup-script-smoke/attempt-audit-controls.mjs
```
