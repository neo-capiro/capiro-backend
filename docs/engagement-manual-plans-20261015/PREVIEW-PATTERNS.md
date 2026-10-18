# Manual Engagement plan preview-pattern handoff

Read-only audit, 2026-10-16 UTC. The manual feature adds **seven distinct anchored path patterns for nine HTTP operations**, with no removed covered path. This report was initially authored as a task-local handoff and then copied into this candidate's documentation. No application source, generated map, route admission, permission, environment or sealed evidence was changed by the audit.

## Exact seven new patterns

These are the exact strings and order returned by the existing generator's `buildPatterns` function, comparing the current feature manifest with frozen backend `cd3c51e940f14e1b2a1040b0ffa445e85d68b332`.

| Full backend path                             | Methods / normal success status | Exact regex source string                     |
| --------------------------------------------- | ------------------------------- | --------------------------------------------- |
| `/api/engagement/plans`                       | GET 200; POST 201               | `^/api/engagement/plans$`                     |
| `/api/engagement/plans/:planId`               | GET 200; PATCH 200              | `^/api/engagement/plans/[^/]+$`               |
| `/api/engagement/plans/:planId/history`       | GET 200                         | `^/api/engagement/plans/[^/]+/history$`       |
| `/api/engagement/plans/:planId/reviews`       | POST 201                        | `^/api/engagement/plans/[^/]+/reviews$`       |
| `/api/engagement/plans/:planId/waves`         | POST 201                        | `^/api/engagement/plans/[^/]+/waves$`         |
| `/api/engagement/plans/:planId/waves/:waveId` | PATCH 200                       | `^/api/engagement/plans/[^/]+/waves/[^/]+$`   |
| `/api/engagement/plans/:planId/waves/reorder` | POST 201                        | `^/api/engagement/plans/[^/]+/waves/reorder$` |

The generator deduplicates paths, sorts them and replaces a parameter segment with `[^/]+`; it does not encode methods or UUID validation. Therefore the generic wave-ID pattern also matches the literal `reorder` segment. Keep the exact generated set and the separate method/operation allowlist. The controller's UUID pipes and canonical input validation remain authoritative.

Sources: [feature manifest, first new entry](https://github.com/neo-capiro/capiro-backend/blob/9a151f4dbf9e910ce9a78c3cb40a5dc53390508e/apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json#L3104), [controller](https://github.com/neo-capiro/capiro-backend/blob/9a151f4dbf9e910ce9a78c3cb40a5dc53390508e/apps/api/src/engagement/plans/engagement-plans.controller.ts#L32), [generator parameter conversion](https://github.com/neo-capiro/capiro-backend/blob/9a151f4dbf9e910ce9a78c3cb40a5dc53390508e/scripts/engagement-phase3-preview-route-patterns.mjs#L82), [generator path deduplication](https://github.com/neo-capiro/capiro-backend/blob/9a151f4dbf9e910ce9a78c3cb40a5dc53390508e/scripts/engagement-phase3-preview-route-patterns.mjs#L90).

## Current source owners and required action

The backend repository's inherited browser map is `apps/web/src/lib/engagement-api-preview-routes.generated.ts:39`. Its consumer is `apps/web/src/lib/engagement-api-preview.ts:24`, which compiles these anchored path patterns at line 41 and owns the `X-Capiro-Engagement-Preview: v3` header at lines 30–31. The generation owner is `scripts/engagement-phase3-preview-route-patterns.mjs:55`. This is the legacy browser source carried in the backend repository.

The **actual new frontend** has a different gateway. Direct reads of the separately allocated candidate at `C:\Users\neoma\Documents\Codex\2026-10-14\task-3\objective-plan-desktop-bindings` show:

| Source                                                         | Exact current role / owner action                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/shared/capiro/operations/engagement-plans.ts:37` | Already declares all nine manual-plan fixed operations, each `service: "core"`, method, `/engagement/plans...` path and request/response schema. The integration owner should retain these explicit bindings and qualify them against the reviewed backend successor/WIRE pin. |
| `apps/web/src/shared/capiro/registry.ts:18` and `:38`          | Already imports and composes `engagementPlanOperations` into the gateway allowlist. No missing registry addition was found in the observed candidate.                                                                                                                          |
| `apps/web/src/app/api/capiro/[operation]/route.ts:14`          | Applies preview admission first; line 17 selects the dedicated read-only preview branch. Ordinary dispatch uses the fixed-operation registry at line 39.                                                                                                                       |
| `apps/web/src/shared/preview/read-route.server.ts:44`          | Current preview map admits only GETs for backend `/me`, `/clients`, `/clients/:id`, exposed through the existing fixed/direct browser paths. It does not admit plan list, detail, history or writes.                                                                           |
| `apps/web/src/shared/preview/backend-policy.server.ts:5`       | With read-only preview configured, an unadmitted plan request returns 503 `PREVIEW_BACKEND_HELD` before backend dispatch. Adding a fixed operation does not alter preview admission.                                                                                           |
| `apps/web/src/shared/preview/read-config.server.ts:4`          | Preview deployment binding remains `111f269d749cae0249c2141779bd6d7deb93f45c`; it requires the existing explicit server configuration and has no ordinary Core fallback. This audit does not replace that binding.                                                             |

The new frontend does not consume the backend repository's legacy regex map. Deliver the seven-pattern delta to the frontend integration owner as exact routing evidence. Do not copy the legacy map into the new frontend or treat these patterns as permission to expand the current read-only preview. If a preview transport extension is desired, its owner must receive a separate explicit allocation and preserve method, source, auth and containment checks. The currently allocated ordinary fixed-operation bindings and generic 409/reload fallback need no shared gateway-error or HTTP changes from this audit.

Current frontend operation names, with source anchors in `operations/engagement-plans.ts`:

| Operation                       | Line | Method / relative Core path                     |
| ------------------------------- | ---- | ----------------------------------------------- |
| `engagement.plans.list`         | 38   | GET `/engagement/plans`                         |
| `engagement.plans.detail`       | 46   | GET `/engagement/plans/:planId`                 |
| `engagement.plans.create`       | 54   | POST `/engagement/plans`                        |
| `engagement.plans.update`       | 62   | PATCH `/engagement/plans/:planId`               |
| `engagement.plans.wave.create`  | 70   | POST `/engagement/plans/:planId/waves`          |
| `engagement.plans.wave.update`  | 78   | PATCH `/engagement/plans/:planId/waves/:waveId` |
| `engagement.plans.wave.reorder` | 86   | POST `/engagement/plans/:planId/waves/reorder`  |
| `engagement.plans.review`       | 94   | POST `/engagement/plans/:planId/reviews`        |
| `engagement.plans.history`      | 102  | GET `/engagement/plans/:planId/history`         |

## Feature delta and inherited baseline drift

The in-memory audit imported the existing generator from each checkout and read the primary Engagement and eight configured additive Outreach V3 manifests. It did not invoke `--write`. Frozen derived coverage is 158 patterns; feature derived coverage is 165, exactly the seven paths above. Removed paths: zero. Both checked-in maps contain 155 patterns and have identical SHA256. Both differ from their own current in-memory derivation.

Both CLI gates already stop on the following same five unaccounted paths, before checking generated artifact text:

```text
/api/clio/krisp-notetaker
/api/clio/krisp-notetaker/folders
/api/clio/krisp-notetaker/imports/:id/candidates
/api/clio/krisp-notetaker/imports/:id/match
/api/clio/krisp-notetaker/preferences
```

These inherited paths are outside `/api/engagement/`. No exclusion or routing permission was broadened. This diagnostic derivation is **not a passing CLI or generated-artifact gate**. The five existing failures and pre-existing artifact drift belong to their existing owners, separately from the seven new manual-plan patterns.

Retained receipts: [qualification failures](../backend-plan-implementation/docs/engagement-manual-plans-20261015/QUALIFICATION.json#L99), [frozen diagnostic derivation](../backend-plan-implementation/docs/engagement-manual-plans-20261015/QUALIFICATION.json#L149), [feature diagnostic derivation](../backend-plan-implementation/docs/engagement-manual-plans-20261015/QUALIFICATION.json#L325), [exact seven-path delta and limitation](../backend-plan-implementation/docs/engagement-manual-plans-20261015/QUALIFICATION.json#L507), [review limitation](../backend-plan-implementation/docs/engagement-manual-plans-20261015/REVIEW.md#L46). No new test process or CLI rerun was needed for this documentation audit; the read-only Node 24 derivation independently reproduced those retained diagnostic values.

## Source identity and limits

Observed backend feature HEAD during this audit: `9a151f4dbf9e910ce9a78c3cb40a5dc53390508e`; frozen source: `cd3c51e940f14e1b2a1040b0ffa445e85d68b332`. Root is preparing a SQL-only successor. The observed route/generator references establish the audit source; they do not claim qualification or acceptance of that successor.

| SHA256 source          | Frozen                                                             | Observed feature                                                   |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Primary route manifest | `390f1f6819af5dc8e3059721ab961571be3815f48b75f69e6d46e51bcc0e1d74` | `162901efd77490e3a00d4cec8245c2c03fbefd58338422f6cef86a65bb35f8e9` |
| Existing generator     | `6bd9d1861ee98b20f53ee5d516f27949152058ffc16fee5087de966aff0e8d4d` | Same                                                               |
| Checked-in legacy map  | `52d4860d305acd1c34774cde5f5eeabbd36aadbdd1b0de487f4311bd7262421f` | Same                                                               |
| In-memory derived map  | `042872e7371a53935b7d2b5fa124910bf3a7d31a5d0d565103c9efa23408057a` | `f2598db374a8b1b8edfb48059fd67b58ac17980e073190d1abb6bc62dc2b9cbd` |

Frontend candidate direct-file SHA256 at observation:

| Path relative to candidate                                  | SHA256                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/web/src/shared/capiro/registry.ts`                    | `694bb2a7c1d0b41ad90e5dc5686a5dbc6dfbfa3ce7ad99e4430243b38e67aaef` |
| `apps/web/src/shared/capiro/operations/engagement-plans.ts` | `4e44866541fe03cd125261ca860a6309e6da9eafb8fe46e172aeef324594c67d` |
| `apps/web/src/shared/preview/read-route.server.ts`          | `7ba7496a8a029b1f43b67f11198d971808a1dd970efc3198e7a3f7b16a9c04c1` |
| `apps/web/src/shared/preview/backend-policy.server.ts`      | `4cec5468e72489a1f4ff8b9d62b1561eea7f616d472bc6eb6337cda01ca14804` |
| `apps/web/src/shared/preview/read-config.server.ts`         | `6f1dcd5cc48178771bbcc6a073cd8c23efe6deaa966bbe59c2796d7c7da154b8` |

The parent identifies that candidate as `feat/non-meri-objective-plan-bindings`, based on sealed frontend `9da3616a`. Direct source reads above succeeded. Running `git rev-parse HEAD` and `git status --short` with that external candidate as Git's working directory was **denied** (`cannot change ... Permission denied`); neither command was retried or bypassed. Its current commit/dirty state is therefore not independently verified here. The source hashes are observations of active owner files, not an immutable frontend qualification receipt. Accepted local frontend `2758775ddf0e3b17898370be61540498344a9f57` remains untouched; its registry has no manual-plan operations yet.

Handoff delivery: return this artifact and exact patterns to the parent for delivery to frontend owner thread `01a13c71-7ff1-7660-a7c8-de25cc94401c`. No external thread message, source publication or runtime change was performed by this audit.
