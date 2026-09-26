# JEV A2 FedRAMP negative-claim scope — acceptance

## Scope and baseline

- Baseline: `06748f1ccdb87b285721d696d6f4551d208fd814`.
- Isolated worktree/branch: `C:\dev\main\jev-a2-fedramp-negatives-worktree` / `jev-a2-fedramp-negatives-20260925`.
- No feature flags, routing, provider configuration, or deployment changed.

## Defects reproduced and corrected

The saved FedRAMP HTML fixture explicitly says it is reduced to four records. Before the fix, the tool treated any nonempty parse of this fixture as a complete dataset: `found:false`, `searchedEntireDataset:true`, `evidenceOfAbsence:true`. The first fixture-based focused test failed on these exact fields.

The no-match response now states that inventory completeness is unverified, includes `coverage.complete:false`, reason `inventory_completeness_unverified`, and the parsed-record count; it sets both `searchedEntireDataset` and `evidenceOfAbsence` to false. The existing status-provenance runtime therefore cannot convert this result into authoritative evidence of absence and keeps the claim unsupported. Positive record lookups remain source-backed; inventory completeness is no longer asserted for positive or ambiguous results either.

The core negative-claim parser was also sentence-scoped rather than clause-scoped. A fixture sentence with a positive Acme statement followed by a negative Beta statement produced one negative claim incorrectly attributed to Acme. A source-style “No FedRAMP authorization was found for Gamma Cloud” statement parsed its grammatical subject as `No FedRAMP authorization`. Both first failed focused regressions. Parsing now separates comma-linked status clauses, keeps negation local, extracts the entity after the source-scoped no-match construction, recognizes bounded negative paraphrases, and does not retain affirmative status wording on a negative claim.

## Verification

- Pre-fix red: `pnpm --filter @capiro/meriv2-core exec jest src/grounding/status-provenance.spec.ts --runInBand` — 2 new tests failed on broad negation scope and incorrect entity extraction.
- Pre-fix red: `pnpm --filter @capiro/api exec jest src/meri/meri-certification-status-tool.spec.ts --runInBand -t "partial parsed-marketplace fixture"` — failed because the partial fixture was labeled complete and evidentiary of absence.
- `pnpm --filter @capiro/meriv2-core exec jest src/grounding/status-provenance.spec.ts --runInBand` — 8 passed.
- `pnpm --filter @capiro/api exec jest src/meri/meri-certification-status-tool.spec.ts --runInBand` — 3 passed.
- `pnpm --filter @capiro/meriv2-orchestrator exec jest src/meri/meriv3/status-provenance-runtime.spec.ts --runInBand` — 4 passed, including unqualified miss remains `negative_unsupported` in enforce mode.
- `pnpm --filter @capiro/shared build`, `pnpm --filter @capiro/meriv2-core build`, `pnpm --filter @capiro/defense-contracts build`, `pnpm --filter @capiro/defense-domain build` — passed.
- `pnpm --filter @capiro/meriv2-core typecheck` — passed.
- `pnpm --filter @capiro/api exec prisma generate` — passed (Prisma 5.22.0).
- `pnpm --filter @capiro/api build` — passed.
- `pnpm --filter @capiro/api typecheck` — passed, including repository PE Phase A safety check (`PE_PHASE_A_B_SAFETY_OK`).
- `git diff 06748f1cc --check` — passed.

## Residuals / source-adjudication limits

- The snapshot supplies no verified marketplace inventory count, version, pagination-complete marker, or cryptographic manifest. Therefore a no-match cannot currently be source-qualified as evidence of absence; the implementation intentionally remains fail-closed. A future positive completeness receipt requires an upstream contract/source field, not a guessed minimum record count.
- The fixture is a reduced archival sample, not a factual reference for whether any named organization is or is not FedRAMP authorized. No actual negative claim was source-adjudicated here.
- The bounded parser handles explicit status wording and the covered negative constructions, not unrestricted natural language or coreference. Unrecognized/no-evidence claims remain unsupported; this is not a general semantic parser.
- Retry behavior for HTTP 200 parse failures is the separate handoff defect and was not changed.
