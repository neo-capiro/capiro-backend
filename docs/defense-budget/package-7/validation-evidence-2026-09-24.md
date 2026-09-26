# Package 7 validation evidence

Date: 2026-09-24  
Repository: `neo-capiro/capirov2`

## Product and safety checks

| Check | Result | Evidence |
| --- | --- | --- |
| Prisma schema | PASS | Schema validates and Prisma Client generates with `20280924070000_package7_client_budget_watch`. |
| Migration DDL | PASS | DDL executed successfully against local PostgreSQL; validation objects were removed afterward. The production migration task applied the migration and exited 0. |
| Focused API suites | PASS | 6 suites / 61 assertions across buyer workspace, federal evidence, explorer reads, client-watch service/controller and Meri registration/execution. |
| Focused web suites | PASS | 19 assertions across client watches, source-state disclosure, profile export and explorer export. |
| TypeScript | PASS | API and web TypeScript checks completed without errors after prerequisite workspace builds. |
| Workspace packages | PASS | Shared, strategy-verifier, Meri v2 core, defense contracts and defense domain built successfully. |
| Production builds | PASS | Nest API and Vite web production builds completed. Existing Vite chunk-size warnings remain non-blocking. |
| Independent safety audit | PASS after repair | Hermes found the new observation time predicate used `created_at` while the table stores `observed_at`. The query and regression expectation were corrected before merge; no other scoped blocker was found. |
| Git diff hygiene | PASS | `git diff --check` clean before the code commit. |

## Customer-workflow assertions

- The Explore catalog sends the selected FY to the server. Eligibility, request/current positions, trend ceiling and material signal all use that FY.
- Capability filtering uses accepted capability matches. Unreviewed catalog rows say `NOT REVIEWED`, never `VERIFIED`.
- Source candidates remain candidates until evidence supports a reviewed state. Loading, failure and zero-source states remain distinct.
- Exports include fiscal year, units, stage, data as-of, generation time, attribution status and a source-inspector link.
- The buyer-workspace composite refuses invalid/unpinned time scopes, detects section scope mismatches, and returns explicit coverage/freshness without upgrading partial or unsupported inputs.
- Watch rows and events are tenant/client guarded with forced RLS and database scope triggers. Watch/event history is append-only. Decisions reference a same-watch material update, and a partial unique index permits only one acknowledgement-or-dismissal decision.
- The UI locks both decision choices once the immutable decision exists.
- Meri receives the same pinned composite result and retains supported sections if the canonical budget section is unsupported.

## Source control and GitHub checks

- Code PR: `https://github.com/neo-capiro/capirov2/pull/1788`, merge `93bf1e4284948145bd3956eed130ab00134a94d5`.
- Watch-decision hotfix PR: `https://github.com/neo-capiro/capirov2/pull/1789`, merge `aa537571a1f8bbdeb9cc3a5352926eaebf989e22`.
- GitHub-hosted jobs failed in two to four seconds without a runner (`runner_name=""`, zero steps). This was an infrastructure/billing outage, not an executed test failure. Admin merges followed the green local gates and independent safety audit.
- At evidence capture, GitHub and local `main` both pointed to `18b480b86c4ef295e8321bed8b4b701b8d95dc09`, which contains both Package 7 merges plus later unrelated releases.

## AWS release proof

- Native ARM64 API CodeBuild `capiro-build-intel-api:f414810a-77f1-4875-8aa2-461d4b6e0e79` resolved code merge `93bf1e4284948145bd3956eed130ab00134a94d5` and pushed digest `sha256:416cb227b9d72b307870dfc3d78f4c1ed8228030bdbdf7e3793a2dc47f7dbdd0`.
- Native ARM64 web CodeBuild `capiro-build-web-dev:173dc52d-4f52-470b-8411-82e918380416` resolved hotfix merge `aa537571a1f8bbdeb9cc3a5352926eaebf989e22` and pushed the same web digest to `capiro/dev/web` and `capiro/dev/web-vnext`.
- Migration task `bf903743c5634e37889fa416435056aa` on task definition `capiro-dev-api-migrate:135` applied the Package 7 migration and exited 0.
- API task definition `capiro-dev-api:451` is steady at `2/2/0`; replacement task IPs `10.40.15.69` and `10.40.8.88` are healthy on the exact API digest.
- Web task definition `capiro-dev-web:136` and web-vNext task definition `capiro-dev-web-vnext:351` are each steady at `1/1/0` on web digest `sha256:385bf687334591cd83f54bea6919fde27f57833b4be3a04dc596b9906f4fd371`.
- `app-dev.capiro.ai/runtime-config.js` and `os.capiro.ai/runtime-config.js` both report release SHA `aa537571a1f8bbdeb9cc3a5352926eaebf989e22`.
- No Package 4–6 ingestion/publication flag was enabled by this release.
