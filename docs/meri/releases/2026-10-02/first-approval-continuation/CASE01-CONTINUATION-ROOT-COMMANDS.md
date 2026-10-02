# Fixed case01 continuation operator

Prepared only. Parent owns release and execution. Do not use the older recovery
commands again. Both historical STARTED claims and all failed task artifacts
remain unchanged. No new roles, grants, fixture run, or budget installation.

Wrapper: `case01-continuation-oneoff.py`, SHA256
`040e448a656e17a8c9e9d99cd8c97a74c7ef3ace51be3517e383520ee697785e`.
Requires the four exact source blobs from continuation commit
`40e01fbca613c1bd1fc78643c81134fc31501293` and enum fix `c72269b40`.
The image must be built from clean canonical main, qualified, and currently
serving. Existing c22 and 975 images lack the continuation and must be refused.

Use the configured SDK Python and C-drive main. All output files below are new
and exclusive in this directory. `PROOF` and `PROOF_HASH` mean the actual future
API build proof and its independently reviewed file hash, never placeholders
passed to the tool. Current generic one-off confirmation remains
`RUN_ONE_REVIEWED_CASE01_TASK`.

1. Local-only `materialize-plan-input --mode setup-continuation-plan` creates
   `case01-continuation-plan-input.json` from the exact original recipe plus
   original/recovery claim hashes and pending xmin in the verified enum-v2
   readback. It performs no AWS call and does not invent a current plan.
2. `prepare --mode setup-continuation-plan --repo C:\dev\cap-meri-outcomes-validation
   --proof PROOF --proof-sha256 PROOF_HASH
   --input <this-directory>\case01-continuation-plan-input.json
   --input-sha256 <actual newly created input hash>
   --out <this-directory>\case01-continuation-plan-task-plan.json`.
   This is AWS read-only and binds current image, task, network, roles, and source.
3. Review then `run` with the same arguments, `--plan` pointing at that task plan,
   `--plan-sha256` its actual canonical planHash, `--confirm RUN_ONE_REVIEWED_CASE01_TASK`,
   and `--out <this-directory>\case01-continuation-plan-execution.json`.
   The single plan task reads actual canonical state and current reviewer rights.
4. Only after VERIFIED exit0, locally materialize execution input with
   `materialize-execute-input --mode setup-continuation-execute
   --owner-plan-execution-sha256 <actual reviewed plan-execution file hash>`.
   This creates `case01-continuation-execute-input.json` using the actual owner plan.
5. Repeat prepare/review/run using mode `setup-continuation-execute`, that input,
   `case01-continuation-execute-task-plan.json`, and
   `case01-continuation-execute-execution.json`. Execute revalidates the actual
   prior plan task, definition, image, command, exit, and log receipt before it
   can register/run the one continuation task. Canonical source repeats its
   same-transaction state checks and CAS admission before first approval.

The final owner receipt must contain all nineteen expected journal entries,
ending SETUP_COMPLETE with exact case01 physical source/version binding and an
owned empty conversation. This remains LIVE acceptance NOT_RUN. Any unknown
outcome, timeout, changed version, failed task, or partial journal requires
reconciliation; never rerun, reset a claim, or create replacement input to retry.

After successful setup, derive a new budget plan and actual CAS installation
from this continuation's final receipt. The earlier budget materializer still
pins the failed recovery completion path; it must not be used unchanged.
