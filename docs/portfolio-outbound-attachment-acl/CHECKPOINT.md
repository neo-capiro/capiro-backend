# Outbound attachment access candidate

## Approved outline before implementation

- Policy `b32b4803933760dc0a93fffdcd8fba30a89c3aac`, fetched remote `b2b0ce8c2bf03817b81e671d968b7892985b8d06`; machine map timestamp `2026-09-30T00:21:48.2698715Z`. No repository-local AGENTS/implementation standards are tracked in capirov2 main. Fresh source-only worktree `C:/dev/cap-outbound-attachment-acl-261011`, branch `codex/portfolio-outbound-attachment-acl-20261011`, base `fd8765ec01d292013758606204f2c9d886cd31c1`.
- Parent approved only new `engagement/attachments/**`, this checkpoint, and focused `EngagementService` resolver/predicate/caller changes. Cleanup owner confirmed its frozen candidate does not touch this service; route-manifest/characterization/eval files remain untouched. Security/contract owner adjudication is required before integration/activation.
- Extract one typed viewer predicate from the exact existing list/extract rule: all-mode, restricted explicit viewer, or uploader. No administrator bypass. Reuse in list/extract and outbound lookup. Do not broaden unknown viewer modes.
- Resolve every requested ID within tenant, current file version and viewer predicate. Missing, inaccessible and superseded IDs fail the whole request with the existing non-disclosing `ATTACHMENT_MISSING` response.
- Bind SingleMail/campaign selection to their explicit client (null means clientless context); permit unlinked files only under canonical viewer/parent rules. Reject another non-null client and mixed-client selection.
- Complete all canonical current-client/own-meeting/own-mail parent, readiness and hearing `distribute` checks for the complete set before fetching any storage bytes or calling an email provider. Existing own-parent and hearing implementations remain authoritative; no second ACL model, byte client or provider integration.
- Keep existing sendBatchEmails and OutreachSendIntentService resolvers outside this candidate. They remain named follow-up security dependencies; this is not universal outbound ACL closure.
- Node24.19 and existing installed tooling read-only. No installs, migrations, live/provider calls, schema/auth/config/lock/module changes, full build cache, deployment, push or PR publication.

## Validation

- Node `v24.19.0`; only existing reference dependencies were read. No dependency install/copy, cache build or external calls. Disk readback after qualification: 18.81 GiB free.
- Unchanged baseline document-read/send-integrity suites: **25/25 pass**. Their source and assertions are untouched.
- Candidate final focused run: **48/48 pass across four suites**: 19 new access cases, the original 25, and four existing hearing document authority cases. Actual `EngagementService.sendSingleMail`, readiness and parent implementations are imported. Storage/provider boundaries are spies with synthetic bytes; these are local contract tests, not live database/provider checks.
- New tests assert the exact tenant/current-version/ordinary-viewer Prisma query and non-disclosing denial when a selected ID does not resolve. Foreign/mixed-client, removed-client, own-meeting/mail denial, and a later readiness/hearing rejection all produce zero byte and provider calls. All-mode, explicit-viewer, uploader, own-meeting/mail, unlinked/current-client combinations and hearing distribution retain delivery. The hearing authority itself is covered by its unchanged existing tests, including provenance and current authority failures.
- Original-source regression comparison: the exact starting service blob `2f0fc56b2eff3526118df7a052d13e76daf020a4` was substituted by a transient Jest transformer without changing candidate source. **10/19 fail and 9/19 pass** against that original service. Failures show the missing viewer/current-version predicate, client/parent checks and whole-selection preflight. Saved failures remain separate from the passing candidate run.
- Strict TypeScript for the two new helpers: **pass**. The service plus new tests has **37 dependency/transitive diagnostics** with the borrowed runtime (missing built shared subpath/package declarations and existing CommonJS/ESM resolution). An exact original-service compiler-host substitution yields the same 37 diagnostics byte for byte; none is in a changed/new file. This is a source comparison, not a full API typecheck/build pass. No declarations or assertions were weakened to suppress it.
- New files/checkpoint Prettier and `git diff --check`: **pass**. No ESLint configuration is tracked at this checkout's root or API root; no whole repository lint/build is claimed.

With a normally installed checkout, the focused suites can be rerun from the API package:

```powershell
pnpm --filter @capiro/api exec jest --runInBand src/engagement/attachments/outbound-attachment-access.spec.ts src/engagement/engagement-document-read.spec.ts src/engagement/outreach-send-attachment-integrity.spec.ts src/engagement/hearing-record-document-access.spec.ts
```

The task evidence includes the exact temporary borrowed-runtime Jest/TypeScript configuration, original-source substitution tools, logs, machine-readable results and source hashes. The first baseline setup failure (`ts-jest` resolution) is retained; the corrected absolute runtime configuration is used for the reported runs.

## Boundaries and remaining dependencies

- Supports the attachment authorization dependency of audit `ENG-email_send` and its same-route reply composition `CORE-108` (`POST /api/engagement/mail/send`). This does not complete their frontend workflows or live acceptance. No other audit row is marked complete by this backend candidate.
- Only `loadGraphAttachments` and its SingleMail/record-campaign callers gain the new outbound guard. `sendBatchEmails` and `OutreachSendIntentService` have separate resolvers; their viewer/current-version/client/parent authorization needs independent security adjudication and a coherent follow-up. Existing readiness/integrity tests on those paths remain passing but do not establish this ACL closure.
- Client mismatch is checked after the filtered lookup and before parent/readiness checks. A visible foreign-client file is rejected with `ATTACHMENT_CLIENT_MISMATCH`; missing, superseded and inaccessible files share `ATTACHMENT_MISSING`. This intentionally changes unsafe send behavior and ensures an earlier valid file is not fetched before a later authorization rejection.
- Canonical parent checks are reused exactly: tenant client exists, caller-created/owned-calendar meeting, and caller-owned mailbox message. No administrator override or new client-sharing interpretation is introduced. An unlinked file remains allowed only when its current viewer and any parent permissions permit it.
- Preflight is not a transactional writer fence: ACL/parent changes between completed preflight and provider dispatch remain a concurrency dependency. This candidate does not claim immutable send manifests or universal writer coordination.
- No migration, schema/controller/module registration, shared runtime activation, deployment, provider send or live data write occurred. No reachable Engagement/security contract owner was identified; root must coordinate owner review and integration/activation before applying this behavior to shared services. Cleanup ownership and fixtures remain untouched.
