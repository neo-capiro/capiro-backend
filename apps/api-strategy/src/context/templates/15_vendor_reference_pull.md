---
document_type: vendor_reference_pull
document_id: "ctx_vendor_pull_001"
schema_version: "1.0"
state: active
scope: strategy
client_id: "client_123"
strategy_id: "strategy_456"
node_id: null
meeting_id: null
as_of: "YYYY-MM-DD"
valid_until: "YYYY-MM-DD"
owner: "user_123"
authority: external_authoritative
source_of_truth: true
supersedes: null
confidentiality: client_confidential
generated_by: "Capiro (partial; see the Verification column)"
---

# Vendor reference pull

> Reference data on the performing company for an amendment strategy. Capiro fills the rows it can source (SAM.gov entity record, federal contract vehicles, Senate LDA filings, congressional delegation); every other row is entered by hand. The Verification column is part of the record: a row is Confirmed only when a human has checked it against the named source. Facts here travel in the technical annex and staff briefing, never in the funding-table or report-language text.

## Company identity

| Item | Finding | Source | Verification |
|---|---|---|---|
| Legal name and DBA |  | SAM.gov entity | Confirmed / Unverified / Placeholder |
| Headquarters |  | SAM.gov entity | Confirmed / Unverified / Placeholder |
| Facility relevant to this request (address, congressional district) |  | Client / SAM.gov | Confirmed / Unverified / Placeholder |
| Ownership and parent |  | Manual | Confirmed / Unverified / Placeholder |
| Relationship to the client |  | Client | Confirmed / Unverified / Placeholder |

## Federal-market credentials

| Item | Finding | Source | Verification |
|---|---|---|---|
| UEI |  | SAM.gov entity | Confirmed / Unverified / Placeholder |
| CAGE |  | SAM.gov entity | Confirmed / Unverified / Placeholder |
| SAM registration status and expiry |  | SAM.gov entity | Confirmed / Unverified / Placeholder |
| NAICS / PSC |  | SAM.gov entity | Confirmed / Unverified / Placeholder |
| ITAR / export-control posture |  | Manual | Confirmed / Unverified / Placeholder |

## Federal contracting history

| Vehicle or award | Agency | Type | Value | Award date | Period of performance | Source | Verification |
|---|---|---|---|---|---|---|---|
|  |  | IDIQ / BPA / Contract / Grant |  | YYYY-MM-DD |  | USAspending / FPDS | Confirmed / Unverified |

## Federal lobbying representation

| Registrant | Client of record | Period | Income | Issue codes | Source | Verification |
|---|---|---|---|---|---|---|
|  |  | Q1 YYYY |  |  | Senate LDA | Confirmed / Unverified |

## Congressional delegation for the facility

| Member | Chamber | State / district | Committee | Role | Source | Verification |
|---|---|---|---|---|---|---|
|  | House / Senate |  |  | Member / Chair / Ranking Member | Capiro directory | Confirmed / Unverified |

## Litigation and adverse history

| Item | Finding | Source | Verification |
|---|---|---|---|
| Civil litigation, settlements, suspensions, debarments | Not sourced; enter and cite independently | Manual only | Unverified |

> Capiro has no automated source for litigation or adverse history. This row must be confirmed or explicitly cleared by a human before it appears in any exported report, and it may never be inferred, estimated, or filled by generation.

## Handling notes for staff Q&A

-
