# Package E first-batch authorization packet

## Decision status

**No runnable production manifest exists. Nothing in this packet authorizes production execution.**

The accompanying `qualification-pilot-proposal.json` is deliberately fail-closed:

- `qualificationOnly: true`
- `executionAuthorized: false`
- `runnableProductionManifest: null`
- all expected-source, observation, outbox, and candidate IDs are `null`

The inventory contains exactly three non-Air-Force source versions that are simultaneously immutable/archive-proven, unsuperseded, and absent from the governed lifecycle. They are candidates for isolated qualification only. A fourth or fifth member cannot be added honestly without first establishing immutable archive proof for another source.

## Protected invariant

All future qualification, registration, and execution work must preserve the existing 43 active scoped approvals exactly.

| Invariant | Required value |
| --- | --- |
| Active approval count | `43` |
| Ordered approval snapshot SHA-256 | `a5804be1ce76db2290115950679058eaf63cc501780cfac6dc5c8d6837b93f0c` |
| Allowed approval mutations | None |

The count and hash must be captured immediately before and after any separately authorized production operation. Matching only the count is insufficient.

## Ordered qualification pilot

### 1. Army FY2027 RDT&E Volume 1, Budget Activity 1

- Source version: `src:6f447338-b243-453a-b554-69b96a2e565e`
- Source document: `6f447338-b243-453a-b554-69b96a2e565e`
- Source key: `rdte_vol_1_budget_activity_1`
- SHA-256 / bytes: `02f719c0d9d528284a70ec84b5e90e1a6a2008ebc5f610a56236db0a10e112c0` / `4,703,360`
- Archive: `s3://capiro-defense-budget-raw-dev-967807252336/raw/public/dod-budget/fiscal_year=2027/source_authority=dod-comptroller/family=rdte/document_id=rdte_vol_1_budget_activity_1/sha256=02f719c0d9d528284a70ec84b5e90e1a6a2008ebc5f610a56236db0a10e112c0/original.pdf`
- Archive version: `AYkuYN8rbfTVPo9LeC0JaRnwGEhS_7Tl`
- Lifecycle IDs: expected source `null`; observation `null`; outbox `null`; candidate `null`
- Identity: Army; FY2027; `rdte` / `r2`; R-2 and R-2A; Volume 1 / BA1
- Existing evidence: accepted source-backed R-2 and R-2A gold pages for the exact SHA
- Remaining qualification issue: current official-byte binding and exact-release-image repeat qualification are absent; the persisted source component is null and must be reconciled to Army before lifecycle registration

### 2. Central DoD FY2027 R-1

- Source version: `src:804f1477-033a-46d5-a958-6cd191cadb71`
- Source document: `804f1477-033a-46d5-a958-6cd191cadb71`
- Source key: `fy2027_r1`
- SHA-256 / bytes: `1aa8846edb69d4c3a54e03b383b0cabb77f93433162b8139ab8cbb55bcc7882a` / `3,127,023`
- Archive: `s3://capiro-defense-budget-raw-dev-967807252336/raw/public/dod-budget/fiscal_year=2027/source_authority=dod-comptroller/family=rdte/document_id=fy2027_r1/sha256=1aa8846edb69d4c3a54e03b383b0cabb77f93433162b8139ab8cbb55bcc7882a/original.pdf`
- Archive version: `Co2I4fuNN3XZWiDAoiF1f.mFSLd3F2ki`
- Lifecycle IDs: expected source `null`; observation `null`; outbox `null`; candidate `null`
- Identity: Central DoD, multi-component; FY2027; `rdte` / `r1`; R-1
- Existing evidence: official bytes currently match the exact archive SHA and length; an accepted Army detail-page gold record exists
- Remaining qualification issue: the persisted source row says `family: r2` and has no component, while the current classifier correctly routes the book as R-1; durable identity reconciliation and exact-release-image repeat qualification are required

### 3. Army FY2027 Missile Procurement

- Source version: `src:17cf6ee9-5237-48a1-94b0-6515d99922ac`
- Source document: `17cf6ee9-5237-48a1-94b0-6515d99922ac`
- Source key: `missile_procurement_army`
- SHA-256 / bytes: `e47707f50d29ebf796a3db57877d104001c5679ce783f308ed1cd47cca1107f4` / `8,933,513`
- Archive: `s3://capiro-defense-budget-raw-dev-967807252336/raw/public/dod-budget/fiscal_year=2027/source_authority=dod-comptroller/family=procurement/document_id=missile_procurement_army/sha256=e47707f50d29ebf796a3db57877d104001c5679ce783f308ed1cd47cca1107f4/original.pdf`
- Archive version: `OV8rmOwkKHVZY8Sa5p.PvoMwPSzzTo6g`
- Lifecycle IDs: expected source `null`; observation `null`; outbox `null`; candidate `null`
- Identity: Army; FY2027; `procurement` / `p40`; primary P-40 router, with representative image-only P-1 gold evidence
- Existing evidence: accepted source-backed image-only gold page for the exact SHA
- Remaining qualification issue: official-byte binding is incomplete; the image-only/OCR path lacks exact-release-image repeat qualification, and P-40 routing versus the representative P-1 page must be explicitly reconciled

## Explicit exclusions

### Air Force FY2027 RDT&E Volume I

Source `src:934c59bb-2c83-4015-96b5-5f69e70b78d6`, SHA-256 `6666345286e16a60ed4d0d74fd788389eb7565b2225e9d51e262a9ee2a2b20fb`, archive version `9hPq5oTa9XFf6iejKWmf3qEUAAjFVhaQ`, is excluded. Two isolated exact-image runs failed deterministically during R-2 artifact finalization with duplicate evidence ID `ev_1c2956e3bb656a6bcafce241ebf51dd99b599396a23b6c20fb176e47997f04a2`.

### Existing lifecycle work

- BA4A source `97a60bb1-1e2c-493f-b771-f84460cda1aa`, observation `0c43e78d-90fd-4db6-a476-99565c740c0a`, and outbox `7bde93f5-544d-4816-9b2f-1c5453017dfb` are terminal review work, not a NEW document.
- All other terminal outbox rows are excluded.
- The ten-row Package B pending set remains excluded absent exact authorization. BA4A has since become terminal, leaving nine rows still pending.
- No approval, authorization, or canonical-publication action is included.

## Gates before qualification can begin

1. Reconfirm each source's exact SHA-256, byte count, archive bucket, key, and version ID.
2. Complete official-publisher byte binding for the Army R-2/R-2A and Missile Procurement archives. The R-1 binding is already established.
3. Resolve source identity drift before creating lifecycle rows:
   - R-2/R-2A component: persisted `null` to reviewed `ARMY`.
   - R-1: persisted `family: r2`, component `null` to `rdte` / `r1`, Central DoD multi-component.
   - Missile Procurement: explicitly bind the P-40 router contract and representative P-1 page role.
4. Name one exact runtime image digest and task definition for qualification.
5. Run each member alone at least twice and require:
   - exact source-byte verification;
   - successful artifact finalization;
   - source-oracle assertions for identity and monetary fields;
   - no blocking parser conflict;
   - substantively deterministic output after documented run-derived exclusions;
   - captured artifact/report hashes, logs, resource measurements, parser and release identity.
6. Assemble a reviewed qualification evidence packet for all three exact versions.

Qualification runs themselves require an explicit authorization decision below. This proposal does not supply it.

## Gates after qualification

Qualification success still does not authorize production ingestion.

1. Obtain separate authorization to create or bind expected-source, observation, and outbox rows for the exact qualified versions.
2. Snapshot the 43 approvals and all unrelated candidates/outboxes immediately before registration and execution.
3. Obtain a second authorization that names every exact outbox row ID permitted to run.
4. Execute one exact row at a time. Numeric `--batch-size` and unrestricted queue sweeps are not document whitelists and are prohibited.
5. Capture before/after source, observation, outbox, candidate, run, artifact, approval, and unrelated-row invariants.
6. Stop at human review. Approval and canonical publication remain separate explicit decisions.

## Authorization decisions

All decisions are currently ungranted.

| Decision | Current value | Required authorization scope |
| --- | --- | --- |
| Isolated qualification of the three exact archive versions | `NOT AUTHORIZED` | Name all three source document IDs, hashes, versions, image digest, task definition, and evidence destination |
| Production lifecycle registration | `NOT AUTHORIZED` | Name exact qualified source versions and permitted expected-source/observation/outbox writes |
| Exact-row production execution | `NOT AUTHORIZED` | Name every exact outbox row ID and required before/after invariants |
| Approval or canonical publication | `NOT AUTHORIZED` | Separate reviewed decision after governed extraction |

Authorization owner: _unset_

Authorization timestamp: _unset_

Authorization evidence/reference: _unset_
