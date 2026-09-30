# Preserved Meri source drafts — do not auto-apply

These seven inert `.patch` documents retain selected older uncommitted work relevant to the original Meri Foundation and Reliability acceptance scope. They are reference material, **not deployed product changes, passing tests, or authority to run fixtures**. Product code has not been changed by this archive. Read the parent handover before continuing.

The policy read and independently fetched for this packaging task is `neo-capiro/capiro-agent-ops` commit `fe8adaa858ee2391b42697311ce91cf787e080b8`. Fetch that repository's current policy before beginning a new session. Never mutate the shared migration ledger to recover a rollout. Production canaries/authenticated production browser tests are user-run. UI ships only through `web-vnext` to `os.capiro.ai`. Defense **chat** is excluded; existing Defense source/discovery work is not excluded.

## What is retained

| Archive | Original source file | Purpose and qualification |
|---|---|---|
| `01-native-business-development.patch` | `apps/api/src/business-development/business-development.service.ts` | Optional fixture prospect ID hook. **NOT RUN**; internal-only authorization and namespace fences need review. |
| `02-native-client-capabilities.patch` | `apps/api/src/clients/client-capabilities.service.ts` | Optional fixture capability ID hook. **NOT RUN**. |
| `03-native-client-facilities.patch` | `apps/api/src/clients/client-facilities.service.ts` | Optional fixture facility ID hook. **NOT RUN**. |
| `04-native-engagement.patch` | `apps/api/src/engagement/engagement.service.ts` | Meeting identity/ownership marker and task/debrief ID hooks. **NOT RUN**; public controller binding must remain impossible. |
| `05-native-action-recommendation.patch` | `apps/api/src/intelligence/actions/action-recommendation.service.ts` | Explicit synthetic strategy recommendation constructor. **NOT RUN**; do not bypass current owner authorization or fabricate real evidence. |
| `06-native-research-portfolio.patch` | `apps/api/src/research-portfolios/research-portfolios.service.ts` | Fixture portfolio ID and fixture event proposal. **NOT RUN**; lifecycle/revision/tenant effects need review. |
| `07-final-await-probe-draft.patch` | `apps/api/src/meri/task-links-final-probes.spec.ts` | Six mock-based test proposals: late authorization withdrawal, unchanged positive, private evidence stripping, semantic mutation replay rejection and canceled-task parity. **NOT RUN** on the current build; mock assumptions and expectations may be stale. |

Patches 01–06 were extracted from branch `codex/meri-synthetic-fixture-provisioner`, base `fa38d9b14e10b23e4c556b36f9944c48696cbc4a`. Only substantive fixture-hook hunks were retained; unrelated formatting hunks were omitted. Patch 07 is an untracked synthetic test draft from a detached review checkout at `d77ab91dfcb117b935c2280f10798badeb9556a7`, normalized from CRLF to LF. Its old header refers to historical verification; that claim is not accepted evidence for this handover.

The adjacent `manifest.json` records each source path, branch/base, base blob where tracked, full working-file hash, retained patch hash, purpose and qualification. Everything required to inspect these candidate changes is in this folder plus the ordinary product repository; no original Windows checkout or private evidence directory is required. The patch index lines are historical blob metadata, not verified resulting blobs for the selected-hunk archive.

Do not apply these patches as a batch. First compare the intent with the current implementation, then implement only a still-needed, owned change in an isolated worktree. The fixture service hooks are incomplete without validated native owner ports and authority/readback tests. A comment saying “internal fixture-only” is not an enforcement boundary. Do not wire them into public APIs or run shared-database fixtures from this archive. Verify changed behavior with relevant tests and current required Meri evaluations before integration.

## Excluded drafts and why

The exclusions below are deliberate preservation decisions, not deletion of the original local files.

- **Already integrated exactly or by reverse-patch comparison:** the baseline `memory-governance-ci.yml` change; foundation-review document writer, client KB, Engagement deletion/runtime changes, document owner/provisioner modules and tests; foundation-review canonical owner adapter and fixture-provisioning test edits; release-prereqs `memory-candidate.service.ts`. Current main is the source for these.
- **Old user-directory assistant/Responses client and both specs:** superseded by the current complete-call validation, bounded repair and no-incomplete-output replay boundary. Current `meriv3-assistant.service.ts` rejects incomplete/malformed batches before execution; `openai-responses.client.ts` emits calls only after completion and validation. The old draft would also expose partial prose, contrary to the newer boundary. No duplicate source patch is retained.
- **Memory-recall `memory-candidate-owner.mjs` and its PostgreSQL reset tests:** the draft physically deletes pending candidates and tests absence/reseed. Its SQL predicate does not bind the stored fixture ownership payload/marker, and it conflicts with current governed withdrawal plus retained same-transaction audit. Preserve the current lifecycle, not the old deletion design.
- **Release-prereqs untracked `memory-candidate-owner.mjs` and `memory-candidate-runtime.mjs`:** earlier forms of the now-integrated hardened candidate owner/runtime. Do not replace current code with these old copies.
- **Release-prereqs `memory-candidate-fixture.postgres.spec.ts`:** an older local-port-specific fixture test, superseded by current candidate owner/lifecycle PostgreSQL qualification areas. Its legacy fixed local setup is not a portable acceptance recipe; write or adapt current isolated tests if a still-missing case is identified.
- **Release-prereqs `fixture-provisioning/cli.mjs`:** adapter close in `finally` and nonzero failed/unknown status exit are already present in current main. No duplicate patch retained.
- **Release-prereqs `canonical-owner-adapter.mjs` broad draft:** excluded as incomplete scaffolding. Several native readers return null ownership/payload hashes, several writers use the tenant ID as a placeholder user, and meeting/debrief relationships are fabricated. Those cannot establish ordinary product parity or owner-authorized fixture readback. Reimplement required ports against actual owner contracts; do not use these placeholders. Current guarded client-document erasure supersedes its older “erasure unavailable” branch.
- **Source-families `client-profile-fill.service.ts`:** its extra redirect assertion is redundant with the existing destination assertion at the start of every fetch iteration. Redirects already pass through that guard before another request.
- **Revert-check `evals/meri/runtime/provider.cjs`:** excluded because its new denylist mutates `parentEnv`; the existing copied child allowlist already excludes those keys. This is not a needed correction.
- **Historical P0B, native-owner, source-family and reviewer reports:** not copied as green/current evidence. Several contain superseded implementation inventories, local paths, inconsistent totals or unverified worker claims. Their useful continuation points are distilled here: qualify native owner ports from actual stored state; retain source authority on replay/final awaits; test fixture lifecycle without shared destructive reset; do not infer File01 completion from setup counts.
- **Primary `C:\dev\capirov2` dirty work:** ownership is unconfirmed and excluded from this archive, including JEV/shared-core changes. No blanket integration authorization is inferred.
- Generated usage JSON, `nul`, temporary gate reports, screenshots, raw DB/cloud receipts, secret configuration, customer material and session/auth state are excluded.

## Security and verification

The retained patch text was inspected for actual content, not only filenames. Service hunks contain source definitions and fixture-marker expressions. The test uses explicit fake tenant/user/client IDs, Aster demo rows, an `example.gov` URL and a repeated placeholder hash. No customer rows, provider credentials, database URLs with passwords, private keys, auth state, runtime configuration or raw execution snapshots were copied. A high-confidence secret-pattern scan found zero matches. This is a review of the archive's disclosure surface, not security approval of the draft implementation.

Archive byte hashes and patch parsing are checked separately. **Product build/tests, Promptfoo/custom assertions, PostgreSQL tests, live acceptance, deployment and shared DB operations: NOT RUN by this preservation task.** No claim in an old comment upgrades that verdict. Source revisions inspected for supersession were main `25d1339c0c0e21fe0c3c0148787fad772e5096e8` and task `c785e566321943470978d66325952ed916951346`.
