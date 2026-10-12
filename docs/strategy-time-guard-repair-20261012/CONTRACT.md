# Bounded Strategy time guard repair

Frozen source: `61804fd16f2ab3cd44e4ef5b4b60d1a2960a7e8f`, tree `a61515fffdf1fd5499f4305de360867b353f529f`. Integration base: `f86bf11b9b6da367d464da453ee1f260fa60e06e`, tree `b0389feda4b907bd0e6f222c1301458bebe74d79`. Root remains the sole integration owner.

The previous AST guard accepted 14 reported alias, computed-member, retry and helper-definition bypasses, a hoisted aliased import, and four further canonical member definitions. The original receipts and reproduction retain all 19 accepted cases and two rejected direct controls. The repaired exact-source corpus rejects all 21 cases against the same 169 production files. Mutant strings were parsed and analyzed; none were executed.

The guard binds lexical symbols and inventories imports, initializers, destructuring, class fields and simple assignments before examining uses. Static string literals, const aliases, concatenations and templates resolve computed members. Known time namespaces with unresolved computed members fail closed. Date constructors with explicit dates and ordinary date arithmetic remain permitted; capturing a Date constructor as an alias is refused. Lexical parameter, block and class-field shadows stay independent. No module resolution, external source loading, emission or semantic diagnostic execution occurs during the one-file lexical analysis.

Canonical helper ownership now includes quoted and static computed methods, function-valued object/class properties and get/set accessors. Retry aliases and references cannot hide new consumers or optional runtimes. Shared hook calls remain refused everywhere. Shared hook values may appear only under the exact data-owned `STRATEGY_TIME_PROVIDERS` variable in the existing provider file, outside function bodies; other callback, constructor-default and forwarding-export references are refused. This adds one exact registration boundary, not an ambient sample allowance.

| Integration path | Owner and effect |
| --- | --- |
| `scripts/check-strategy-time-bypasses.mjs` | Lexical/static reference checks; existing event identities and CLI behavior preserved. |
| `scripts/check-strategy-time-bypasses.test.mjs` | All original 29 cases preserved; 82 total controls cover reported bypasses, bounded variants, benign source and lazy provider registration. |
| `scripts/strategy-time-boundaries.json` | Every original data field is unchanged. Only `systemHookValueOwners` is added for the existing provider variable. |
| This documentation directory | Retained raw RED, failed-development and PASS evidence; no production code. |

The existing allowance array remains exactly 119 identities and 126 samples: 116 deferred identities for 123 original samples plus three lazy canonical defaults. Six required retry calls still require `this.retryRuntime`. Required files, roots, canonical helper files and all allowance maxima/reasons/statuses are unchanged. The array's JSON SHA-256 remains `9f2c2ef37f7159d96d4a9900a3c3cca70557d48957d0ff7f0d05cca7318de7a1`.

This is a finite source ratchet for the declared Strategy roots and canonical helper. It does not establish arbitrary runtime containment, interprocedural behavior of unknown functions, dynamic code evaluation, other OS clocks, native database acceptance or completion of all Cleanup Wave 1 work. Existing deferred samples remain open. The app, shared utility, packages, workflows, frontend contracts and excluded reporting owner were not changed or reassessed by this repair.

Validation is limited to installed TypeScript AST checks: 82 permanent tests, the actual 169-file guard, all 21 exact reported controls, inventory/test preservation, and CLI help/unknown argument behavior. Only the original fixed shared utility test runs code, in its established VM with fake Date, Math and timer; mutant source never runs. No database, migrations, native engines, providers, cloud or customer mutations occurred.

Independent B review of the frozen source is required before root integration. Its final receipt will be appended separately without replacing failed or passing author evidence.
