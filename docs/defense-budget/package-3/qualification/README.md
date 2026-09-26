# Package 3 congressional qualification — FY2027 HASC RDT&E

Decision: **QUALIFIED_ISOLATED_PILOT**. Package 3 remains **NOT_COMPLETE** for
production congressional coverage.

This cohort converts the pinned 926-row fixture into native HASC
`congressional_stage_packet_v1` tables and exercises the durable HASC stage
factory with an exact persisted parser proof. It is a candidate-only,
RDT&E-only seam qualification. It does not register a production manifest, run
the lifecycle worker, write a database, backfill history, publish facts, send
notifications, or activate a feature flag.

## Source and governed packet

- Official document: `CRPT-119hrpt698`, H. Rept. 119-698, FY2027 NDAA.
- GovInfo PDF SHA-256:
  `6587d1cec52d8d3eda3551648f50e4bc15371ea9167da2999e263e8c8e14480a`.
- Retained object:
  `s3://capiro-defense-budget-raw-dev-967807252336/incoming/fy2027/H._Rept._119-698_-_FY2027_NDAA.pdf`,
  version `MKREMzqkucbbM4ZYaTic432fWf_Ctnwi`.
- Reviewed physical PDF pages: 618–665, all 48 pages represented.
- Governed packet: `hasc-fy2027-rdte-mark-only.json`, byte SHA-256
  `7deb7d1dcb47d97651d8ba43c2e8bc1bdf15b23c4b35fdd956cca852036fa57e`.
- Packet result: 926 rows, 922 distinct PE codes, four preserved legitimate
  repeated PE rows, $160,628,729,000 in HASC marks, and zero request fields.
- The PE/mark multiset exactly matches the reviewed legacy companion at SHA-256
  `9c99115f7c0f2b836002c543c6e846a45ef512a2e6fc52f59f2b40f96f12b11c`.

The extractor fails closed on page range, printed unit, expected row count,
expected mark total, exact reviewed PE/mark reconciliation, and duplicate
source-row identity. The one page-edge calculation is an explicit reviewed rule
for page 618 / PE `0602141A`, not a general inference. It preserves repeated PE
codes because the official report can list the same PE in separate service
tables. Request columns are deliberately omitted because the committee source
does not own the presidential request.

## Reproduction

With the official PDF available locally and the locked defense-budget parser
environment active:

```text
python apps/api/scripts/__tools__/extract_armed_services_report.py <official.pdf> docs/defense-budget/package-3/qualification/hasc-fy2027-rdte-mark-only.json --fy 2027 --page-start 618 --page-end 665 --unit thousands --source-url https://www.govinfo.gov/content/pkg/CRPT-119hrpt698/pdf/CRPT-119hrpt698.pdf --document-key CRPT-119hrpt698 --omit-request --retained-s3-uri s3://capiro-defense-budget-raw-dev-967807252336/incoming/fy2027/H._Rept._119-698_-_FY2027_NDAA.pdf --retained-s3-version-id MKREMzqkucbbM4ZYaTic432fWf_Ctnwi --expected-row-count 926 --expected-mark-total-dollars 160628729000 --reference-rows-json apps/api/scripts/__data__/corrected_json/armed_services_hasc_fy2027_corrected.json --page-edge-authorized-sum 618:0602141A
```

Run the proof-bound, disposable qualification:

```text
pnpm --filter @capiro/api qualify:package3-congressional
```

The command writes `qualification-result.json`. Its persisted parser proof and
semantic artifact live only in a temporary directory that is removed after the
run. The native profile is narrowed to `rdte_pe`. Because the pinned packet has
no independent Phase 4/5 native identity index, the stage resolution context is
empty: all 926 native rows remain unresolved omissions and no funding
assertions are emitted. The result records the manual reviewed-packet parser
proof and durable semantic artifact hashes.

## Remaining Package 3 gaps

- This packet is RDT&E-only. The real HASC profile is mixed-family and still
  requires native RDT&E, procurement, O&M, MILCON, and provision composition.
- An independently sourced Phase 4/5 native identity index is needed before
  the PE rows can emit accepted HASC funding assertions; the current candidate
  intentionally remains unresolved.
- HASC, SASC, HAC-D, SAC-D, and conference routing must become stage-aware; the
  current aggregate defaults cannot safely distinguish the two chambers.
- A production packet provider must fetch and verify manifest-bound bytes and
  reload exact persisted parser proofs. Missing packets must terminate in
  review rather than a retry loop.
- Public-law funding remains excluded. Enacted publication requires the
  separate statutory/incorporation and multi-source enactment proof path.
- Production lifecycle execution and publication remain disabled pending those
  changes and their operational approvals.
