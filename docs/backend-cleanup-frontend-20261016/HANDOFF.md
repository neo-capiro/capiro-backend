# Backend source ownership cleanup

This continuation starts at draft PR29 head `4e0c189c5d0522098be1c4916a033bb681d11c0b`, whose application base is Engagement successor `016e79b585c14f20d13669e13c987c01e3dd29dd`. It retires the old main Web application workspace and copied Defense runtime implementations. It preserves the production backend application source and required support. Comparable counts are in `CODE-COUNTS.json`; they use the original sealed016e receipt and changed Git blobs, rather than a fresh whole-repository scan.

| Comparable nonblank source measure | Exact016e before | Sourcef0e846c2 after | Reduction |
| --- | ---: | ---: | ---: |
| Unique source, including tests/scripts/retained Onboard | 2,473,031 /10,136files | 1,810,041 /7,971files | 662,990lines (26.8%) |
| Separately copied runtime code | 191,844 /730files | 0 /0files | 191,844lines |
| Source including copied code | 2,664,875 /10,866files | 1,810,041 /7,971files | 854,834lines (32.1%) |

This continuation alone removes854,272net physical source lines relative to PR29; the earlier562-line net reduction is included in the before/after table. Five sealed `.txt` historical source inputs contain68,510bytes/1,522nonblank data lines, disclosed outside the unchanged source-count classification. All JSON/data, generated parser output, assets, docs and dependency/build outputs remain governed by the original exclusions. Lower LOC is a consequence of ownership cleanup, not runtime or coverage proof.

## Path and consumer transition

The pre-edit exact consumer map remains immutable at `../backend-cleanup-20261016/REFERENCE-MAP.md`. This packet records the implemented transition; historical preparation, qualification, ownership and runbooks remain unchanged.

| Source paths | Actual consumers and resulting owner |
| --- | --- |
| `apps/web/src/**`, root Web HTML/Vite/TypeScript/package inputs | Main Web source compilation and its UI suites retire from the backend workspace. `WEB-SOURCE-RETIREMENT.json` records all2165 source paths/blobs, including2151 code paths and701 retired UI test file identities. Fourteen non-code source operands move as exact Git blobs to `tests/support/legacy-web/source-data/`. The701 are file counts, not inferred test-case counts or passing replacement coverage. |
| `apps/web/scripts/**` | Thirteen backend-consumed harness modules move to `tests/support/legacy-web/` with exact literal path inverse and original sibling imports. Seven old browser/capture CLIs retire; `WEB-BUILD-TOOL-RETIREMENT.json` records their identities and all24 root build inputs. Two CLI bodies plus original package remain sealed data for the existing grammar/resource-denial controls. |
| Root package/workspace/lock | Default build/dev/lint/test/typecheck select backend packages. Onboard and E2E remain present but outside those backend defaults. Mixed Engagement/Outreach/Research/Phase26 aliases use explicit backend scopes. Seven old main-Web frontend aliases refuse with exit2. Only the `apps/web` lock importer is removed; dependency snapshots and every other importer stay byte-exact. The finite inverse helper admits only exact reviewed changes and rejects unrelated manifest/lock mutations. |
| `apps/web/Dockerfile` | Uses the existing `Dockerfile.frontend-artifact` body and mandatory source/manifest/platform pins; no legacy source compilation fallback. The existing accepted artifact gate, runtime digest, dependencies, user and port remain identical to that compatibility recipe. This changes the default source recipe; no image was built or deployed. Existing infrastructure and release operators remain unchanged and require explicit artifact inputs before this path can qualify. |
| `apps/web/public/**`, `nginx/**`, compatibility Dockerfile | All129 public assets and nginx retained. No serving URL migration is claimed. Source/URL and separately built frontend artifact serving closure still need integrated qualification. |
| `apps/onboard-web/**` | Retained because `apps/onboard-api/Dockerfile` builds it and `src/main.ts` serves its SPA. The source API/Docker/image/security inputs remain unchanged. An opt-in artifact recipe does not establish accepted default replacement. |
| `apps/e2e/**` | Retained. Backend cleanup gates still import its report/source-identity/renderer helpers. Global full-source visual obligations are separately unqualified. |
| API and Intel qualification readers | Read existing API-owned UI inventories or three sealed historical source operands. Two pure harness test modules retain their cases. Three full retired-UI traversal/generator cases retain original identities in an explicit historical replay suite requiring a clean pinned full-source input; missing input fails collection. No extra full checkout was created. |
| `apps/defense-api/runtime-source/**` | All727 remaining TypeScript implementation/spec copies retire;317 exact canonical API spec twins remain. All17 data files, nine replay fixtures and nested provenance README stay byte-exact. See `RUNTIME-SOURCE-CONSOLIDATION.md` and the executable ownership manifest for every old/canonical path/blob. |
| Defense adapters/build/replay/verifiers | Adapters, runtime registry/manifest, Docker/typing and replay stay unchanged. Compatibility verifiers now require canonical code ownership and retained data parity. Replay's two fixture roots use the same compiled adapter; no independent pipeline or parser execution is claimed. |

Archived source operands are qualification data, not another executable frontend. Their byte/nonblank totals are disclosed separately in the count report because the original counting rules exclude `.txt` data. Nothing is removed from Git history.

## Protected candidates and source claims

Frozen shipping `cd3c51e940f14e1b2a1040b0ffa445e85d68b332`, Engagement016e, inactive docs-only PR28 `51678e1297cb5146562bf20d52e97990f81e77fc`, and Objective `622905839c7a510ab01a512ef8012926b2e1b4ce` remain separate preserved candidates. Objective/Engagement models, migrations30000/40000, registrations, shared contracts and Strategy planner require additive fieldwise integration by their owners. Disabled Objective canonical-work/dispatch intent is active source, not cleanup material.

Core current-membership ownership also remains untouched: `auth/application-membership*.ts`, narrow `auth/application-authority.module.ts`, optional bound in `memory/memory-wall.helpers.ts`, and two membership no-store path strings in `tenant/tenant-context.middleware.ts`. ContextSecurityScope remains unchanged. No cleanup production auth/context/memory/tenant edits occur.

`RETAINED-BOUNDARIES.json` compares protected sources, API/Defense migrations, canonical runtime, backend deployment manifests, Onboard/E2E and assets with exact pre-cleanup source. The only API `src` edit relocates one UI-only native test case and harness reader paths. Operational runbooks, licenses/provenance, release-critical configuration, data and original evidence remain. No cloud, live source, database, migration execution, credentials/security policy, merge or deployment action occurred.

The local clone has its own `.git` and branch; shared object alternates depend on **both** task3 `backend-plan-implementation/.git/objects` and `backend/.git/objects`. Preserve both stores while the clone uses them.

## Qualification and remaining blockers

`VALIDATION.json` and `evidence/` contain exact argv, source context, actual exits, timestamps, PID/timeout cleanup, sampled memory where available, original failures and repaired results. Checks are bounded source/builtin controls. They establish source ownership and command/fixture contracts, not native application, image or production readiness.

- Runtime ownership19cases and both real source verifiers pass. Workspace manifest/lock guards24cases pass. Current backend reader/harness85cases pass after restoring the CTA fixture's canonical Git LF bytes; exact `.gitattributes` rules preserve these operands on Windows.
- Historical inventory32cases produce27pass/5fail. The identical old Web/API inventory blob already has15 unmapped requests,86 null surfaces,26 scanner findings, two V3 consumers and15 uncovered current backend routes. Every original failing assertion remains. Negative controls now require a newly introduced matching diagnostic, so inherited invalidity cannot make a mutation falsely pass. Backend inventory CLI refuses with INVALID; this is an acceptance blocker, not current frontend coverage.
- Archived visual CLI controls run25 inert scenarios, then both original package assertions fail because the old exact package commands omit their required opt-in flags. All27 scenarios/144 assertions remain; the whole command exits1. No browser or performance run occurred.
- Initial artifact source batch40cases:29pass/11fail. The packet preserves these results. New default-recipe text/manifest guard issues are repaired separately. Inherited Onboard Windows fake-filesystem/POSIX-root and symlink-permission failures remain unqualified; no ACL or permission workaround was attempted. Source equality guards retain exact approved Prisma dependency relocation history rather than changing the production API manifest.
- Final default artifact source controls pass3/3; the selected repaired Onboard source-prefix guard passes1/1. The subsequent Phase3 source-scope batch passes55/55 and covers later planner/lazy-import edits. The Python source-job subset passes three of four selected stdlib cases; preservation aborts in the original PATH-only Windows Node child with exit134. Its POSIX propagation case remains unrun. These results do not qualify the full historical CI suite.
- Owned preview-pattern check still refuses five inherited Krisp paths outside its reviewed prefix/exclusions. Exact source proof reverses the sole output-path substitution to the original generator and shows all nine route manifests unchanged. Refusal occurs before reading the archived output; no rule/table/domain-authority change was made to silence it.
- Historical full UI replay requires an existing clean exact4e full-source checkout, current frontend browser/URL parity requires its owner/artifact, and Onboard default source retirement lacks an accepted replacement. Those scopes remain explicit.
- Native API/Jest/typing, full backend builds/tests, lock install resolution, image/artifact builds, adapter behavioral replay and integration across protected feature candidates have not run here. Use the shared local queue at the integrated/release checkpoint. Do not infer shipping or deployment approval from this draft.

Rollback is the inverse source patch against the exact parent. Canonical backend source/data and all historical bytes remain recoverable without history rewriting or live-resource changes.
