# Phase 12 exact provider inventory qualification

This CI-only correction preserves the shared Context Plane provider boundary and
all production provider/model selection. The old repository-wide literal grep
failed on 14 unchanged occurrences already present in main
42942dedad59382f4b4aac6f904b9aee0e02efa6. The same paths, source lines, occurrence
counts and two surrounding lines were verified at Meri foundation
7612a019ed41d09142b5ed0f840322415c35a984 and focused release
97e54c55a2e5c47ad1fb469b752fdf1256a60044.

Phase 12 scopes its abstraction to the shared Context Plane
(phase-12-embedding-provider-abstraction.md). Its literal-rejection acceptance
rule is now qualified by this exact frozen legacy inventory, rather than broad
file or subsystem exclusions. The sole existing shared Titan adapter exclusion
is unchanged. The independent shared-API Bedrock SDK guard and inherited OpenAI
compatibility guard remain byte-for-byte unchanged.

## Qualified existing owners

The inventory records five runtime/model-owner occurrences:

- Defense budget/read services retain model identity for stored-vector filters.
- The Defense dark embedding port exposes metadata and returns no query vector.
- Defense cross-domain selection owns its existing explicit-switch, dark default
  (docs/defense-budget/phase8-session9-provider-design.md).
- Intel's query-side embedding adapter is a real separate invocation boundary,
  expressly retained by docs/plans/capiro-intelligence-unification.md:3138.
  This correction does not create, migrate or generalize that adapter.

The other nine occurrences are one Prisma schema comment and eight test or
controlled validation-script fixtures. Those fixtures assert infrastructure
restrictions, vector model parity, preservation of embedding model IDs during
text-model upgrades, or SQL/audit-row behavior. Their qualification does not
authorize running verification scripts against shared databases.

## Exact enforcement

scripts/verify-phase12-provider-inventory.mjs scans the same tracked apps,
packages and scripts scope as the former grep. The reviewed inventory is stored
outside that scope at phase-12-titan-legacy-inventory.json, with the pinned main
commit, exact path, line text, surrounding context, within-line occurrence count,
classification and owner reference for each site. A pinned content digest
prevents silent inventory editing.

A new, duplicate, missing, moved or context-changed occurrence fails. This includes
new coupling in an already qualified file and duplicate tokens on one line.
Line-number shifts alone are permitted; source context is compared after CRLF to
LF normalization. Unknown inventory shape, changed pin, malformed entries and
Git/read errors fail closed. The validator never learns exceptions from HEAD.
Changing an owned site requires a deliberate reviewed inventory update.

The implementation does not change model values, provider factories, credentials,
IAM, routing, vector dimensions, retrieval behavior or feature flags.

## Validation boundary

The focused Node test suite covers the reviewed baseline/current tree, new leaks,
same-file and same-line duplicates, changed context, moved/missing ownership,
comment-to-code changes, malformed inventory, Git failures, and the retained
sensitive-API Bedrock guard. Real Git fixtures verify scan behavior; no provider
or database is invoked.

Passing this local guard and its tests is not a claim that the entire Phase 12
workflow, hosted CI, live service or Full File01 acceptance has passed. Exact
command logs, exits and independent review are retained in the Meri task evidence.

The exact complete provider-guard shell block was also run locally. The Titan
guard and focused tests passed, then the unchanged legacy OpenAI guard failed
on apps/api/scripts/backfill-clio-memory-embeddings.ts. That separate failure is
retained; this patch does not waive or modify its guard. Full workflow green is
not claimed. Both push and pull-request filters include the new validator,
test and inventory paths so later standalone edits rerun this acceptance job.
