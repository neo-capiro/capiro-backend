# Independent root controls review — 9a23 follow-up

Reviewed source `9a23cd7273028e97581b0605d321e69d0185d536`, tree `a75722610fcf567f6aca0294e534821c4eee5bbc`, through the actual fast-forward of the preserved reviewer branch to root's docs-merge `991ca2f88e0e2829e2ec31a33cdc2e195a870cf3`. The three changed root source paths are check-registry-ownership.mjs, its spec, and registry-ownership.json. All old e3 rejection evidence remains unchanged. Authored Tango application acceptance is excluded from this independent scope.

The first repair closes the complete preserved e3 corpus: all 25 fixture outcomes now meet their expected refusal/acceptance, all four original actual-map copy/import probes refuse, and the required RateReadProfile widening refuses through the new named-type carrier. All 144 existing source tests pass. Static runner/package/CI replay remains correct and draft-inclusive. Prototype assignment and const-require-alias leads are now also refused, rather than silently dropped.

Acceptance remains withheld for two narrower, reproduced gaps:

| Gap | Inert source proof | Result |
|---|---|---|
| Require-callee alias ignores erased TypeScript wrappers | `const load=require as typeof require; load('./external/tango/tango-rest-page.js');` | Zero errors in the actual 2,047-file map. Fixture type assertion and non-null wrappers also evade detection. |
| Supported static syntax budget silently permits a bypass | 140 parentheses around the literal `asCount` in a computed method, or around the literal canonical owner module in import() | Both return zero errors in the actual map. staticString's depth/seen budget returns null, so the supported static expression vanishes from the declaration/import census. |

The callee recognizer currently unwraps parentheses only. Apply the same inert as/type-assertion/non-null wrapper handling used for static module strings. Keep const and lexical-cycle restrictions. Exhausting the supported static-expression budget must fail the source inspection rather than behave like an unknowable runtime expression. No expression evaluation or module loading is required for either fix.

[bounded-parser-controls-9a23.json](evidence/bounded-parser-controls-9a23.json) preserves 22 additional cases. Seventeen meet expectations; the five unexpected accepts are the three erased callee wrappers plus the two deep static forms. Benign lexical shadowing, string-only templates, scoped const chains, cycles, and no-evaluation getter/call initializer controls behave as expected. Raw [whole-map-parser-9a23.json](evidence/whole-map-parser-9a23.json) proves the three representative failures against actual source data.

Direct source spelled require is conservatively treated as a loader even when a local parameter uses that name. That inherited syntactic convention is recorded; no semantic claim about arbitrary require binding or JavaScript containment is made. Unknown runtime expressions, module graphs, provider authorization and native acceptance remain outside this finite source parser.

No production source edits or mutant execution occurred. Only new named reviewer evidence was appended; previous logs, source strings and hashes are preserved. No pnpm/app-suite duplication, actual provider, database/SQL/migration, native Prisma/download, Docker/AWS, paid model, credential/security change, merge to main or deployment was performed. Root owns the next bounded source repair and supplies its frozen pin for re-review.
