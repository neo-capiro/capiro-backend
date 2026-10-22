# Meri migration audit at published51e265bd

Read-only findings. All eight names are absent from Fable’s546FINISHEDset. No DB or runtime environment was inspected.

| Migration | Header | Decision | Reason |
|---|---|---|---|
| 20281018010000_clio_meri_approval_decisions | Normal creation; no source-only/reserved declaration (SQL:1-3) | RETAIN_UNGATED_CONSUMER | NativeApprovalService.record/decision/revoke and storeOnce read/create decisions. decision also reads revocations from040000. Mounted NativeApprovalModule at app.module.ts:102; /clio/approvals/native record/decision/revoke at native-approval.controller.ts:17-42. Service authentication and ownership checks are not feature-off gates. |
| 20281018020000_clio_meri_memory_submissions | Normal W8 receipt creation; no source-only/reserved declaration (SQL:1-6) | RETAIN_UNGATED_CONSUMER | MeriMemoryReceivingModule mounted app.module.ts:105. /clio/memory/review/submit and /review/status (controller:14-31) directly read/create receipts after service identity and tenant checks. submit create omits candidate, so020000 alone with candidate NOT NULL is incompatible with current writer;090000 supplies nullable compatibility. |
| 20281018030000_clio_meri_routine_authority | DRAFT; reserved and NOT applied (SQL:1-4) | HOLD_MOVE_TRANSITIVE_DEPENDENCY | Direct cancellationProof consumer is gated by optional MERI_ROUTINE_CANCEL_SIGNER before SQL (service:199-203), then uses approvals and cancel proofs212-225. Module mounted app.module.ts:103; route routines.controller.ts:32-36. |
| 20281018040000_clio_meri_execution_authority | reserved and NOT applied (SQL:1) | HOLD_MOVE_UNGATED_CONSUMER | NativeApprovalService.decision queries clioMeriApprovalRevocation; revoke writes it; record calls revoked. NativeApprovalModule is mounted app.module.ts:102, native-approval.controller.ts:17-42. These occur without execution signer check. Execution issuance separately rejects missing signer at native-execution.service.ts:134-137, which does not protect revocation paths. |
| 20281018050000_clio_meri_routine_unattended | reserved and NOT applied; runs after030000 (SQL:1-2) | HOLD_MOVE_UNGATED_CONSUMER | Mounted /clio/routines/policy/check -> policyCheck -> routineConsentEvent -> recordConsentEvent. For approved cancel_scheduled_task pause/delete, policy allows no configured maxima and consent event returns revoke before limits check. recordConsentEvent inserts clioMeriRoutineConsentRevocation without fire/cancel signer. Fire grant route separately checks optional fireSigner before SQL. |
| 20281018060000_meri_read_delegation | reserved and NOT applied (SQL:1) | ELIGIBLE_UNDER_SOURCE_DEFAULTS | ReadDelegationModule mounted app.module.ts:104. CreateAttended/createUnattended/issueToken/revoke/createConsent/setConsentState all invoke service() which refuses absent signer before SQL. Incoming delegated-token middleware calls admitMeriReadToken which requires same key config before any transaction. current requires an admitted request grant. Memory helper/page/proposal consumers are hardcoded off. |
| 20281018080000_clio_memory_scope_unique | Forward schema repair / conditional source migration; explicit target ledger, CHECK, old index and duplicate readback prerequisites (SQL:1-6), not reserved-NOT-applied wording | RETAIN_PENDING_TARGET_FACTS | Existing clio_memory client/firm consumers are active independently of this new migration. Meri submit checks keys with clientId bound to candidate scope (receiving.service:140-145). Candidate commit creates clioMemory with scope/owner/client/key (memory-candidate.service:1233-1244). Migration fixes uniqueness granularity; it adds no new runtime table/column. |
| 20281018090000_clio_meri_memory_submissions_content_free | Stage1compatibility only; header explicitly not payload erasure and requires targetledger/table readback first (SQL:1-11) | RETAIN_UNGATED_COMPATIBILITY_DEPENDENCY | Current ungated receipt submit creates only tenant,candidateId,candidateSha256,proposer,reviewId and omits candidate (service:121-126), requiring candidate nullable. SQL only DROP NOT NULL at206-207; does not drop candidate or remove existing payload. |

## 20281018010000_clio_meri_approval_decisions

None for native record/decision/revoke; execution signer does not gate those routes.

SQL dependencies: 040000 revocations and issuances FKs reference this decisions table (040000 SQL:27-30,57-60).

Live facts/limits: Ledger absent. Meri table/catalog existence and definitions not supplied by Fable; absence from ledger is not absence from schema.

References: apps/api/src/meri/native-approvals/native-approval.service.ts:56-105, apps/api/src/meri/native-approvals/native-approval.service.ts:130-173

Blob: c465bee1972edcdebb7e13e079f7050837ce56c4; SHA256: 23c42f67a06755f70868e9232de58a6b692f1be2bbee9b95455a3cc1c3f50714

## 20281018020000_clio_meri_memory_submissions

No feature-off gate for receipt submit/status. Separate MemoryPurgeController path IS gated by MEMORY_PURGE_ENABLED (memory.controller.ts:561-564); do not treat purge service as ungated route.

SQL dependencies: 090000 requires this FINISHED ledger row, exact accepted checksum, and original table shape before DROP NOT NULL (090000 SQL:26-35,55-90,206-207).

Live facts/limits: Receipt table shape/checksums not supplied; cannot assert020000 creation is collision-free. Retain020000/090000 relationship; propose reviewed forward plan if target differs.

References: apps/api/src/meri/memory-receiving/meri-memory-receiving.service.ts:112-126, apps/api/src/meri/memory-receiving/meri-memory-receiving.service.ts:212-225, apps/api/src/meri/memory-receiving/meri-memory-receiving.service.ts:290-293

Blob: aa720c7ae035eb1ade94e46b149e0922fbbb00e7; SHA256: 090b3140156c8cb40630101e6fd3b8bb5135a846a6d79528fa2fc4d523f0c2c5

## 20281018030000_clio_meri_routine_authority

All four cancel signer values absent => config null; cancellationProof503 before data reads. This is not enough to move this migration because retained050000 depends on it.

SQL dependencies: 050000 SQL:14 ALTER TABLE clio_meri_routine_approvals DROP CONSTRAINT clio_meri_routine_approvals_unattended_fence.050000 must stay while its ungated revocation consumer is unresolved. Moving030000 alone breaks deploy order.

Live facts/limits: No Meri live table catalog evidence supplied; do not run or modify SQL.

References: apps/api/src/meri/routines/meri-routines.service.ts:199-225, apps/api/src/config/config.schema.ts:810-813, apps/api/src/auth/core-ed25519-key-config.ts:31-38

Blob: 0dcc7927c7ca391c4d34e5a144d1d80721495b4b; SHA256: 3bc316dff996fe1cc1ca11944dfd2d5a711f91ba30c91d110b6e463fa666ed53

## 20281018040000_clio_meri_execution_authority

None for decision/revoke/record-revoked; MERI_EXECUTION_SIGNER absent gate protects only execution issuance/receiver, not all newly-created tables.

SQL dependencies: Depends on010000 decisions via FKs SQL:27-30 and57-60; consumptions FK issuances internally SQL:85-86.

Live facts/limits: Live Meri catalog unknown. Ungated consumer finding must be resolved by owner; do not move migration or add gate in this task.

References: apps/api/src/meri/native-approvals/native-approval.service.ts:90-105, apps/api/src/meri/native-approvals/native-approval.service.ts:130-156, apps/api/src/meri/native-approvals/native-execution.service.ts:134-137

Blob: 2372b6b9a22b3046231885adec6a7882d38acf6c; SHA256: 3e2ba9705bc560164636df418d4d612c49630a59a915bcd15067caab739010a1

## 20281018050000_clio_meri_routine_unattended

Policy maxima missing => create/update schedule503, but cancel is not mutation for that check and returns revoke; absent fireSigner only gates unattendedGrant. Authentication/approved exact binding are required, but not feature-off gates.

SQL dependencies: SQL:14 requires030000 approvals table. fire grants FK consents internally SQL:76-77. Hold030000 along with050000.

Live facts/limits: Live Meri catalog unknown; actual runtime calls not observed, only statically reachable guarded consumer.

References: apps/api/src/meri/routines/meri-routines.controller.ts:19-29, apps/api/src/meri/routines/meri-routines.service.ts:63-78, apps/api/src/meri/routines/meri-routines.service.ts:86-118, apps/api/src/meri/routines/meri-routine-policy.ts:28-39, apps/api/src/meri/routines/meri-routine-policy.ts:102-110, apps/api/src/meri/routines/meri-routine-firing.ts:151-165, apps/api/src/meri/routines/meri-routines.service.ts:133-142

Blob: 889e9f1830f29c8e25d2bcbc7b79e3eedaf3f45a; SHA256: 734d3ec7e004e14dd14c511f3a485d91b81aed46d2f5648fe479ef5669472a74

## 20281018060000_meri_read_delegation

Four MERI_READ_DELEGATION_SIGNER_* fields optional; all absent => null =>503 before DB. Partial/invalid config also caught =>null. Signed memory transports hardcoded false, not env-enabled. RETAINED_READS_ENABLED is NOT the gate for ordinary Meri delegated reads; signer config is.

SQL dependencies: All FKs internal to the four tables (SQL:24,61-62,91,122-123); all23pending SQL checked, no other pending SQL references these tables.

Live facts/limits: No target/deployed-env readback performed; recommendation is based on source defaults. Actual preview signer configuration must remain absent/disabled. Meri table existence not supplied.

References: apps/api/src/auth/read-delegation/read-delegation.service.ts:68-74, apps/api/src/auth/read-delegation/read-delegation.service.ts:103-117, apps/api/src/auth/read-delegation/read-delegation.service.ts:201-212, apps/api/src/auth/read-delegation/read-delegation.service.ts:295-312, apps/api/src/auth/read-delegation/read-delegation.service.ts:345-354, apps/api/src/auth/read-delegation/read-delegation.controller.ts:89-94, apps/api/src/auth/read-delegation/read-delegation.controller.ts:114-125, apps/api/src/auth/read-delegation/read-delegation-request.ts:242-261, apps/api/src/auth/core-ed25519-key-config.ts:31-38, apps/api/src/config/config.schema.ts:818-822, apps/api/src/auth/read-delegation/signed-memory-http-gate.ts:6-10, apps/api/src/meri/memory-receiving/meri-memory-helper.controller.ts:21-24

Blob: 2a6613edfb3380a04bb3f0dadc00b0c24f45f5bc; SHA256: f6f6cf95c67ba0b3b1cf15191297989fe33111d4b4e370ad0118f91740a4fabe

No literal20281018060000 reference found in fully-readable apps/api/src (including read-delegation specs). Broader scripts/test grep was incomplete due unavailable sparse blobs; cannot certify no path-bound tests outside source. Did not edit tests.

## 20281018080000_clio_memory_scope_unique

Meri memory receiving routes have no feature-off gate; existingclio_memory remains needed. New index requires target facts, not merely feature flags.

SQL dependencies: Requires existing clio_memory and exact pre-client unique index from applied20260705120000_clio_memory_firm_dedup_unique (FINISHED). SQL:16-31 old-index shape;35-65invalid shape/duplicates;69-80index replacement. No pending prerequisite.

Live facts/limits: Fable supplied FINISHED set but no clio_memory CHECK/index/duplicate catalog facts. Cannot assert safe runnable status or propose changing/removing checks. No dedup/delete is authorized.

References: apps/api/src/meri/memory-receiving/meri-memory-receiving.service.ts:140-145, apps/api/src/memory/memory-candidate.service.ts:1233-1244

Blob: 72c1477579dbd23512c6ef7354702eb78dd13240; SHA256: 07d4b52ee712a4e0d302aef3c463d55b983c9a3b1d735d87d31a0c905ade2f9a

## 20281018090000_clio_meri_memory_submissions_content_free

Receipt submit/status no feature-off gate. Separate purge execution remains held by exact content-free shape (six columns) and MEMORY_PURGE_ENABLED;090000 retains seventhcandidatecolumn, so does not authorize/enable purge.

SQL dependencies: Mandatory exact020000FINISHED row/checksum SQL:26-35; exact old receipt columns55-90 and constraint/trigger/RLSpolicy checks119-199.020000+090000mustbe considered together.

Live facts/limits: 020000 and090000 absent FINISHEDledger; no historical rolled-back-only names. Receipt table shape/checksums remain unknown; if already/failed or mismatchedshape stopforownerforwardplan, no assertion loosening.

References: apps/api/src/meri/memory-receiving/meri-memory-receiving.service.ts:112-126, apps/api/src/meri/memory-receiving/meri-memory-receiving.controller.ts:14-31, apps/api/src/memory/memory-purge.service.ts:22-29, apps/api/src/memory/memory-purge.service.ts:90-113

Blob: 9db45c14f097ca7f83add069fa137bbabd04a54d; SHA256: f9d2f4a13474a1af97afdd9b5b8587a6e27e90a36d07fdd1e6f30344bb595c51

