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
