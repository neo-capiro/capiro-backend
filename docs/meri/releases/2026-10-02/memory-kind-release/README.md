# Memory-version repair: qualified source and images

Source `42988dae5fb7bc2fff3af582ca15a0836a4477c5` is in C-drive local main
and GitHub main. Both immutable AWS builds passed after the corresponding
GitHub Actions workflows failed at startup with no jobs. This is build and
rehearsal evidence; shared migration, promotion and original live acceptance
require their separate execution receipts.

The repair adds the three immutable memory-version source kinds to the database
CHECK and rejects missing version payloads. Existing typed lineage and activation
guards remain enforced. A single forward migration uses an atomic transaction,
five-second lock timeout and thirty-second statement timeout. No historical SQL
or shared migration ledger is rewritten. Application rollback retains this
additive schema.

The release also includes the guarded post-seed continuation, governed case46
capture, controlled-read capture, and a correction to the misleading evidence
footer. The four previous setup claims and first completed approval/projection
must be preserved. Never replay the failed setup operators.

Qualification passed 81 core tests, 321 native capture checks, 48 owned-PostgreSQL
and packaging checks, and all 26 deterministic offline eval cases. The actual
orchestrator image build passed 129 suites / 1,443 tests; two existing live-only
placeholders remain skipped. Fresh and prior-449 database rehearsals both applied
all 450 migrations successfully, with exact checksums, no unfinished migrations,
validated constraints and retired tables absent. These databases are isolated
local rehearsals, not copies of the original live customer-data fingerprint.

API image: `sha256:f792a39e889c7572811dd1335b6f12501d3878701caef3888ae7f120bd6e6f25`.
Orchestrator image: `sha256:758a96f5722e0679513f0f0621a5ba12d733f83d00d6ed4bdeb0f83fbc872f3a`.
The actual build readbacks bind these digests to the source and reviewed recipes.
The compatibility attestation preserves the historical rehearsal limitations;
it does not authorize the abandoned restore/resolve path.

The current API505 answered the signed-in owner's bounded mailbox diagnostic.
File01 remains incomplete: zero original live rows are complete. Provider budget
installation, original aggregate initialization, full75/CD7/CW8, applicable memory
variants and human rubric remain open. Defense Chat is excluded. Temporary Aurora
maximum remains16ACU; no capacity rollback is asserted.

`index.json` records raw-byte artifact hashes. Inputs and scripts contain only
synthetic IDs, public certificates, task metadata and local paths. No credentials,
auth state or customer content are included. Shared-policy checkout
`743fd708c3484604e8a35ea1039adeca3b1e331f` has required files identical to fetched
origin `39590a3bfc57ce03b0411ff7912a7c8d99deb70c`; machine-map revision2026-09-30.
