# Original File01 evaluation prerequisites

Integration source: `9b8fc56088ad3c60397e56096f2df4072626690d`.
Local qualification: **PASS**. Original live acceptance: **NOT RUN**.

The integration combines selected canonical memory seeding, atomic capture binding,
the actual case01 memory lifecycle, and native Windows artifact storage. It also
fixes an existing immutable-memory forget path that cast `UUID~v...` as a UUID.
No public fixture route, runtime profile, database schema or live configuration
change is included. The lifecycle wrappers retain ordinary governance and the
exact approved synthetic namespace; their presence is not permission to run seeds.

Case01 local tests execute actual proposal, separate review, correction,
supersession, pending/revoked/other-client states, canonical retirement and reseed.
They verify all five required memory sources and real lineage/audit/outbox state.
Capture binding uses a tenant-row lock, current actor/client/source qualification,
and row-version/hash compare-and-set while retaining unrelated tenant settings.
These receipts describe case01's five-source scope, not the complete75-case corpus.

Native storage uses Windows NTFS handle-relative operations, exclusive new files,
current owner/ancestor/file identity checks and byte-hash readback. It refuses
reparse points, hard links, replaced ancestors, competing handles and crash residue.
The capability is process-local and has no serialized adoption or path fallback.
It is not WORM protection against an administrator/kernel compromise. The portable
LIVE guard remains in place when a qualified native capability is absent.

## Independent integration results

- 126 Node tests passed,0 failed,0 skipped; actual PostgreSQL and NTFS exercised.
- 5 API Jest suites,64 tests passed,0 failed.
- Full API typecheck, including every configured subproject:exit0.
- Deterministic Promptfoo26/26 and custom verifier:both exit0.
- All22 final source blobs independently match reviewed commit bytes and recorded
  candidate hashes, accounting only for Windows line endings.
- Actual Hermes/Bedrock Kimi reviews passed for each lane. Root additionally
  reviewed the single post-Kimi `ORDER BY id` deterministic locking delta; the
  two lifecycle regressions were repeated successfully after that delta.

Commands, exits, original log hashes, source hashes and reviews are saved beside
this document. The source commits before cherry-pick were `5cf3c2411`, `0a8e08848`,
`8617d0329` and `49abbad62`. The integration commits are `c59889bf9`, `b823f7689`,
`4f390bed3` and `9b8fc5608`. Failed Qwen drafts and initial environment failures
remain identified in the lane qualifications; their summaries are not acceptance.

## Remaining composition

The original live evaluator still needs the restart-safe canonical fixture owner,
provider reservations covering pre-context embeddings and every later attempt,
and authenticated capture admission/current source readback. Those changes remain
separate work. Existing guards must not be bypassed just because storage and
fixture tests pass. No original LIVE case has been run by this integration.
The API image currently rolling out is the earlier signed-receipt source4aad;
these later prerequisites are not claimed deployed.

Raw offline reports remain outside the repository as required by the original
plan, under `C:\dev\cap-meri-foundation-evidence\oct02-original-eval\integrated-prereqs\offline`.
The committed summaries and exact report hashes support remote handover. Earlier
reply-only and signed-receipt raw JSON/JUnit report copies were removed from the
current tree; their originals remain in the respective local evidence directories,
and historical index hashes remain valid. No credentials or live session state
are included. Shared policy SHA: `39590a3bfc57ce03b0411ff7912a7c8d99deb70c`.
