# Workspace D1 product registry source handoff

Source freeze: `77e936d2a695203819b7d46277bf63ab6a659539`, tree `d5763734ebf1ad79a0257e973090e6a417817e54`. Exact base: reviewed `802bbd0b2c510a44e46a9952d8127e7edc55aaaa`, tree `6c11b1094aadcbf6645e759204f72b6f87c8982a`. Final handoff commits add documentation only above that freeze. Parent explicitly cleared the four reserved application paths; no additional retirement or product decision was inferred.

The server's eleven product descriptors now own product names, metadata, suggested sections, pages and membership/order in six compatibility projections. Nineteen CASCADE preset names reference those descriptors. Existing helpers, consumers and API shapes retain their original behavior. This is the bounded D1 product-owner conversion; it does not convert the ordered section classifier, legacy Web copy or other registries.

## Exact ownership and compatibility exports

| Path | Role / delta |
|---|---|
| `apps/workspace/src/cascade/workspace-product.registry.ts` | New local pure owner: eleven named descriptors, six independent rank fields, six one-time mutable projections. |
| `apps/workspace/src/cascade/cascade.config.ts` | One registry import, six original exported const aliases, nineteen preset name references. All other bytes reconstruct exactly to the frozen original. |
| `apps/workspace/test/product-registry-characterization.spec.ts` | New golden-based characterization and dynamic/reference/mutation checks, using inert dependencies. |
| `apps/workspace/test/fixtures/product-registry-before.json` | Immutable actual-802 preconversion outputs, captured before application edits; SHA256 `5b9e9a08b8ede106fa19ed8ff7f1341a1ff65729e8296c45ae2b328c37a01d9c`. |

Canonical owner export is `WORKSPACE_PRODUCT_REGISTRY`. The original consumer exports remain const aliases:

| Existing config export | Canonical projection |
|---|---|
| `PRODUCT_META` | `WORKSPACE_PRODUCT_METADATA` |
| `SUGGESTED_SECTIONS` | `WORKSPACE_PRODUCT_SECTIONS` |
| `SUGGESTED_PAGES` | `WORKSPACE_PRODUCT_PAGES` |
| `CANONICAL_PRODUCTS` | `WORKSPACE_PRODUCT_CANONICAL` |
| `UNIVERSAL_PRODUCTS` | `WORKSPACE_PRODUCT_UNIVERSAL` |
| `FUNDING_PRODUCTS` | `WORKSPACE_PRODUCT_FUNDING` |

The registry imports the existing `ProductMeta` interface with `import type` only. It emits zero runtime imports, so there is no runtime back edge to config. No generic owner, service/store, parser dependency, barrel, persisted ID, enum validation or new feature policy is introduced. Descriptor selector property names are local typed references, not new externally persisted product identifiers.

Each projection has its own explicit zero-based rank; null means nonmembership. Their original orders differ and are not inferred from a common library order. Plain objects/arrays remain mutable. Metadata and section projections retain descriptor object/array references; each product keeps distinct metadata and sections, including equal-valued White paper/NDAA section arrays. Projections initialize once rather than recomputing on lookup. Config's const aliases preserve writable CommonJS namespace properties; getter re-exports would change that contract.

`WSC`, `sectionSpecFor`, all original interfaces, industry data and section library remain byte-exact. This preserves unknown/case/whitespace fallbacks, inherited prototype values and failures, detached receiver errors, known shared references, returned copies, export mutation visibility, zero-page `|| 2`, first-match section precedence, fresh word tuples, pathways/committee ordering and layout/default values. No prototype hardening or authorization acceptance is inferred. Public field/API/DTO/schema/route delta is zero; no controller, service, generation, draft/check consumer or legacy Web source changed.

## Original evidence and checks

The BEFORE snapshots are actual base config, CascadeService and original cascade spec, additionally verified byte-equal with the earlier audited PR 2412 source. `capture-before.cjs` reads those snapshots and refuses to overwrite an existing golden. Candidate tests and the pure differential assert the captured fixture hash; expectations are not regenerated from candidate code.

| Check | Result / retained evidence |
|---|---|
| New characterization | 115/115 pass, exact accepted Jest JSON/logs. Includes 21 product/default profiles, 11 industry/pathway/committee profiles, 78 section profiles and five fixture/export/reference/mutation/alias checks. |
| Pure before/after differential | Exact serialization/key order, dynamic/prototype/fallback/error profiles and mutation/CJS alias behavior match the fixed golden. |
| Focused semantic compiler | Cached TypeScript strict + noUncheckedIndexedAccess passes for config, registry, unchanged thin service and new spec. This is not the full Workspace compiler or native acceptance. |
| Source preservation | Reversing only the six initializer substitutions, nineteen name references and registry import reproduces the entire original config byte-for-byte. Service and old spec are byte-exact. |
| Original cascade suite | Same 6 pass / 1 fail before and after. `allLibraryProducts` still returns White paper plus ten canonical entries (Q-LIB-A); the unchanged assertion expects ten. No green full-suite claim. |

All failures remain: the original stale cascade assertion before/after, the first compiler attempt missing explicit cached typeRoots, then four and one guarded test-indexing diagnostics. Only test assertions/type resolution were corrected; runtime source did not change. First/final/accepted passing characterization outputs are also retained. Raw logs were not normalized to satisfy whitespace checks; application diff whitespace passes separately.

Checks used direct cached Node/TypeScript/Jest/ts-jest, a local untracked `/tmp` dependency symlink, and an identity Injectable stub. No package installation, generation, bootstrap, actual authentication, provider/model, database/SQL/migration/Prisma, AWS, upload or customer mutation ran. Type and inert checks are not native PostgreSQL/RLS/concurrency acceptance.

## Root dependencies and overlap matrix

| Owner | Required integration / preservation boundary |
|---|---|
| This application slice | Exactly the four paths above plus this unique docs packet. No source retirement. |
| Root registry guard/data | Bind this exact owner, eleven descriptor names, six config const aliases, nineteen descriptor `.name` references and zero runtime back edge. Add positive and adversarial data/grammar controls in the same publication. |
| Root package/CI/handoff | Same-change profile, alias and CI adoption is required before claiming adoption. This author changed none of those files. |
| Existing dynamic/library behavior | Preserve the original WSC White paper literal/Q-LIB-A branch, unknown/prototype semantics and current separate consumer heuristics; no name-only or directory-wide exemption. |
| Other application conversions | Strategy/Tango/shared seams and retirement maps are disjoint. No integration or acceptance is inferred by this same-base slice. |
| Legacy Web mirror | Existing five tables remain outside this backend conversion and unchanged. |

Independent adversarial source review and root's same-change guard/data/CI integration remain pending. Root owns the draft publication; no main merge or deployment is authorized by this packet. The inherited stale assertion is explicit and is not a requested product decision for this author to change. Wider full-tooling/native/HTTP/security/Cleanup acceptance remains unclaimed.

`COMMANDS.json` records exact scoped commands/statuses; `SOURCE-MANIFEST.json` binds the source freeze and four current raw hashes; `SHA256.json` covers the docs packet except itself. Original source head and all new evidence descendants remain preserved.
