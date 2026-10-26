## 1. Claude handles the harness

The quality bar is Claude's own. Answer quality comes from the whole harness, not only the model: its system prompt, built-in tools, subagents, skills, context management and compaction, and session handling.

- Run `@anthropic-ai/claude-agent-sdk` with its **full harness** and the Claude Code system-prompt preset, plus a short Capiro/Meri append. Don't replace the preset with our own prose.
- Do not rebuild what the SDK or AWS already does: model calls, retries, streaming, the tool loop, context management and compaction, session resume/fork, per-run turn and spend limits, AWS credentials.
- The real Claude SDK calls Bedrock directly using its narrowly scoped AgentCore runtime IAM role. Preserve the full preset, native tools, subagents and all 14 skills.
- Capiro data reaches Claude as **tools** (rule 4), not as a custom retrieval layer around the model.

Spec and plan: `phases/wave2/WAVE2-00-CLAUDE-NATIVE-HARNESS-SPEC.md`. It is **Wave 2 item 0**, and it comes before every other item that touches the runner, the proxy or authority.

## 2. Simple, standard architecture

```text
browser -> control (current access, conversation/run ownership, durable events)
        -> AgentCore Runtime V1 (isolated conversation session; actual Claude SDK) -> Bedrock
                                      -> tool gateway -> Core
control -> existing durable SDK SessionStore and artifact owners
control -> Temporal for required durable runs, schedules and background work
```

- **Core is the gatekeeper for Capiro data.** Tenant, member, client and wall rules remain server-side in Core. Check current access at admission and actual tool/data/artifact access; revocation must also prevent use of previously loaded privileged context. Do not duplicate policy in the harness.
- Reuse one isolated environment only for the same immutable tenant/actor/conversation and approved General/client scope. Serialize turns; stop idle compute and restore exact SDK transcripts and artifacts from their durable owners. A Runtime session ID is not authorization or durable storage.
- Keep the SDK's per-run turn/spend limits and one canonical tenant cap/usage owner. Preserve required durable runs, schedules, consent, outcomes and uncertain-write fences; neither SDK Task tools nor a warm process replaces Temporal durability.
- **No custom warm pool, per-turn ECS task requirement, model proxy, duplicated per-hop authority, credential-minting service or spend-reservation ledger.** Use standard Runtime V1; no V2 snapshot machinery or second SDK implementation.
- Before adding a mechanism, identify the standard feature or existing owner it uses. Before deleting a wrapper, prove the retained lower-layer behavior with meaningful positive/negative tests. Do not remove canonical authorization, idempotency or durable outcomes as “extra security.”

## 3. Leave no dead code behind

A change is not done until what it replaced is gone.

1. **Delete in the same PR** everything the change makes unused: code, tests, fixtures, docs, config keys, env vars, feature flags, IAM statements, ALB rules, secrets, task definitions, CloudFormation resources, kit steps, alarms and metric filters. Applied database migrations are history: never edit them. Drop tables only through a separately reviewed forward migration after a snapshot; this hosting migration does not itself authorize schema/data removal.
2. **Temporary diagnostics come out before merge** of the fix they were added for. A log line stays only as named product telemetry that someone reads.
3. **No code behind a flag nothing turns on.** The "source-complete, activation-held" status is retired for code we don't intend to ship. Dark features need an owner and a date, or they are deleted.
4. **No** commented-out code, `legacy` or `_old` copies, compatibility shims for removed things, or "superseded" stubs.
5. **Show proof in the PR:** list the identifiers, files and resources deleted, with a search proving no executable/active caller remains; label immutable historical references, and explain any drop in test count.
6. **Old plan tickets for removed mechanisms are closed as superseded**, not implemented and left dormant. See `source-of-truth/SUPERSEDED-BY-ITEM-0.md`.
7. **Reuse before write.** Use SDK, AWS and library features first. Custom code needs one line saying what the standard option couldn't do.

## 4. Capiro data must keep working

- Capiro data is served to Claude as tools. Core remains the source: today's read families call Core at `/api/clio/tools/<operation>`, and the new tools call the same endpoints.
- Tools are hosted by **control** (the existing tool gateway) so the runner never holds the Core service secret (`x-internal-service-secret`). The runner gets only a short-lived per-run token for control, scoped to tenant, user, client, conversation and run.
- Reuse the existing read handlers under `apps/gateway/sources/*` and their typed schemas. Delete the authority, relay and measurement wrappers around them.
- Parity: every read family that works today must be reachable as a tool with the same results and the same permission outcomes. A parity checklist is part of the item 0 spec.
- Negative tests are mandatory: another tenant's data, another client's data, and walled data must not be retrievable, through chat or through tools. A General chat reads across the clients the user can already see, with each client's wall enforced per result (FINAL-PLAN decision 2).
- The original read-only first cut is historical. Neo subsequently authorized preview client-record writes and autonomous Wave 2 completion. Activate accepted writes through their existing authenticated domain/intent owners and receipts, with the actual route/configuration and effect semantics verified. This does not authorize the assistant to send external mail without the user's specific send instruction.

MF16 hearing media implementation outline — 26 October 2026

Root allocated the narrow producer/consumer integration after the saved hearing viewer freeze. Core base d209ebd4cc759bf6409a2df7af578b125964b77a; branch codex/w3-mf16-hearing-media-20261026. Meri will use merged cc8a6d9f public source contracts; frontend follows PR212 without changing its client admission blob. No builds/install/DB/cloud/provider actions in Runtime lane.

Keep current source-read lifetime in Meri and exact source identity in Core. Add a bounded media read to the existing conversation source-read public family, selecting only an existing saved hearing reference. Core reuses the governed search_committee_hearings handler to authorize the exact current record and compare its recordId/contentHash, derives the actor through existing tenant membership, then calls the existing authenticated Intel owner. Intel reuses PublicHearingAudioAccessService.manifest/playback and RecordingStorageService; no policy SQL/signing copy and no recording activation. Signed URLs are ephemeral read results, never durable source events, record hashes or model context.

The read request may select one existing epoch and an in-range time; the producer returns exact authorized epoch/part/time bounds, expiry and partial coverage. This is hearing-level recording access, not an inferred answer-to-source timestamp. No captions are fabricated. Browser closes and disposes media on source/view/identity replacement or expiry. RetainedAudioPanel demonstrates the existing native audio rendering, but its browser-session ID and retention mutation UI cannot be substituted for a public hearing record. Use the established player/library owner and current application boundary; no second transport or custom media engine.

Focused checks: denied/missing/stale/foreign source cannot call signing; epoch/hearing/time mismatch and expired parts refuse; exact positive identity/time/expiry survives canonical receiving; source replacement/late reply/expiry dispose player; existing bill and hearing source behavior stays intact. Release alone builds any changed public package; independent review and installed browser checks remain required.

Source freeze validation — 26 October 2026

The Core controller uses the existing current authenticated tenant, RolesGuard, verified ToolServiceSecretGuard and request cancellation owner. Its exact governed search_committee_hearings read must match the saved recordId, hearingId and contentHash before Intel is called. Intel preserves current feature/member/source permission and signing through PublicHearingAudioAccessService. Its existing controller now reuses the same service-identity check for records and media. HearingModule exports the existing audio owner for TrackerModule; no policy, capture or storage implementation is copied. Denied/oversized owner bodies are cancelled; a request cancelled during actor lookup cannot call the media owner.

Focused checks: Core read.spec.ts 6 PASS; Intel hearing-record-media.spec.ts plus the affected hearing-record-retrieval.controller.spec.ts 9 PASS, no skips. Tests use synthetic records and mock boundary dependencies, with actual existing service/controller code; no DB/provider calls. Node 24.22.1, Jest 29.7.0, TypeScript 5.9.3. No-emit checks of the five new/changed TypeScript test and implementation roots report zero owned diagnostics; the Intel import graph reports zero diagnostics. The Core API graph reports 281 diagnostics outside those roots against retained dependencies. Full API typing is not established; all diagnostics remain in api-all-type-diagnostics.txt. Initial import/configuration failures and the wrong-CWD test invocation are retained with final passing logs. Final six Core tests are in core-tests-frozen.json; nine Intel tests are in intel-tests.json. Formatting and git diff checks pass.

Evidence: C:/Users/Administrator/Documents/Codex/2026-10-25/wave2-visible-runtime/outputs/w3-mf16-hearing-media. Tools use retained public dependencies and the existing cap-meri-source-families generated Intel Prisma client for test loading only. No new node_modules links, generated client, package build/install/pack, DB or cloud changes. This branch does not alter manifests/lockfiles, guards, signing policy or capture activation. No executable path is replaced; the duplicated service-secret check was extracted within its existing controller. Media is excluded from the frozen 720741c5 rollout.

Independent exact-head review, composed deployment tests and authenticated live acceptance remain outstanding. Meri's sibling media branch provides the new public contract/runtime read. Release owns its physical contracts package; Integration owns manifest/lock adoption. The frontend requires @vidstack/react 1.15.7 and media-chrome 4.19.4 plus that exact updated public contract artifact. Media positions describe retained hearing audio only; no answer-to-source timestamp or captions are inferred.

Independent review correction — 26 October 2026

Library independently rejected Core 850f48d18891337196a664b128f23f18e383a279 because the Intel request could outlive the authorized saved-record version or client/wall access. Its unchanged-source control passed while both denial/version-change probes failed. That freeze is superseded by this correction. Meri a7da2543a76abb28a95216a2639763d90e487621 was independently accepted and remains unchanged.

The media read now reuses the same governed exact-record read and active actor lookup both before the Intel request and before release. Final record identity/hash/hearing mismatch, current client/wall denial, inactive/replaced actor, or cancellation discards the fetched media. Same-file helpers keep request parsing, exact source checks, and actor derivation distinct without introducing another authority owner. No wire contract changes are required.

Core now has 9 passing focused tests covering positive reads and changes during owner I/O or final access checks. The author's rerun of Library's three unchanged regression probes also passes; this is not independent acceptance of the new head. Evidence: core-release-recheck-tests.json and core-review-probe-recheck.json, with final logs under the same existing output folder. Their first failed invocations used the wrong retained Jest binary path and are preserved separately. The three affected API TypeScript roots still have zero owned diagnostics; release-recheck-core-types.json retains the 281 outside-root dependency diagnostics and full API typing remains unqualified. Unchanged Intel's 9 passing tests are reused. Exact-head independent recheck, physical package/consumer checks and live acceptance remain outstanding.
