# Case14 native pending setup — operator review

**BLOCKER — resolve ambiguous task-definition registration before execution.**

Scope: bounded review of the nine files listed in `evidence/input-manifest.json`; no source edits and no execution. This is not Case14 acceptance.

The native path is appropriately narrow: the input pins the existing fixture, ordinary T1 actor, expected plan digest and one candidate. The supplied production path rechecks the plan before claiming; the owner uses the existing pending `model_extraction` creation path; and the receipt/readback assertions exclude approval, recall and provider calls. The outer wrapper pins the API revision/image and input/script digests, makes single attempts, does not replay an uncertain run, reconciles a dispatched run by its unique `startedBy`/task definition, stops a found task, and verifies cleanup and journal preservation. Stale-plan failure occurs before the native claim/create path. The expected four native journal rows and receipt/current-owner comparison agree with the supplied implementation.

However, if `register-task-definition` takes effect but its response is lost, `td` remains unset. The `finally` block only records `REGISTRATION_OUTCOME_UNRESOLVED`; it does not discover and clean up the possibly registered revision. This correctly avoids replay but can leave an active task-definition revision, so owned-definition cleanup is not assured for an unknown registration outcome. Add safe reconciliation for that unique family/revision (without retrying registration), or otherwise resolve/document cleanup before running this operator.

No execute evidence is present: the plan readback says `NATIVE_PLAN_CAPTURED`, and the supplied cleanup record is for the separate plan task. Therefore this review establishes neither execution success nor fixture state/Case14 acceptance. Original approval, recall and human gates remain unchanged.