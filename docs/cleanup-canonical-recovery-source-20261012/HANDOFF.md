# Canonical migration-source reconciliation, 2026-10-12

This source followup closes the two static migration-policy conflicts in composed
draft PR2411 `fa28aa3945be41c31463d669940d17fb32968f3d` (tree
`5f19312c29e4ed4997a8724e415ecdb37fb88772`). Accepted integrated implementation is
`577bddc91784eb27f68f19f2feea8e93fe5e2829`, tree
`36010242e323610ccb26d2394a90a708c962680e`. Later commits add evidence/docs only.
The exact seven source paths and two current runbooks are in SOURCE-MANIFEST.json.
No entrypoint, migration, schema, API route, DTO or deployment behavior changes.

The earlier blanket source guard conflicted with Neo's approved explicit recovery
aliases (f06cdced / PR816) and the later exact Phase A contract (a966a263). The
existing canonical migration-guard owner now proves the complete raw source
protocol before recognizing the existing manual arms. No command is retired,
restored or executed; automatic recovery remains forbidden.

## Canonical source contract

The three supported snapshot paths must be unique and complete. Their committed
literal SHA-256 values attest raw UTF-8 after CRLF to LF only, including comments:

| Snapshot | Raw LF-normalized SHA-256 |
| --- | --- |
| `scripts/entrypoint.sh` | `14be0fc411f171ce5f372870172ec5c01cc48953c2126b134e43ecdd0666c42b` |
| `scripts/entrypoint-legacy.sh` | `4f9213850b938f71f1a7955683792c6ded862c4453efe9234ddf40f892ce7d0a` |
| `scripts/entrypoint-dispatcher.inc` | `1fe4a130fc99a0813e90b8247dc8bac97b4352cf5e051e0e8c4dea5c497fbecf` |

After exact envelope identity, the owner verifies the literal argv selector and
each unique rolled-back/applied arm's shift, nonempty name, URL composition, log,
exec argv and terminator. Only the resolve scan excludes those two proven arms.
History references and rollback edits retain full-source checks; generic inputs
and replay interpretation retain the original strict behavior. Fields are
captured once so proof and scan observe the same source. Missing/duplicate/spoofed
paths, additional snapshots, whitespace/comment/BOM/Unicode drift, extra commands,
reordered/omitted guards, rebinding and fallthrough cannot borrow an exemption.

This is a deliberately closed source protocol, not a path/name waiver, a general
shell parser or arbitrary runtime/interprocedural containment. Any source-envelope
edit needs explicit protocol review. The source check does not authenticate a
ticket, operator or separate approver, inspect deployed images/tasks, verify DDL/
DML state, or exclude concurrent live recovery. Those remain the existing runbook
and operational acceptance boundaries. No security permission or live recovery
policy changes are claimed.

Phase A and its existing Jest assertion now use the canonical owner. The lint
caller passes raw source rather than pre-stripped text; pre-stripping can corrupt
the source meaning of multiline quoted shell text. Both CLIs truthfully document
healthy no-argument exit zero while retaining failure, help/unknown refusal and
the optional-generation boundary. Current runbooks describe the exact source
protocol and preserve all ticket/operator/approver and replay prohibitions.

## Independent verification and preservation

Canonical source `a96af2e1161def587d4ed9b6b79be7e5ff042c5b` plus raw-lint operand
`dced1ff282fffea55376f9cc8eef3e849a0ec782` is independently accepted by review
`2819d731d33f30ed280af2392e2b509ddef90b0f`: 108 inert controls pass (82 actual-trio,
five generic, five replay, nine capture/purity/cache, seven actual-lint operand),
and 69 focused specs pass. All ten original full names remain; nine old bodies,
the forbidden-pattern declaration and four original helper bodies are exact.
The intended Phase A assertion alignment is explicit. The old Phase A predicate's
two unsafe accepted source mutants now refuse. No shell mutant is executed.

Separate independent CLI review binds the exact integrated implementation in
RELEASE-MANIFEST.json. Five guarded real CLI cases pass, retaining all four old
names and adding six fake-read source refusals before success or optional Prisma.
Twenty-seven independent harness/return/probe controls exercise wrong or missing
refusal, empty/wrong/extra stdout, stack/probe contamination, signals/errors/exits
and resource operations. Input source strings remain inert data. Original probe,
environment, command argv, 15-second child cap and help/unknown checks remain.
Complete PE-script compilation passes using cached declarations; no native
generation or installation ran. Overlapping checks are not summed.

All 603 schema/migration paths, the full entrypoint trio, URL composer and every
baseline path outside the seven source/two runbook paths remain unchanged. Original
PR2406/2407/2408/2409/2410/2411 artifacts are immutable. Original author 9/10 baseline
with one genuine refusal, launcher/type/preservation/harness failures, old unsafe
acceptances and all passing receipts remain source-pinned. Original histories and
unpublished excluded EngagementService reporting are preserved; that owner remains
untouched and unassessed.

## Dependency and remaining acceptance matrix

| Owner / input | Current source outcome and remaining boundary |
| --- | --- |
| PR2411 composition | Direct preserved base containing both exact PR2409/2410 published histories. Its former two source-policy conflicts close in this followup; its source/publication artifacts remain immutable. |
| Source guard and Phase A | Existing canonical helper, no new service/store or parser dependency. Exact raw source profile and controlled arms; strict generic/history/replay predicates preserved. |
| Entry points / operations | Runtime bytes and supported aliases unchanged. No automated recovery restored. Ticket/operator/separate approver, live image/source identity, DDL/DML and operator concurrency remain outside source acceptance. |
| Frontend / contracts | No HTTP/DTO/schema/persistence delta; frontend `4a161488` remains frozen. No consumption requested. Internal source-snapshot proof now requires raw complete supported trio. |
| Backend-only retirement | Separate parent-created workstream based on verified production image-to-source identity. No frontend/docs/dead-code removal enters this rebuild branch. New rebuild contracts must be deliberately reconciled there later. |
| Wider source cleanup | Flags/contracts/entity-bill/HTTP/context/config/persistence, nine registry domains, bounded facade conversions and broader ratchets remain in immutable PR2408 ADOPTION-MATRIX. Exactly 123 ambient samples remain deferred. |
| Native/full acceptance | All 11 original Cleanup items remain open: configured clean Node22/pnpm9.12 install/generation, authentic floor/current coverage acceptance, pinned visuals, real PostgreSQL/RLS/MVCC/concurrency, isolated full CLI/native CI and full Cleanup/Wave gates. Cached Node24/TS5.9 source checks, fake/inert tests and WASM do not qualify these. |

No DB/SQL/migration/PGlite, native Prisma/download, provider/model/message/upload,
customer mutation, credential/permission, AWS or security/network operation ran.
No main merge, deployment or frontend/retirement change occurred. Quicklog's
excluded commitment/counterparty UI remains excluded; existing task/backend
functionality remains intact. Native/runtime actions require exact authorization.
