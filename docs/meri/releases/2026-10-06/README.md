# Stage 2 releases, October 6, 2026: research re-check adapter

Handover 2026-10-06 section 9 step 1. Four API rolls through deployment plan §2 (`scripts/meri-image-build.mjs`, `scripts/meri-release.mjs` prepare and promote, live `GIT_SHA` read twice and checked as an ancestor before each promote). No migration was applied by any of these rolls. The orchestrator and web-vnext were not rolled.

Each roll's live check was one Deep Research run on the QA client (`ZZ-QA-Meri1651-Test-DoNotUse`), as neo@capiro.ai in capiro-internal, through the product endpoints, with a non-budget topic. The topic was critical-minerals federal policy and what it means for this client.

| Roll | Code | API revision | Rollback | Source | Digest | Live check |
| --- | --- | --- | --- | --- | --- | --- |
| [s2-recheck-adapter](s2-recheck-adapter/README.md) | #2051 adapter (with #2047, another workstream) | 566 | 565 | `fd6a8b557` | `sha256:3071831d…` | Fail, as designed: `context_packet_item_missing` (session `4971a63b`) |
| [s2-recheck-adapter-2](s2-recheck-adapter-2/README.md) | #2054 the re-check reads memory as the reader | 568 | 567 | `30fd674d0` | `sha256:d9e76278…` | Fail, as designed: `unreceipted_tool:search_research_sources` (session `78999210`) |
| [s2-recheck-adapter-3](s2-recheck-adapter-3/README.md) | #2056 research reads only through re-checkable tools | 570 | 569 | `4b14a1109` | `sha256:1b0d027e…` | Fail: provenance builder refused undeclared receipts from dropped children (session `1d04ca37`) |
| [s2-recheck-adapter-4](s2-recheck-adapter-4/README.md) | #2058 undeclared child receipts (with #2052, another workstream) | 574 | 573 | `c9f570eee` | `sha256:4cdba7f7…` | **Pass:** report published and readable (session `5d29ceb1`, report `ebd713a5`, 3,439 characters) |

What each failure showed:

1. **`context_packet_item_missing`.** `memory_items` forces owner-aware RLS. Inside `withTenant`, the reader's own user-private steering item (user-voice) is invisible, so the check failed closed. Fixed by setting `app.current_user` for the check's transaction (#2054).
2. **`unreceipted_tool:search_research_sources`.** A tenant search across clients, meetings, mail and notes, with no owner proof, was correctly refused. Research execution now admits only receipted owner tools and audited public-data tools (#2056).
3. **Provenance builder.** Both bounded children read receipted sources and were dropped for `schema_invalid` output. Their receipts stayed in the session, and the builder refused a report that declared no source. The classifier now refuses any receipted read the model saw that is not declared, and the builder no longer refuses over other producers' receipts (#2058).

Roll 4 checks:
- Served revision 574 runs `sha256:4cdba7f7…` on both tasks, with `GIT_SHA`/`RELEASE_SHA` `c9f570eee`.
- The env diff from the live 572 is the SHA keys only.
- `migration-status` on the candidate image (admin-migrate 87, read-only) reports the schema up to date (456 migrations). LegiWatch's `20281008020000_legiwatch_committee_news_update_type` was already applied by that workstream.
- Another workstream rolled the API to 571 and 572 (`c91bbe29f`) during the build. The second ancestry read confirmed `c91bbe29f` is an ancestor of the candidate.

Roll 4 live check:
- The coverage log reads `unsupported={}`. Covered: 9 packet items, 6 steering records, 1 client record, 37 memory records, and public reads by `search_congress_bills` (1), `search_public_web` (5) and `query_regulatory_dockets` (2). There were 10 content-free failures.
- The report body is released on `GET /api/clio/research/:id` and in the conversation history, and neither public projection carries the private manifest.
- The report states that primary-source reads were unavailable, so its policy claims are marked unconfirmed. Neo's verdict on the content is pending.

`verify-image-parity.ts` shows only the known `:latest` drift on api, web and intel-api (builds publish by SHA).

## Later on October 6: research quality, D4b and Release B (dark)

Handover §9 step 2 started with a budget-topic check (session `d3934ccd`, API 576 from LegiWatch's `567ef73ad`, which contains every fix above). The report published and the auditor recorded no finding. But it could only say the budget-timeline and report-language lookups were unavailable. Tracing that led to two research-path fixes. With PE data flowing, D4b then held the budget report, so the flagged sentence is now captured for the reviewer.

| Roll | Code | Revision | Rollback | Source | Digest | Live check |
| --- | --- | --- | --- | --- | --- | --- |
| [s2-pe-durable-reads](s2-pe-durable-reads/README.md) | #2063 PE reads are classified, receipted, durable research sources (API side) | API 578, superseded within minutes by LegiWatch 580 and 582 (`0a5107e5d`, which contains #2063) | 577 | `5e38f2c20` | `sha256:2561d381…` | See the orchestrator row |
| [s2-pe-durable-reads-orch](s2-pe-durable-reads-orch/README.md) | #2063 (orchestrator classifies PE reads) | orchestrator 155 | 154 | `5e38f2c20` | `sha256:b821063c…` | Session `d3304790`: steps 1 and 2 now complete, but the parent's PE re-reads were still refused (see next row) |
| [s2-coordinator-rereads](s2-coordinator-rereads/README.md) | #2067 a completed step can be re-read while a later step is ready | API 586 | 585 | `287f437a1` (rebuilt from main: LegiWatch's branch commit `7235fb172` was live as 584 and was not an ancestor of `b9cb7f704`) | `sha256:dcf3c4a2…` | Session `e25804d0`: timeline read 3 times, program element twice and report language once, all receipted; **held by D4b** |
| [s2-held-findings](s2-held-findings/README.md) | #2073 held findings and flagged sentences on the review request; ships #2068 and #2072 dark | API 589 | 587 | `e41ad6e6e` | `sha256:153eefd4…` | Session `26489d5d`: held by D4b; review `4da46ece` carries the sentence (below) |

`migration-status` ran read-only on each API candidate (admin-migrate 88, 89 and 90): schema up to date, 457 migrations. No migration was applied.

**D4b, decision for Neo.** The captured sentence:

> Its recorded FY27 HASC and SASC authorization marks and HAC-D appropriations mark each equal the FY27 request; HAC-D is the latest recorded stage, **not enacted funding**.

This keeps the two vehicles apart correctly. The rule (`checkVehicleConflation`, `packages/meriv2-core/src/grounding/auditor.ts`) fires on an authorization term followed within 40 characters, in the same clause, by any `appropriat\w+` word. Its enumeration exemption looks only at the words right after the authorization term, so "authorization marks and HAC-D appropriations" matches. The earlier released budget report escaped only because "$288.3M" put a period inside the window.

Recommendation: narrow D4b to the verb forms it targets. That means `appropriates`/`appropriated`/`provides the money` after an authorization subject, and `authorizes`/`authorized` after an appropriations subject, instead of the noun labels. It is a shared enforce-mode safety check, so the change waits for Neo.

**Release B, merged:**
- #2068 `features.meriJobs` on `/api/me`.
- #2069 the web research parser keeps the job view.
- #2072 deliverable jobs: a Word document rendered from the authorized report, filed into client Files once with key `meri-job:<id>:<index>`.

The API parts are deployed dark in 589. The web part is not deployed (no web-vnext roll yet). `meri.jobs` is off everywhere.

## Release B web (dark)

| Roll | Code | Revision | Rollback | Source | Digest | Check |
| --- | --- | --- | --- | --- | --- | --- |
| [s2-release-b-web](s2-release-b-web/README.md) | #2069 job view parser, #2080 Delegate this, #2081 deliverable card, #2082 running-jobs rail, #2083 job auto-resume | web-vnext 414 | 413 | `5152d990b` | `sha256:2fad3db0…` | `CAPIRO_WEB_RELEASE_SHA` equals the source; bundle probe `RUNNING JOBS` passed in the image smoke test; `/api/me` reports `meriJobs: false`, so nothing renders |

This was the first web-vnext roll through the Meri release path. Both ancestry reads saw 412 (`f63686c95`, on main). The env diff is the three release SHA keys only.

No paid turn was run: no backend changed and the new UI is hidden. The UI live checks are T5 and T7 once `meri.jobs` is enabled (Neo's OK), plus the Release F Playwright flows.

## Afternoon: D4b, Release B live checks, turn efficiency, LegiScan, partial receipts, bill text

Handover: [HANDOVER-2026-10-06-pm.md](../../implementation/HANDOVER-2026-10-06-pm.md). Every roll below went through deployment plan §2 (CodeBuild image, `migration-status` on the candidate, evidence PR, prepare, two ancestry reads, promote, digest readback on every running task). Other workstreams rolled the API at 594, 607 and 612/613 and web-vnext at 419, 420 and 425 in between; each was an ancestor of the next candidate.

| Roll | Code | Revision | Rollback | Source | Digest | Live check |
| --- | --- | --- | --- | --- | --- | --- |
| [s2-plan-limits](s2-plan-limits/README.md) | #2088 D4b verb forms; #2089 plan string limits | API 596 | 595 | `832c69560` | `sha256:f902cfe7…` | T5 run 2 (`a71e0ac2`): planned (the run-1 failure is gone); failed on provider budget exhaustion (23 attempts) |
| [s2-d4b-orch](s2-d4b-orch/README.md) | #2088 (orchestrator chat auditor) | orchestrator 161 | 160 | `97ae6d6a8` | `sha256:81741d38…` | Budget topic `e0bd0918` (PE 0605231A FY27 vs FY26): **published, 1,254 characters, no auditor finding** (the two earlier runs on this topic were held) |
| [s2-child-correction](s2-child-correction/README.md) | #2091 format-only child correction | API 598 | 597 | `aa208004f` | `sha256:f8d45756…` | T5 run 3 (`cfac6f20`): failed `research_child_goal_invalid` |
| [s2-child-goal](s2-child-goal/README.md) | #2094 child goal trim; job status precedence | API 600 | 599 | `447557786` | `sha256:97bad229…` | T5 run 4 (`f82a2d24`): lease lost at 60s |
| [s2-efficiency-orch](s2-efficiency-orch/README.md) | #2097 turn efficiency | orchestrator 163 | 162 | `d53a5919e` | `sha256:8a8b0f51…` | Commitments audit `594a31e5`: 14 model calls, 45 tools, 1.12M input tokens, 356s (Neo's runs: 51 to 63 tools, 1.19M to 2.20M); no `search_floor_votes`/`list_members` |
| [s2-efficiency-legiscan](s2-efficiency-legiscan/README.md) | #2097 heartbeat diagnostic; #2098 live LegiScan lookup | API 602 | 601 | `d53a5919e` | `sha256:8ba4408b…` | After the 602→603 revision: OH HB 1 `ce2185df` refused on quota (LegiScan key at 10,021/10,000), worded honestly |
| configuration revision (§2.5) | secret `LEGISCAN_API_KEY` (`capiro/dev/legiscan_api_key`), same image | API 603 | 602 | `d53a5919e` | `sha256:8ba4408b…` | `DRIFT-FINDINGS.md`; codified in #2101 |
| [s2-partial-receipts-orch](s2-partial-receipts-orch/README.md) | #2106 partial owner reads committed as partial receipts | orchestrator 165 | 164 | `006cbc6ee` | `sha256:5ef19ff5…` | T5 run 6 (`fc3b54a9`, with API 609): heartbeat lost a compare-and-swap race |
| [s2-partial-receipts](s2-partial-receipts/README.md) | #2103 correction guard; #2106 partial reads receipted and re-checked | API 609 | 608 | `006cbc6ee` | `sha256:41655e1f…` | T5 run 5 (`9c52022a`, on 603) had been refused for unreceipted partial reads; run 6 above |
| [s2-heartbeat-race](s2-heartbeat-race/README.md) | #2114 heartbeat retries a lost race; `context_plane` is not a read | API 611 | 610 | `a84dce2f5` | `sha256:e545a366…` | T5 run 7 (`a1a36b6f`): refused `receipted_unowned_tool:search_public_web` |
| migration (§2.4, Neo's OK) | `20281008040000_federal_evidence_passage_search` | admin-migrate 98 (apply), 99 (read-only status) | | `0650f02a2` image | | 16:56–16:59 UTC; "All migrations have been successfully applied"; status: up to date, 458 migrations. Logs: `outputs/meri-stage2-20261006/migration-apply-15/`, `migration-post-15/` |
| [s2-bill-text-orch](s2-bill-text-orch/README.md) | #2115 bill-text prompt routing | orchestrator 167 | 166 | `0650f02a2` | `sha256:20aeedb5…` | Bill-text turn below |
| [s2-bill-text-public](s2-bill-text-public/README.md) | #2115 in-bill locator, cross-bill text search, 9,000-character pages; #2118 receipted public-data reads are public | API 615 | 614 | `9ee56613f` | `sha256:9a01d791…` | Bill-text `7965f93e`: **six bills found by text; S. 714 `rs` §2(o)(1) quoted verbatim under its heading** (3 rounds, 14 tools, 396k input tokens). T5 run 8 (`cab91bd9`): every producer input covered and the manifest pinned, then refused at publication ("producer proof is unavailable"); the failing clause is not logged (handover §5) |

`migration-status` ran read-only on every API candidate (admin-migrate 91 to 97, then 99). The only migration applied today is the passage-search one above.

Production changes outside code: tenant flag `meri.jobs` on for capiro-internal (11:22 UTC, `outputs/meri-stage2-20261006/flags/`); task family `capiro-dev-api-federal-evidence-backfill:1` for the one-off historical BILLS backfill (`FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED=true` on that family only; the API service, the Package 4 rules and the outbox drain stay off). The backfill stored 7,754 119th-Congress bill-version packages and then stalled on one package that exceeds the 5-second interactive-transaction timeout (handover §6.1).

Paid turns this afternoon: eleven (T5 ×7, research check ×1, commitments audit ×1, OH HB 1 ×1, bill text ×1). Neo's verdicts are pending on the passing D4b report, the commitments audit answer and the bill-text answer.
