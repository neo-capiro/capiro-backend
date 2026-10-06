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
