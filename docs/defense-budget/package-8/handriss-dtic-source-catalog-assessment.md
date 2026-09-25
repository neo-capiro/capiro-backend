# Package 8 — DTIC/JDOCS candidate source assessment

This is a metadata catalog assessment only. It is not a semantic extraction,
coverage certification, source-completeness claim, approval, or production
import authorization.

## Pinned candidate

The candidate is FY2026 President's Budget RDT&E, agency Defense Technical
Information Center (DTIC), appropriation 0400, in the public
[`handriss/defense-budget-justification-data` repository](https://github.com/handriss/defense-budget-justification-data)
at commit `5c6310d9845cd75360bf4c39a220f9d6699b65df`, path
`fy2026/RDTE_DTIC_PB_2026.xml`. The mirror XML SHA-256 for this candidate is
`02479cd6e67dfee10bb1029d9413dbc35e81174384b25319fedfb9589d4aac6a`.
The value supplied with the task had an extra trailing `6`; this corrected
64-character digest was independently computed from the pinned GitHub object.
The corresponding official Comptroller PDF is
[`RDTE_DTIC_PB_2026.pdf`](https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2026/budget_justification/pdfs/03_RDT_and_E/RDTE_DTIC_PB_2026.pdf),
SHA-256 `08c867d61816f7b5ebb82924a33d4003ee03c7880984ac6dc9bc91363b6f2d63`.
These are separate byte identities. The XML is a machine-readable extracted
companion; the PDF is the official publication and must remain independently
traceable.

The exact official XML endpoint
[`RDTE_DTIC_PB_2026.xml`](https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2026/budget_justification/pdfs/03_RDT_and_E/RDTE_DTIC_PB_2026.xml)
was re-read on 2026-09-25 with HTTP 200, `text/xml`, 67,578 bytes, and
SHA-256 `02479cd6e67dfee10bb1029d9413dbc35e81174384b25319fedfb9589d4aac6a`.
That digest exactly matches the pinned Handriss mirror bytes, so this lead now
has an official XML byte binding in addition to the independently pinned PDF.
The read-only inspector returned FY2026/PB, DTIC/0400, two PE identities
(`0605801KA` and `0605998KA`), and zero duplicate PE occurrences. It still
returns `candidate_only` and `promotable: false`.

The read-only inspector at
`apps/api/src/defense-budget/xml-source-inspector/dtic-jdocs-xml-source-inspector-v1.ts`
checks well-formedness, the DTIC `JustificationBook` and R2 namespaces, required
document metadata, and PE identity enumeration. It computes the input bytes'
SHA-256 and checks an expected mirror SHA when provided. Its fixed status is
`candidate_only` with `promotable: false`; it does not create extraction
artifacts, read/write a database, or assert annual coverage.

## Repository coverage and limits

The repository README reports 375 XML files across FY2023–FY2026:

|   FY | XML files | Submission form                | Coverage stated by the repository                                                     |
| ---: | --------: | ------------------------------ | ------------------------------------------------------------------------------------- |
| 2023 |        84 | Extracted from PDF attachments | Defense-wide RDT&E/procurement material across named agencies, including DTIC and DHP |
| 2024 |       129 | Extracted from PDF attachments | Defense-wide RDT&E/procurement material across named agencies, including DTIC         |
| 2025 |       124 | Extracted from PDF attachments | Defense-wide RDT&E/procurement material across named agencies, including DTIC         |
| 2026 |        38 | Standalone Comptroller XML     | RDT&E, procurement, and other defense-wide books; DTIC appears in the RDT&E list      |

The repository describes R-2/R-2A and P-40 content, plus R-1D summaries,
R-3 overviews and procurement delivery schedule XML. Counts are files, not
unique physical source documents, agency-family units, accounts, PEs, or proof
of source completeness. Service-specific Army, Navy/Marine Corps, Air Force and
Space Force books are explicitly outside this newer repository. O&M, military
construction and military personnel are also excluded. Agency availability
varies by year and family; absence from this mirror cannot classify a source as
not required, unavailable, or legitimately blank.

The repository states that the underlying U.S. Government data is public domain
and that its files are unmodified convenience copies. GitHub reports no declared
repository license (`license: null`), so this catalog does not assert an SPDX
license for repository metadata or extraction code. The repository has a pinned
Git commit and Git blob IDs, but no published SHA-256 checksum catalog; calculate
SHA-256 from fetched bytes and independently bind them to the official PDF or
Comptroller URL before any ingestion decision.

The separate [`540co/dod-jbook-pdf-xml` repository](https://github.com/540co/dod-jbook-pdf-xml)
is a useful historical discovery lead for FY2013–FY2020 (including the base
and amended budget cycles identified in its README). It includes older
service-specific source material and derivative JSON/CSV layers, but it is no
longer maintained, some source URLs are stale, and the repository likewise has
no declared license. It requires an independent FY/component/account inventory
and official-source/hash reconciliation before becoming a coverage denominator
or ingestion input.

## Compatibility and next qualification boundary

The DTIC XML declares the Comptroller `.../022009/jb` namespace and nests R2
program elements under the `.../022009/r2` namespace. It includes FY, budget
cycle, submission date, agency, appropriation, PE identities, funding and
narrative fields. Existing RDT&E semantic extraction currently consumes a
Phase-3 composed page result; no dedicated DTIC XML parser was found. The
existing `native_structured` manifest policy and native structured companion
verification path make a deterministic adapter plausible, but this inspector
does not implement that adapter or map XML fields to financial assertions.

The current extraction evidence contract has document/page/cell/text-span
granularity but no typed XML element path. A later semantic adapter must preserve
stable XML element identity and source-byte hashes without fabricating PDF page
numbers, then use the existing strict extraction and verification gates. Any
extension to evidence provenance requires a separately reviewed contract
change. Qualification should start with this single DTIC document, reconcile
its fields against the official PDF, and keep its output `candidate_only` until
parser proof, completeness checks, review, and governed publication are all
independently accepted.

The qualification-only manifest is retained at
`docs/defense-budget/package-8/qualification/dtic-fy2026-official-xml-candidate-v1.json`.
It is not a production expected-source registration and does not authorize a
historical replay.

## Second Handriss lead — FY2026 DARPA RDT&E (NO-GO)

The same pinned mirror commit also contains
`fy2026/RDTE_Vol1_DARPA_MasterJustificationBook_PB_2026.xml` (GitHub blob
SHA-1 `ea794e1644cf515230e137a3cf92988bf38ad4e0`; fetched mirror bytes
SHA-256 `00edc63f808a3ad568df96c8871ac5d2e1cd41446dda9e697cfca20d2a595528`,
1,320,882 bytes). It is retained as a discovery lead only.

The exact Comptroller XML URL
[`RDTE_Vol1_DARPA_MasterJustificationBook_PB_2026.xml`](https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2026/budget_justification/pdfs/03_RDT_and_E/RDTE_Vol1_DARPA_MasterJustificationBook_PB_2026.xml)
returned `HEAD 200` with `Content-Length: 1,320,882`, `Content-Type:
text/xml`, and `Last-Modified: 2025-06-26 17:29:11 UTC`, but a corresponding
`GET` returned `404`. Therefore no authoritative XML bytes or SHA-256 can be
bound to this candidate. The separately indexed official PDF
[`RDTE_Vol1_DARPA_MasterJustificationBook_PB_2026.pdf`](https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2026/budget_justification/pdfs/03_RDT_and_E/RDTE_Vol1_DARPA_MasterJustificationBook_PB_2026.pdf)
is not treated as byte-equivalent to the mirror XML.

The codebase has generic `pb_r2` templates and an official Comptroller host
profile, but no deterministic FY2026 DARPA expected-source key or family rule
that can anchor this filename. With the official endpoint inconsistent and no
governed expected-source identity, this candidate is `candidate_only`,
`promotable: false`, and a Package 8 manifest entry or historical replay is
not authorized.
