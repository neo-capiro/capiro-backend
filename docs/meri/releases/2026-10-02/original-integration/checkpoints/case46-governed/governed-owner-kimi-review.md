**PASS**

No BLOCK findings. All source-level security requirements are correctly implemented:

**Line findings:**

- `meri-case46-authority.ts:33` — Correct: `case46SourceIdentity` uses a frozen SHA256 digest of the canonical engagement input marker; no client-supplied approval or pricing accepted.

- `meri-case46-authority.ts:46-49` — Correct: Actor verification requires exact synthetic fixture namespace match + standard_user role + email-endswith `@example.com` + synthetic name pattern.

- `meri-case46-authority.ts:59-76` — Correct: PostgreSQL `FOR SHARE`/`FOR UPDATE` row locks across tenant, user, membership, client, wall, conversation, and attachment rows; strict ordering prevents deadlocks.

- `meri-case46-authority.ts:81-95` — Correct: Document row verification compares all columns including `source_entity_id` against the calculated `identity.ownershipSha256`, S3 key path, byte size, and lifecycle.

- `meri-case46-authority.ts:96-106` — Correct: Physical bytes are re-read from storage and verified against expected hash; this is actual extraction of source bytes, not trust of client-provided metadata.

- `meri-case46-authority.ts:153` — Correct: `readCase46CurrentAuthorityInTx` returns `currentVerifySha256` derived from immutable source identity fields; no rollover or re-issuance permitted.

- `meri-case46-authority.ts:196` — Correct: Install uses compare-and-swap (`UPDATE ... WHERE metadata=old`) with `changed !== 1` rejection on concurrent modification.

- `meri-case46-authority.ts:243` — Correct: `readSealedCase46Binding` validates MAC via decode function; no bypass without secret.

- `meri-case46-provider-budget.ts:37-40` — Correct: Qualification validation uses both policy-derived `currentVerifySha256` cross-check and dynamic integrity hash of the full qualification object against `qualificationSha256`.

- `meri-case46-provider-budget.ts:86` — Correct: Re-hash check `case46BudgetHash(q) !== policy.qualificationSha256` prevents injection.

- `meri-case46-provider-budget.ts:107-110` — Correct: Ledger limits are re-verified against qualification on every read; any change fails.

- `meri-case46-provider-budget.ts:145-146` — Correct: Aggregate token/cost reconciliation; mismatched sums fail loud.

- `meri-case46-provider-budget.ts:178-182` — Correct: Metadata CAS on every budget mutation (`UPDATE ... WHERE metadata=old`).

- `meri-case46-provider-budget.ts:215-222` — Correct: Receipt requires settled attempts and no pending/uncertain statuses; all attempts must be finalized before evidence is available.

- `meri-case46-provider-budget-owner.ts:37-45` — Correct: Every operation re-locks conversation and re-verifies binding MAC, source identity hash, and current verification hash in the same transaction.

- `meri-case46-provider-budget-owner.ts:50-58` — Correct: Turn binding verified against actual persisted user message body + ID match.

- `meri-case46-provider-budget-owner.ts:65` — Correct: CAS update on metadata change with `changed !== 1` rollback.

- `governed-artifact-capture.ts:101-108` — Correct: `validateMeriGovernedArtifactPolicy` enforces expiration (15 min max), issuedAt drift (+30s), tenant/actor/client/conversation binding match.

- `governed-artifact-capture.ts:122-134` — Correct: `encodeMeriGovernedArtifactTransport` requires non-empty secret; rejects empty/blank secrets (Hash:302).

- `governed-artifact-capture.ts:136-156` — Correct: `decodeMeriGovernedArtifactTransport` uses length/format validation, base64url decode, purpose-match, then `timingSafeEqual` on HMAC-SHA256.

- `governed-artifact-capture.ts:163-182` — Correct: `assertMeriCase46ToolInput` enforces exact literal equality on all fields including SHA256 of text content; no truncation allowed.

**No ROUTE/RUNTIME wiring present** — as explicitly noted, this is prerequisite INACTIVE source only. S3 port is mocked in `extractAttachmentText`; PostgreSQL uses production owner functions with actual rowlocks/transaction rollback.