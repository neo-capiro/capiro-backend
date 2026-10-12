# Read-only newsletter and retirement contract handoff

Backend source is `fe50dc1c2de1660a036e338cf81acdcf0f2fb26a` / tree `00ca67ae1f2cacc1ae0b51fff25cb33d58954f67`. Later root `f3fab43ab8e01a066f56559fabb273969f01f1ff` and draft PR2426 `d587441261fd356ee5144a8fc29cb2f771d062b8` have only documentation changes from that source. Frontend source is PR16 `b680b65e14134be736942b29d715e49c2c6a8b19` / tree `67aabd83e9f129c1fdb25fbe254f41edd99394e7`. Retirement proposal is PR2423 `d09429a509d5b3cc2501f3736e619723e4b2c4c0` / tree `9aaeb9e8e3605b075610e0921b36b30424c7dde9`.

The existing frontend response parser strips the entire metadata object. Four exact-declaration synthetic probes reproduce this. The existing legacy producer writes `outbound_campaign` plus `newsletterStageId` and `newsletterRevision`; a bounded receiving-field proposal needs no new record kind, DTO version, persistence owner or saved-document-version bridge. Routing remains a hint until the canonical stage/record owner checks current actor, tenant and client authority. Implementation and frontend dispatch acceptance remain pending. See [the contract](NEWSLETTER-METADATA-CONTRACT.md).

The 26-path retirement delta contains a closed ten-path static-data/reader slice: seven fixtures exactly matching current Web source and three specs changing only their file operands. Root has selected that slice for a separate implementation and independent review. The current immutable Core floor still has 830 exact, 280 missing and 36 different paths; no wholesale floor adoption or waiver is authorized. The destination prototype guard's strict inventory parser must survive any later projection slice. See [the overlap matrix](RETIREMENT-OVERLAP-MATRIX.md).

Reproduction from this packet's repository root:

```sh
node docs/cleanup-outreach-metadata-retirement-contract-audit-20261012/evidence/replay-parser.cjs
python docs/cleanup-outreach-metadata-retirement-contract-audit-20261012/evidence/verify-read-bindings.py
```

Both exited0. The latter verifies26 allowed source bindings, three original legacy-owner equalities and both later root documentation-only deltas. The former uses pinned cached Zod4.6.5 and exact TypeScript declarations; it imports no operation or transport. No protected EngagementService implementation or unpublished branch was read, no production/frontend source changed, and no live GET/provider/customer/DB/native operation occurred. Native runtime, full floor, frontend dispatch and wider retirement acceptance are unclaimed. `SHA256-INDEX.json` covers all other packet files without self-reference.

Whole-packet whitespace inspection reports the inherited blank EOF in the exact copied frontend HANDOVER (exit2). The original bytes remain intact; authored Markdown and harness diff-check passes. Raw output is retained in `evidence/raw-whitespace.stdout`.
