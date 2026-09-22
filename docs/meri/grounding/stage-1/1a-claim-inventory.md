# Stage 1a: material-claim inventory and exact-source eligibility

Stage 1a observes released MeriV3 chat answers. It never holds, delays, retrieves for, rewrites, or otherwise changes an answer. `enforce` intentionally behaves as shadow during Stage 1.

## Inventory rules

`extractMaterialClaims` deterministically segments prose while retaining citation markers with their sentence. It recognises Markdown bullets, numbered lists and headings, and avoids splitting common titles and bill identifiers. Compound factual statements split on semicolons, `while`/`whereas`, or separately cited/predicated conjunctions. Marker identity resolves to `MeriCitation.stableId` first and then `tool:id`. Uncited positive assertions remain material with an empty evidence list.

Existing lexical cues classify claims: recommendation (`recommend`, `should`), inference (`may`, `could`, `likely`), uncertainty (`unclear`, `unknown`), otherwise fact. The first `inferClaimCategories` result supplies category; no category becomes `unclassified`.

Greetings, questions, formatting/meta text, brainstorm headings/options, and labelled recommendation headings are exclusions. A labelled section still produces a material claim when it contains a factual assertion such as an amount, date, identifier, named status/stage, or real-entity `is`/`was`/`has been` predicate.

Examples:

- `H.R. 1 passed [1].` is one cited fact.
- `H.R. 1 passed [1], while funding fell [2].` is two compound facts.
- `Acme received $5 million.` is an uncited material fact.
- `Recommendations:` is excluded, but `Recommendations: Acme was awarded $5 million.` is retained.

## Exact-source eligibility

Known attachment/client-document references resolve by explicit id, filename heuristic, or single-document pronoun heuristic. The latter two are labelled heuristics and never represented as deterministic identity. No retrieval is performed.

Document-specific claims require the exact source and return one reason:

- `ok`: correct readable source with a relevant passage.
- `no_document`: no matching known document.
- `unreadable`: failed, pending, unsupported, or empty extraction.
- `metadata_only`: filename/metadata exists without content.
- `no_relevant_passage`: readable source has no bounded relevant passage.
- `version_mismatch`: requested and observed versions differ.
- `wrong_client`: source is outside requested client scope.

`ready`, `partial`, and `indexed_or_extracted` may be readable. Filenames, metadata-only records, empty extraction, and failed reads never count as content.

## Measurement

Fixture `claim-inventory-v1.json` contains 32 synthetic, non-sensitive cases with fixed tuning/held-out splits.

- Tuning: recall 1.000 (14/14), precision 1.000 (14/14). Required floors: recall 0.90, precision 0.80.
- Held-out: recall 0.923 (12/13), precision 0.923 (12/13). Reported only; no threshold is asserted.

## Rollout and log

`MERI_CLAIM_ASSESSMENT_MODE|_TENANTS|_SURFACES` independently controls execution and defaults dark. Eligible MeriV3 chat turns schedule work only after the text event. A two-second soft deadline and exception boundary protect the released response.

One `meri.claim_inventory` structured event contains `conversationId`, `turnId`, `claims`, `material`, `uncited`, `compound`, `byKind`, `byCategory`, `documentClaims`, `eligibilityFailures`, and `durationMs`. Failures use `meri.claim_inventory.failed`; they never affect the answer.

## S1-B handoff

S1-B consumes the material claims, citation/evidence ids, claim kind/category, and exact-source eligibility outcome to select bounded post-release Jev questions. It must preserve the same no-blocking/no-retrieval-from-shadow boundary.
