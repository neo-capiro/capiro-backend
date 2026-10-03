# Native case01 bootstrap preparation

**PREPARED ONLY. No script import or execution, journal operation, authentication, browser, DB, AWS, provider call, or repository edit was performed for this packet.** `node --check` is a syntax check only.

This is a bounded adaptation of the existing `run-controlled-read.mjs`, using its public conversation-readback and browser-request guards. `adaptation.diff` shows the exact changes. The auth/creation flow and cleanup are retained. The 20/72-only fixture/identity composition is replaced with the exact existing Pat/T1/Aster case01 setup receipt and native case01 owners; another case is never impersonated to bypass a gate.

## Fixed scope and ordering

- API source `5b086a6b47ffce5aa1b93bfe38f9c7b96e297642`; the only allowed subsequent source differences are documentation and the specifically identified orchestrator case46 test fixture correction. Root supplies the actual successful orchestrator source/build/digest and current web SHA. Clean local HEAD must equal the reviewed `operatorSourceSha`. Actual AWS/served checks remain native and mandatory.
- Case01/run `bd35c0f4-1604-4371-b7e9-a1338369e53f`, existing Pat standard user/T1/Aster, fixed original prompt selected inside `executeCase01LiveCapture`, no caller prompt/date/approval/effect input.
- Setup must have successfully completed the adjacent `case01-native-setup-v1` operator. Its exact six fsynced JSONL records, byte hash, binding, original fixture source map/seed/reset receipts, and reviewed rate qualification are cross-checked. This saved setup is not live authority.
- Reviewed rates remain pinned to byte hash `3531e09d…`, semantic hash `a1a17938…`, and original expiry `2026-10-04T05:29:01.587Z`. Require at least 30 minutes remaining at startup. Maximum is exactly $15, 500,000 tokens, 32 provider attempts. Typesafe JEV/NVIDIA remain unpriced; they are not enabled or newly qualified.
- Claim a fresh fixed output directory and the existing global per-case/run claim; fsync the claim. Adopt only the existing 20-event fresh journal through `adoptExistingFreshCaptureSpend`, then open and reserve through `openCaptureSpendAggregate`. Exact prefix `abe458973…`, authorization `e07822e8…`, $9.841281 prior cost, $20.158719 available, $30 aggregate, $15 case ceiling, and concurrency one are enforced. Adoption is read-only; the native reservation is the first journal write. No initialization, replacement journal, import, refund, reset, recovery, or older-journal mutation exists here.
- Verify the existing synthetic Clerk instance/user/org/member identity, create one short-lived sign-in ticket/session, and block browser application writes. Validate actual web/API/build identity; make one ordinary conversation POST, then verify that it is empty and exactly owned/scoped.
- Refresh the bearer once before capture and create the existing native Windows artifact storage. Call `prepareCase01LiveCapture` with the actual reservation object. Read its actual authenticated `admission.json` through that same storage and require the source/qualification hashes to match setup. The native execute owner then rechecks the identical live admission before its sole synthesis POST.
- Call `executeCase01LiveCapture` and persist its actual outcome **before** checkpoint or result assertions. That existing owner performs authenticated receipt joins, artifact finalization, and server-authoritative settlement in the same process. Do not call settlement again. Call `gradeCase01CapturedOutcome(outcome)` on that exact opaque outcome. No serialized object or arbitrary usage JSON can replace either capability.
- Retain native artifacts, grading, owned response screenshot, aggregate checkpoints, and fsynced execution history. Always revoke the created Clerk session and verify revocation, then close the browser. A sign-in acknowledgement without a returned session ID is marked cleanup-unconfirmed for scoped reconciliation.

## Review and execution prerequisites

Read `run-case01-native.mjs`, `adaptation.diff`, and the source hashes in `preparation-checkpoint.json`. Confirm all imports resolve to the same unchanged native modules in `C:/dev/main/meri-c1-20261002`, preserving their WeakMap capabilities. Check the exact helper APIs; there is no injected transport, provider, authority, or settlement callback.

Root must qualify/deploy the new images and approve the concrete current setup operation first. Preserve the complete raw setup JSONL (not CloudWatch wrapper lines); its final result is not enough by itself. Fill a **new** scope file from `scope-input.template.json` with actual immutable build readbacks, actual current web/source identity, private manifest byte hash, and absolute setup JSONL path/hash. Null placeholders deliberately fail before journal/auth work. Keep the private manifest and credentials outside evidence; the script records only their nonsecret hashes/IDs as already required by the existing owner. The Clerk secret uses the existing authorized runtime environment and is removed from child-process environment before Git/AWS/browser processes.

The explicit future command is:

```powershell
node C:/dev/main/outputs/meri-c2-20261003/case01-native-bootstrap-v1/run-case01-native.mjs --execute-original-case01-once --scope <ABSOLUTE_REVIEWED_SCOPE_JSON> --manifest <ABSOLUTE_EXISTING_PRIVATE_MANIFEST> --out C:/dev/main/outputs/meri-c2-20261003/case01-native-bd35c0f4-1604-4371-b7e9-a1338369e53f
```

This command has **not** been run. Retain stdout/stderr and the process exit code externally, including failures before an output directory exists. Do not use a different output path, delete the claim, or rerun after failure. No automatic paid retry exists.

## Failure and acceptance limits

Each execution snapshot is appended and fsynced before rewriting the convenience summary. Conversation intent precedes its only POST. HTTP status, release, byte length and body hash are retained before HTTP/JSON assertions; auth credentials are not logged. Failed native outcomes are preserved before later checks. Native transport artifacts retain their own failure evidence.

If reservation succeeds but later auth/admission/capture fails, the existing journal may retain the full $15 reservation/active run. This script does not refund or fabricate a settlement. Unknown charges and older unresolved costs remain unresolved. If a native result is uncertain or a checkpoint write fails, keep all prior evidence and perform read-only reconciliation before a separately reviewed action.

Deterministic PASS remains `HUMAN_ADJUDICATION_REQUIRED`; `fullFile01Acceptance` stays false. A screenshot and bootstrap success do not establish the full original suite. No setup, immutable image, live semantic-clock receipt join, provider accounting, or original case acceptance has been demonstrated by this preparation.

The existing native case01 owner retains one bearer for the capture and exposes no refresh callback. The bootstrap obtains a fresh token immediately before preparation. Expiry during a long turn stays a blocked/uncertain native result; this packet does not add a transport or authentication bypass.
