# Core service responsibility cleanup proposal

Source basis: backend receiving PR96 commit `784b1c3a91eb6d78f16d92c42e71f05c12c5b5bb`. This is a separate, docs-only proposal. It changes no runtime code, preview release input, route, grant, or migration.

## Measured size and first ownership seams

Physical line counts include blank lines. The after figures are estimates for the proposed narrow moves and will be measured in the implementation review.

| Source | Current | First move | Estimated source after move |
| --- | ---: | --- | ---: |
| `apps/api/src/meri/meri-tools.service.ts` | 11,038 | Move the 8 Funding Opportunity schema entries at lines 2192–2276 and 6 prospect BizDev schema entries at 2277–2367 into two owner-local schema modules; about 176 lines leave the service, with a few import/spread lines added. | about 10,870 |
| `apps/api-strategy/src/planner/planner.service.ts` | 6,383 | Move report query validation at lines 5233–5241 and 5250–5265 to `planner-reporting.validation.ts`; move revision handling at 5242–5249 and report result/page shaping at 5416–5447 to `planner-reporting.ts`. About 60 lines leave, with thin calls added. | about 6,330 |

The Meri schema move should create one module next to the Funding Opportunity owner (`apps/api/src/funding-opportunities/meri-opportunity-tool-schemas.ts`) and one next to the BizDev owner (`apps/api/src/meri/meri-bizdev-tool-schemas.ts`). They should accept the existing schema constructors, preserve the literal field descriptions and required arrays, and return only their own named entries. `MeriToolsService.anthropicToolSchemas` remains the ordered join using `TOOL_DEFINITIONS`. Its rollout filtering at lines 2370–2385, capability registry, execution dispatch, and client/prospect authority checks stay where they are. The complete schema method is 1,712 lines (674–2385), but moving it wholesale would merely create another oversized file.

Planner already has small reporting modules: `planner-reporting.validation.ts` (148 lines), `planner-reporting.ts` (177), `planner-reporting-data.ts` (198), and `planner-reporting-sharing.ts` (130). Extend those owners with pure query and result functions. `PlannerService.reportWidget` (5227–5449) keeps `scope(ctx, ...)`, dashboard/project access, tenant-bound SQL, visible-source and field selection, and task filtering. In particular, do not move the `scope` transaction/tenant wrapper at lines 312–324 or change its read/write lock behavior. Moving the full report method or introducing a new injected service first would require several private access callbacks and is a larger behavioral change than this proposal needs.

## Focused verification for a later implementation

1. Before and after the Meri move, compare the ordered names and exact JSON schemas under both status-provenance and Research Portfolio rollout modes. Run `meri-tool-manifest.parity.spec.ts` and the schema section of `meri-tools.registration.spec.ts`; add a narrow assertion that every Funding Opportunity schema still requires `clientId` and prospect schemas expose only the existing `conversationId`/bounded inputs. This protects the client-scope gate described at lines 2192–2199 and the prospect authority exclusion at 2277–2282.
2. Before moving Planner report helpers, add a small service-level characterization for `reportWidget`: hidden saved sources/fields remain withheld, an explicitly restricted source never broadens to all projects, a stale revision conflicts, and row pagination remains stable at 100 rows. Existing `planner-reporting*.spec.ts` exercise pure aggregation/sharing/data, while `planner.http.spec.ts` stubs `PlannerService`; neither proves this service-level read path. Then run those focused suites and a scoped TypeScript check.
3. Compare the exact touched-file diff and physical line counts. Keep any later transaction, permission, or SQL ownership extraction in a separate review after the characterization passes. Do not bundle either cleanup with the non-Meri Portfolio/Modules preview release.

This first pass intentionally makes modest reductions. It moves coherent, low-risk responsibilities without adding broad helper layers, changing error behavior, or recasting the service APIs.
