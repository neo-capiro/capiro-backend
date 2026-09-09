# Meri phases 0 and 1 — implementation and verification

Prepared September 9, 2026. Implementation base: upstream `main` at `4b2ef49a5ec638ff5aa4794d1dd04b4196e24fc0`. The modified existing files were checked against that revision by Git blob SHA before publication. No database migration is required; the Prisma change documents the existing attachment bytes column.

## Delivered scope

Phase 0's [contract register](phase0-contract-map-2026-09-09.md) maps all 15 findings to responsible components and acceptance checks. It distinguishes confirmed source causes from unresolved live/data questions. The live inline Word download still returned `401 Missing bearer token`, and the historical Anduril source panel still displayed the current L3 scope. Those are Phase 2 repairs. The deployed application does not expose an established web/API/orchestrator revision in the inspected UI.

Phase 1 implements MW-14 and MW-15 through the existing attachment pipeline, canonical client Documents writer/reader, client knowledge lifecycle, and action authority:

- PDF, DOCX and TXT uploads preserve original bytes and deliver available text, attachment IDs, names and readiness to the provider. Scanned PDF pages use the existing PDF vision reader, with an eight-page OCR budget and a 45-second deadline. Incomplete pages and reading limits are explicit.
- Conversation attachments remain available across follow-up, regeneration, persisted history and summary boundaries. Tenant/user ownership and live message association prevent another conversation's files from being claimed or filed.
- `save_chat_attachments` files 1–10 source uploads under an explicit authorized client, preserving source identity. Client-scoped `save_note` writes an actual client document. Personal and meeting notes retain their existing paths.
- Deterministic server-owned document identities make repeated requests and concurrent retries reuse a durable record. Partial batches preserve successful siblings and report saved, processing and failed files separately.
- The composer offers **File a client note**, collects a client and nonempty body, waits for the selected conversation's client change to persist, and prepares an explicit request. It does not autosend. Failed scope changes preserve the draft.
- Proposal and approval cards show receipt-derived outcomes. A resolved tool promise alone is insufficient proof of saving. Pending scanning stays processing; failed readiness stays failed; missing durable IDs remain unconfirmed. Policy-bound retries recheck current authority.
- Shared provider instructions distinguish “how do I log notes?” from supplied notes. The active V3 response path replaces common unsupported direct save assertions with the current tool receipt, including Markdown/list/status-prefixed claims. This is a narrow confirmation check, not a replacement reasoning system or a guarantee against every possible provider paraphrase.
- New notes and originals use canonical scan readiness. Private, superseded, quarantined and policy-unusable content cannot enter shared document indexing. Search reauthorizes existing indexed document IDs against current viewer, parent, client-wall and readiness checks. Snapshot filenames obey the same access rules.

Client Documents is the durable destination for source files and notes. Saving a source does not automatically approve extracted institutional-memory facts; existing governed-memory proposals retain their own lifecycle. The current model/provider and canonical memory system are preserved.

## Verification

The final focused runs cover extraction and continuation, original bytes and canonical note readback, permissions and readiness, deduplication/concurrency, capability exposure, action outcomes/retries, provider confirmation and composer/receipt behavior: 359 distinct tests across 25 suites passed, counting the two additional snapshot-limit cases verified in the final KB access rerun.

| Check | Result |
| --- | --- |
| API affected extraction, filing, knowledge and capability suites | 15 suites / 154 tests passed; final KB access rerun passed 12 tests, including 2 additional snapshot-limit cases |
| API action proposal and retry suite | 1 suite / 46 tests passed |
| Orchestrator confirmation, V3 service and capability suites | 5 suites / 77 tests passed |
| Web composer, receipts and message regression | 3 suites / 74 tests passed |
| Core execution metadata | 1 suite / 6 tests passed |
| Web and orchestrator TypeScript | Passed |
| API TypeScript versus untouched baseline | Same 10 diagnostics; no new diagnostics |
| Whitespace | `git diff --check` passed |

The API baseline diagnostics are existing constructor mismatches in hearing-recap/governed-tool/visual-analysis specs, plus the environment's `simple-statistics` CommonJS/ESM mismatch. The API Jest run used the repository configuration with a local compatibility mapping to the installed CJS `htmlparser2` entry; the sanitizer was not mocked. Dependency manifests and lockfiles were not changed. Tests run directly through Node using the repository Jest/Vitest/TypeScript binaries.

PDF smoke verification also exercised actual PDF bytes through `unpdf`, preserving the synthetic FortressHUMS/UH-72, FY27 and $7.5 million request facts. The OCR boundary tests use the canonical reader interface with controlled provider outcomes; a credentialed OCR request against the deployment has not been certified.

## Live acceptance still open

This branch has not been merged or deployed. The implementation is reviewable, but Phase 1's production/live exit gate remains open until the candidate is deployed and checked with configured S3, scanner and AI credentials.

Use synthetic clients and controlled notes/files for these acceptance inquiries:

1. Attach the representative DOCX advocacy letter, text PDF, scanned PDF and TXT. Ask: “Draft from the attached TAG letter for FortressHUMS / UH-72 LUT. Quote the requested amount, fiscal year, action and fixture checksum.” Compare each answer against its actual source without pasting text.
2. Regenerate, ask “Which attached source supports that amount?”, reload and reopen. Confirm references and exact facts remain available, with partial OCR coverage disclosed.
3. Ask: “Save these attached documents under the synthetic Sightline client.” Complete the existing authority flow if required. Open every successful document in client Documents and retrieve it in a fresh conversation. Repeat the request and confirm no duplicate records. Include a failed and scan-pending sibling.
4. Ask only: “For Sightline, how do I log the Sen. Wyden engagement notes under that company?” Confirm that Meri asks for content and makes no save claim or write. Then use the client-note action with synthetic notes, complete the action and open the exact persisted body.
5. Repeat with a second identity, restricted client, private note, mismatched conversation, changed client selection, scanner-pending file and failed write. Confirm authorized access and truthful saved/processing/failed/unconfirmed states.

Later-phase findings retain their original acceptance gates. Deployment revision identification, canvas-download diagnostics and inspection of the affected historical governed-memory rows remain explicit follow-up evidence tasks in the contract register.
