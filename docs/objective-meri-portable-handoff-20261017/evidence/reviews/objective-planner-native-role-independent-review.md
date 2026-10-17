# Independent restricted-role native proof correction review

Reviewer: `/root/independent_source_review`, independent of the implementation authors. Completed **2026-10-17 01:31:37 UTC**. Source/index review and focused checks were read-only. This receipt is outside the repository. The reviewer performed no source/index/driver edits, publication, enabled native execution, SQL, credential creation or privilege changes.

**Decision: ACCEPTED for source-only draft publication. No remaining source findings in final tree `27cd4e6aa46fecf7fcc9fb860870e9e97ae73983`.** The exact successor's enabled native result remains pending; normal execution approval and owned-target safeguards remain required.

## Exact candidate

- Parent/current HEAD: `a82e49b1d6c0949b898b914840ece813008fe2e7`.
- Parent tree: `088c06dba115e7527ca4c81234f71287a2fb672e`.
- Reviewed staged tree: `27cd4e6aa46fecf7fcc9fb860870e9e97ae73983`.
- Delta: **9 files, 111 insertions, 8 deletions**.
- Packet `native-role-reviewed-source.json` SHA256: `3cb160503eec66c54f9d6a9846b86dcc21a78569f866fc636a30c8de64d6a4a6`.

The reviewer independently recomputed all nine UTF-8 Git blob hashes and matched their modes/types/paths to the index. Parent/base-tree/tree metadata match Git; index equals this reviewed tree; tracked working source equals index; cached whitespace check passes. The superseded pre-strengthening packet `native-role-reviewed-source-superseded-125e66.json`, SHA256 `88e065e0dff45218522aee89e24c0d955b4d5b51d33dfa3135c8deda02ffc62a`, is preserved and invalid for publication. No receipt accepted that superseded tree.

Production changes are confined to the two owned applied/historical consent-proof query modules. Three existing proof/status specs update their expected row-lock targets; one native fixture query and the existing native Core spec are corrected/extended; two documents record the real restricted-role failure and qualification boundaries. No migration, grant, immutable trigger, central kernel, module, issuer, HTTP or shipping source changes are included.

## Independently identified native defect

The reviewer read `objective-planner-native-evidence/0f0d742263cd40689cf6b0bcff4e2c53`. Manifest source is parent `a82e49b1`. Its schema-2 ownership guard passed; the log records **13 offline preflight checks passed**, all **12 existing enabled runtime cases passed**, and three of the six new Core cases failed: **16 passed / 3 failed / 19 total**, including default-off. This is a partial failed run, not final native Core qualification.

The sanitized PostgreSQL log records permission denial on `client_objective_work_intents`, followed by an aborted transaction. The new production proof joins requested row locks on immutable intents/revisions; the new native regeneration helper also requested locks on immutable consents/receipts. Exact migration source intentionally revokes UPDATE/DELETE on those ledgers. PostgreSQL requires UPDATE privilege for locking SELECT clauses, including SHARE and KEY SHARE ([official PostgreSQL 16 SELECT permissions](https://www.postgresql.org/docs/16/sql-select.html)). Thus the failure exposed a real restricted-role source incompatibility that synthetic SQL ports did not establish.

The failed run's cleanup record reports exact cluster/listener removal and retirement of disposable credentials. The inspected command log contains no credential-bearing URL, password assignment or generated 96-hex disposable secret. Passing denial cases in a partially failed run are not used to infer that every intended positive proof path worked.

## Source correction and security assessment

Both production queries now end with `FOR SHARE OF m,u`. They retain mutable membership/user locks and every existing tenant/client/Objective/control/consent/actor/Clerk/source join, full JSON/identity/receipt/hash/timestamp validation and immutable original operation checks. Only the unsupported locks on immutable `i,v` were removed. The existing Planner/Core gates and current authority checks remain unchanged; original immutable lineage is read plainly under the same transaction and append-only custody contract. This does not turn historical identity into current authority or authorize another effect.

The native regeneration fixture retains `FOR UPDATE OF ctl,p` and removes unsupported locks on immutable `cs,r,i,v`; its complete reciprocal receipt/source validation remains unchanged. No UPDATE rights, table-owner membership, superuser, BYPASSRLS, trigger disablement, migration or broader fixture privilege is introduced. The native suite now explicitly asserts table-level UPDATE/DELETE privileges are false for all four immutable ledgers before positive Core reads.

All six earlier native test expectations remain intact. The seventh case exercises an actual committed lease, actual Core cancellation/control version 2, actual runtime terminal cancellation with the same original operation identity/deadline, actual new Core consent/control version 3, then actual Core retained read through the historical native lineage proof. It checks unchanged old consent/command/resource records and real canonical output absence. This is a prepared genuine native history flow, not a fabricated terminal label.

The final v3 regeneration case is also strengthened: after actual new application, it reads through the actual Core WorkService using the real latest command request ID and requires accounted status, the advanced ready revision, latest control/consent and consent terms, the exact original command receipt, and unchanged audit records. This specifically qualifies the complete new/old applied ancestry through Core when executed. Its enabled result is not assumed in advance.

## Focused verification

Independently executed against the frozen source:

- Applied native-consent source proof: **34/34 passed**.
- Historical native-consent source proof: **44/44 passed**.
- Actual Core WorkService status regression: **30/30 passed**.
- New schema-2 regeneration native-helper source fixture: **7/7 passed**.
- **Total 115/115 source checks passed**, zero source failures/skips.
- Strict complete native Core import graph passed after the final v3 assertion change.
- Final packet/index/worktree and whitespace checks passed.

The author separately collected the seven enabled-only cases with opt-in absent and diagnostics enabled: all seven skip without native execution. The coordinator separately reran the affected concrete-owner source suite: 111/111 passed. These are distinguished from this reviewer's executions and from enabled native outcomes. Broad 181-case tests were not redundantly rerun here.

The SQL expectation edits in the three existing specs do not remove any lineage, corrupt-input, current-proof, temporal or replay cases. They preserve the mutable row-lock requirement and prevent reintroducing immutable lock targets. The native role assertions and positive SQL paths provide the missing database privilege evidence when executed.

## Procedure and remaining evidence boundaries

The reviewed driver is unchanged at SHA256 **`717bade635a69fd71a425eff35ffd821da569277d3f2de520005b49bec6af5c5`**. Its independent schema-2 exact-startup-clock review remains preserved. The same exact 38 SQL selections, PG16.15, non-owner/non-superuser/non-BYPASS runtime role, owned loopback 56455/planner_qa target, source-pin/clean-checkout checks, budgets, fresh resource checks, secret redaction and exact owned cleanup controls remain in force. There is no runner/role workaround for the permission failure.

The coordinator must publish/import this exact reviewed source as H3 and execute the normally approved procedure with that exact pin. The expected enabled suite now contains 12 existing runtime cases plus seven Core cases and one ordinary default-off case. The final result must name H3 and be checked with cleanup; this receipt claims no enabled success.

Request-local proof admission, the separately seeded Strategy-generation consent and Meri/provider custody observations remain explicitly synthetic. HTTP/JWT/session/protected issuance, an operational Strategy retry/SDK path, frontend receiving, full Core migration replay, deployment and real network commit-ack failure remain outside this qualification. The immediate post-consent public-status uncertainty with an older applied head remains documented. No AWS or application database changes are involved.

**Final verdict: the source-review prerequisite is met only for exact tree `27cd4e6aa46fecf7fcc9fb860870e9e97ae73983`; no remaining source findings. Full enabled native qualification of the final successor is still pending.**
