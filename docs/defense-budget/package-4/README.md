# Defense-budget Package 4 — versioned federal legislative updates

Package 4 adds an immutable, version-aware federal legislative evidence path and a retry-safe material-change delivery path. The release is intentionally dark: recurring collection and outbox rules are registered but disabled, and committed collection also requires `FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED=true`. This preserves the unresolved Package 3 congressional-input gate while allowing the schema, readers, and runtime code to ship safely.

## Delivered scope

- Immutable publisher revisions and append-only observations for GovInfo BILLS, CRPT, CPRT, PLAW, and CREC packages, including exact content/extraction hashes, procedural lineage, source URLs, completeness, and evidence locators.
- Independent incremental and full-reconciliation checkpoints with frozen window ends, a 48-hour incremental overlap, exhaustive qualified continuations, per-page durable cursor progress, coverage gaps, and removal only after a complete full inventory.
- Incomplete and unreadable receipts are archived but cannot replace the latest complete current projection or generate false removals.
- Exact PE/BLIN references are retained when unknown and replayed after catalog arrival. The accepted program-alias bank is available to the existing candidate-only mention path with confidence/type filtering and fan-out caps. Jev relationship decisions remain governed by the Package 2 shadow/evaluation posture and do not autonomously publish relationships.
- Append-only mention events cover changed text, added/changed/removed/reinstated/resolved mentions, and new congressional actions. Historical replay is suppressed from outbound alerts.
- A leased outbox writes tenant-scoped `intelligence_change` records transactionally with deterministic per-tenant delivery identities. Expired leases and uncertain retries are safe.
- Qualified current-mention and lifecycle readers are cursor-paginated and source-provenanced. Existing PE bill/action readers now include current version-aware qualified relationships instead of relying only on `CongressBill.peCodes`.
- Seven EventBridge schedule definitions cover hourly BILLS discovery, daily complete inventories for BILLS/CRPT/CPRT/PLAW/CREC, and a ten-minute delivery drain. Every rule ships disabled.

## Activation boundary

Do not enable the Package 4 schedules or set `FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED=true` until the Package 3 congressional source/proof gate is resolved and an operator has completed a no-alert baseline for every collection using `--full --historical`. Initial historical work must be drained before recurring non-historical reconciliation begins.

The release does not enable canonical defense-budget financial writes, infer funding from a mention, apply offered amendments to base text, or merge House/Senate procedural lineages. Financial claims still require the governed amount/year/unit/stage/source rules.

## Evidence

- [Validation evidence](./validation-evidence-2026-09-24.md)
- [Machine-readable qualification](./qualification-2026-09-24.json)
