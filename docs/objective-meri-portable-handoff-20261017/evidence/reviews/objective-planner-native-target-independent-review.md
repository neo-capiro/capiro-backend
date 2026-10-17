# Independent native startup-clock correction review

Reviewer: `/root/independent_source_review`, independent of the authors. Completed **2026-10-17 01:20:31 UTC**. Repository source/index review and checks were read-only. This separate receipt is outside the repository; no source, index, driver, credential or database was modified by the reviewer.

**Decision: ACCEPTED for source-only draft publication. No remaining findings in exact three-file tree `088c06dba115e7527ca4c81234f71287a2fb672e`.** Enabled native qualification of the successor remains pending; this source review does not override normal approval.

## Exact source

- Parent/current HEAD: `3ebecd93f3d5a99e1d9346b2710a3605591ed9d3`.
- Parent tree: `bbd05d049b8f2d355af9d36e3ed4bb0cdb2c4391`.
- Reviewed staged tree: `088c06dba115e7527ca4c81234f71287a2fb672e`.
- Delta: **3 files, 99 insertions, 10 deletions**: native-target pure guard, its focused tests and `NATIVE-QUALIFICATION.md`.
- Packet `native-target-reviewed-source.json` SHA256: `46794103b19b279e197797702b204f7eefbc346082752cf31f70f8f06bb9c2b3`.
- Guard SHA256: `ceed0bd047a40971bd68c861c1704dceb4142fa184e132171c6bea36305d38b3`.
- Focused test SHA256: `05d0411499193ae2d411ea5adf3740d119165a4898b45e6155c96de600b10ab9`.

All three packet UTF-8 blob hashes, modes, types and paths were independently recomputed and matched to the index. Parent/base-tree/tree metadata match Git; index equals the reviewed tree; tracked working source equals index; cached whitespace check passes. No production application/kernel, migration, runtime authority, module or shipping source is changed.

## Failure evidence and cause

The reviewer independently read the failed final-source attempt at `objective-planner-native-evidence/06b740e91e434629ba943bb6cf977ded`. Its source/manifest identifies parent `3ebecd93`. The command log reports **13 offline preflight checks passed**, then **18 enabled native cases failed at the read-only catalog ownership guard**, with the ordinary default-off case passing. The suite's beforeAll guard rejected before fixture writes; schema/role setup had already executed. There is no successful-outcome artifact. `cleanup.json` records exact cluster/listener removal and credential retirement. The inspected command log contains no credential-bearing URL, password assignment or generated 96-hex disposable secret.

The PID-file observation records startup second `1792199789`; the PostgreSQL log starts at `2026-10-17 01:16:30.046 UTC`. PostgreSQL 16.15 stores `MyStartTime` in the PID file and assigns the separate `PgStartTime` later in startup. The prior cross-clock equality could therefore reject a genuine owned cluster when startup crossed a second. This explanation is supported by the official [PID-file source](https://github.com/postgres/postgres/blob/REL_16_15/src/backend/utils/init/miscinit.c) and [postmaster source](https://github.com/postgres/postgres/blob/REL_16_15/src/backend/postmaster/postmaster.c), independently inspected by the reviewer. The failed attempt is refusal evidence, not application qualification.

## Guard correction

Manifest schema 2 requires a distinct positive safe-integer `catalogPostmasterStartedAtSeconds`, in addition to the original PID-file timestamp. Closed shape validation rejects old schema 1, missing/extra properties, accessors, proxies and invalid values. Chronology requires `PID-file time <= catalog time <= manifest creation`; existing current/expiry bounds remain unchanged.

The filesystem/PID guard still checks its original timestamp exactly. The connected catalog guard checks the independently captured catalog timestamp exactly. A catalog timestamp substituted for the PID timestamp, the reverse substitution, and an off-by-one catalog observation are all rejected. There is no tolerance, wildcard timestamp, timestamp adoption or fallback to the old schema. Exact source, realpaths/data directory, PID liveness, role, database/OID, port, random ownership comment and restrictive-role checks remain intact. The module still performs no filesystem/process/network/SQL action itself and remains inert without opt-in.

## Independent checks

- **83/83 focused pure guard tests passed**, zero failures/skips.
- Strict complete native Core import graph passed with no diagnostics.
- Equality, +1/+30-second independent start values, exact cross-substitution refusal, malformed/missing/nonfinite/unsafe fields, accessors/proxies, reversed/future ordering and old schema refusal are explicitly covered.
- Exact packet/index/worktree checks and `git diff --cached --check` passed.
- A second read-only reviewer independently found no actionable source/test gaps. No duplicate broad kernel tests or enabled native run was performed.

The previously accepted kernel packet and receipt were rechecked unchanged at SHA256 `a4d5772f47f35ff4bae935a09249f0318328e7ecf299a2ffb7f211b02c02cdfd` and `33daec3d5518815006924ce09ce1d88f1a57069d4877fdea6b9c8e3f83a69fc7` respectively. Prior publication and source review remain preserved; no failed native result is relabeled as success.

## Driver delta

The reviewer independently diffed and parsed frozen `run-isolated-sourceplan.ps1` at SHA256 **`717bade635a69fd71a425eff35ffd821da569277d3f2de520005b49bec6af5c5`** against preserved approved `run-isolated-sourceplan-approved-9efbac.ps1`, SHA256 `9efbac079c8525a221939749b95e5149e828cf3ccdbdf0f1006b47cc591d0c4e`. PowerShell syntax passes.

The only functional addition is one read-only bootstrap query for the exact floor of `pg_postmaster_start_time()`, positive-digit validation, and recording it as a separate schema-2 manifest field. The original PID-file timestamp remains independently recorded. The same 38 SQL selections, PostgreSQL 16.15 installation, restricted owner/runtime roles, loopback port 56455/database planner_qa, source-pin/clean-checkout checks, budgets/fresh pre-init resource checks, preflight, credential redaction and exact owned stop/removal controls remain unchanged. No new migration unit or application credential/authority path is introduced. The reviewer executed neither Plan nor Run mode.

The coordinator must publish/import this exact reviewed source as H2, then use its exact pin through the normal approved procedure and fresh resource window. Any enabled result must be tied to H2 and checked alongside owned cleanup. HTTP/token admission, the separately seeded Strategy-generation consent and provider/SDK custody boundaries from the preceding receipt remain unchanged.

**Final verdict: no remaining source findings; the reviewed-source prerequisite is met for exact tree `088c06dba115e7527ca4c81234f71287a2fb672e`. No enabled native success for that successor is claimed by this receipt.**
