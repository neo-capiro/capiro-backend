# File 01 requirements ledger

Foundation SHA256: 77c55b7484343a766c3bd17047c513b50c7c5d045e2018f03ea9dd0c08b622bd (normalized UTF-8 text). Entire 1,779-line source read, including annexes A–D/F–I. Launch prompt scheduling takes precedence; scope is file 01 only.

This ledger records mandatory scope; bounded candidate evidence is in STATUS.md and does not constitute complete acceptance. Each acceptance row retains its original contract in the supplied plan. Implementation/PR/SHA, deterministic/UI evidence, independent review, both-main integration, deployment and residual gap must be filled before PASS. Neo authorized this lead to recover, validate and publish P0A/P0B; see STATUS.md for exact receipts.

| ID/source | Classification | Owner | Requirement / trigger | Prerequisites | Code/PR/SHA | Deterministic/UI evidence | Review | Merge/deploy | Status / residual gap |
|---|---|---|---|---|---|---|---|---|---|
| 01-A | mandatory | P0C | Outcomes, approvals, attachment and artifact delivery | Existing contracts; P0A/P0B where applicable | API proposals; web controller + vNext approvals; 932e9c379 | 126 worker web tests; 114 integrated tests; UI live blocked by rollout setup | Scoped vNext PASS; broader recovery incomplete | candidate integrated at 0beaf33b1; neither main/deployment | NOT_RUN overall; historical reload, memory review and artifacts remain |
| 01-B | mandatory | P1A/P1B | Canonical memory, authorization, exact evidence and commitments | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| 01-C | mandatory | P1C | Plans, aggregate budgets, compaction, fenced durable runs and scoped children | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| 01-D | mandatory | P2 | Adaptive narrative, existing JEV and redacted joined telemetry | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-3 | mandatory | P0C/P1A/P1B/P1C | Preserve named component authorities and qualified existing capabilities | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-4.1–4.3 | mandatory | Lead | Map compatible existing run/event/invocation/evidence/action contracts | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-5.1 | mandatory | P1C | Validate complex plans before dispatch; preserve simple fast path | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-5.2 | mandatory | P0B/Lead | Typed logical outcomes and uncertain-effect reconciliation | Existing contracts; P0A/P0B | runtime source1f6dcdfa0 integratedb040afa27; scheduler9ee6f4eb0 separate | Integrated runtime157/11 and API68/3 exit0; scheduler83 exit0 but next-cadence overlap reproduced | Narrow runtime PASS; scheduler repair active | PR1904 add5be483; neither main/deployed | NOT_RUN overall; schedule overlap/recovery and live outcomes remain |
| ANNEX-5.3 | mandatory | P1C | Central deadline/calls/cost/retry/concurrency/synthesis bounds | Existing mode/runtime control | 854a5fc30+d083cde77+dab9c6a49 integrated through b040afa27 | Integrated runtime157 tests, API/orchestrator typechecks exit0 | Request-local bounds narrowly reviewed | PR1904; neither main/deployed | NOT_RUN overall; aggregate cost/tokens/durable/children/tenant budgets remain |
| ANNEX-5.4 | mandatory | P1C/P1A | Protocol-safe compaction, exact authorized handles and revocation | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-5.5 | mandatory | P1C | Existing leases/fencing/step receipts/recovery | Existing research session authority | Existing receipt fixes integrated; c812cc0f1/046a71a22 full-result replay candidate | 50 existing durable tests; new29 API/71 orchestrator worker tests, review pending | Existing receipt boundary PASS; full replay unreviewed | Existing fixes PR1904; replay excluded | NOT_RUN overall; source-specific current-policy replay and actual crash/resume qualification remain |
| ANNEX-5.6 | mandatory | P1C | Persist goal revisions, ordered steering, Stop/detach, child results and UI | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-6.1 | mandatory | P1A | Old-memory recall, lifecycle eligibility and cache invalidation | Canonical memory authority | df679a1ba integrated74a8b53ed; PG gate55b4b84ac | 56 integrated tests; actual Actions36376591290 at add5be483: 10/10 PostgreSQL16+pgvector tests exit0, 1000/501-row fixtures | Recall/PG gate narrow independent PASS | PR1904; neither main/deployed | NOT_RUN overall; authenticated scale/cache/stale projection and live recall remain |
| ANNEX-6.2 | mandatory | P0C | In-Meri memory decisions, conflicts, second review and visible errors | Canonical review APIs and roles | fd3ea2d82 integratede5abd8ca6, fixturetypefixe75fc517e | 40 web/4 and11 API/2 tests; API/webtypechecks exit0 | Independent multi-action recovery PASS in window-local scope | PR1904; neither main/deployed | NOT_RUN overall; authenticated decisions/roles/reload/next-turn recall remain |
| ANNEX-6.3–6.4 | mandatory | P1A | Private/public source routing, exact full reads, versions and coverage | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-7.1 | mandatory | P1B | One registry; governed selector exposure, discovery and dispatch | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-7.3 | mandatory | P1B | Versioned procedure binding through current firm-skill service | Existing versioned CRUD; server-owned execution binding | procedure-manifest-binding worker active fromadd5be483 | NOT_RUN | pending | isolated candidate only | NOT_RUN; manifest and current-version selection first, served hookup reserved |
| ANNEX-7.4 | mandatory | P1B | All fixed commitments fields, source families, statuses and zero effects | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-7.5 | mandatory | P1B | Prove aliases/surfaces/filter/FY/pagination parity before consolidation | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-7.6 | mandatory | P0C | Current file/artifact readback and byte validation; full workbench later | Existing canonical artifacts and attachment identity | 9276bd489 artifact candidate, boundary and XLSX repairs active | 48 API/84web exit0; direct malformedOOXML/PNG/browser and cross-client embedding counterexamples | HOLD; independent review rejects complete boundary | Excluded PR1904; neither main/deployed | NOT_RUN; strict format/access repairs, prior-turn full reads and live downloaded bytes remain |
| ANNEX-7.7 | mandatory | P1B | Current procedure and scheduler contracts preserved; richer file-02 work deferred | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-8.1 | mandatory | P2 | Proportionate evidence-backed client narrative | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-8.2 | mandatory | P2 | Preserve existing JEV; observed flags, targeted repair and combined budget | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-9.1–9.2 | mandatory | Lead/all | Pinned source acquisitions, license notices, tests and dispositions | Existing contracts; P0A/P0B where applicable | ae0d0d5be; 01-source-acquisition.md and inventory103files | Exact Git blob hashes/licenses at required pins; acquisitions not production adoption | Per-adaptation review pending | Record in PR1904 | NOT_RUN overall; translated tests/notices and adoption dispositions remain |
| ANNEX-9.5 | mandatory | P1C | Coworker acquisition tests; reject warning-only limits and local-only durability | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-10.3 | mandatory | Lead | Immutable reviewed source/config/schema artifacts and controlled release | Both-main integration; passing gates; database recovery clearance | PR1904 add5be483; fullchatf9e8feb86 review pending | PGvector10/10 passed; remaining combinedCI failures retained, no waiver | Runtime/memory narrower PASS; artifact HOLD; rollout review pending | Neither main updated; no deployment/migration | BLOCKED release; database recovery and required qualification unfinished |
| ANNEX-12.1–12.5 | mandatory | Lead/reviewer | Separate26/75/CD suites, exact hard gates, captured output and human rubric | Verified capture and owned fixtures | dcf1944c4 saved-byte verifier; extra trace-effect residual | 35 tests+14 direct reviewprobes exit0; 26 baselineofflinePASS;75liveNOT_RUN | Narrow repairs accepted; exhaustive effect correlation gap remains | Topic only | NOT_RUN; trusted actualcapture/auth/source/sinks, remainingpredicates/CD7/CW8 unfinished |
| ANNEX-12.6 | mandatory | P1C | CW-01–08 required now; remaining CW scope explicitly classified | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-12.8 | mandatory | Lead/reviewer | Independent real boundary evaluation and honest setup failures | Existing contracts; P0A/P0B where applicable | Synthetic fixture ac49269f7; 2 tenants/4 users/3 clients READY | 18 pure tests + independent review + actual DB commit/readback exit 0; authenticated Pat page captured | fixture resume narrowly accepted; acceptance cases remain NOT_RUN | setup resources created; Meri enablement owner-approved, not applied | NOT_RUN overall; current page reports tenant not enabled; provider write sinks unqualified |
| ANNEX-13 | mandatory | Lead | Release/rollback inventory, compatible migrations and single owner | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-14.2–14.4 | mandatory | Lead/P2 | Redacted trace joins, total usage/cost and existing architecture | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-Appendix A/B | mandatory | P1B | Recheck 132-tool historical inventory, 14 starters and six procedures | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| ANNEX-Appendix H | mandatory | P2 | Reconcile historical JEV findings independently of offline suite | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| I1/I2 | conditional/later | Lead | Established compute reason and same-image parity | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| X1/X2 | conditional/later | Lead | Measured native limitation after delivery cycles and fair comparison | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| M1 | conditional/later | Lead | Separately authorized service relocation | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| F1 | conditional/later | Lead | Measured need after relevant workflow qualification | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| CW-09–12 | conditional/later | Lead | Full file-02 coworker/drafting/model workflow promotion | Existing contracts; P0A/P0B where applicable | pending | NOT_RUN | pending | not integrated/deployed | NOT_RUN; qualification pending |
| M01–M20 | mixed required/conditional | Lead | Original M contracts preserved and mapped per changed boundary | See 01-memory-strategy-acceptance.md | Original 20 contracts plus file-01 applicability record | NOT_RUN | per-change review required | not qualified/deployed | Required affected memory/source/review/runtime cases remain; full structural drafting later unless existing path changes |

## Original acceptance cases

| Case | Source | Status | Evidence / residual gap |
|---|---|---|---|
| 01 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 02 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 03 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 04 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 05 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 06 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 07 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 08 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 09 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 10 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 11 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 12 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 13 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 14 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 15 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 16 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 17 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 18 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 19 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 20 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 21 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 22 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 23 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 24 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 25 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 26 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 27 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 28 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 29 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 30 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 31 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 32 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 33 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 34 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 35 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 36 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 37 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 38 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 39 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 40 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 41 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 42 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 43 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 44 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 45 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 46 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 47 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 48 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 49 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 50 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 51 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 52 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 53 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 54 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 55 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 56 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 57 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 58 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 59 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 60 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 61 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 62 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 63 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 64 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 65 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 66 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 67 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 68 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 69 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 70 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 71 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 72 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 73 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 74 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| 75 | Appendix F | NOT_RUN | Authenticated isolated fixture target not qualified |
| CD-01 | Appendix C | NOT_RUN | Real source/approval/coverage fixture target not qualified |
| CD-02 | Appendix C | NOT_RUN | Real source/approval/coverage fixture target not qualified |
| CD-03 | Appendix C | NOT_RUN | Real source/approval/coverage fixture target not qualified |
| CD-04 | Appendix C | NOT_RUN | Real source/approval/coverage fixture target not qualified |
| CD-05 | Appendix C | NOT_RUN | Real source/approval/coverage fixture target not qualified |
| CD-06 | Appendix C | NOT_RUN | Real source/approval/coverage fixture target not qualified |
| CD-07 | Appendix C | NOT_RUN | Real source/approval/coverage fixture target not qualified |
| CW-01 | Annex 12.6 | NOT_RUN | Implementation and real worker/UI faults pending |
| CW-02 | Annex 12.6 | NOT_RUN | Implementation and real worker/UI faults pending |
| CW-03 | Annex 12.6 | NOT_RUN | Implementation and real worker/UI faults pending |
| CW-04 | Annex 12.6 | NOT_RUN | Implementation and real worker/UI faults pending |
| CW-05 | Annex 12.6 | NOT_RUN | Implementation and real worker/UI faults pending |
| CW-06 | Annex 12.6 | NOT_RUN | Implementation and real worker/UI faults pending |
| CW-07 | Annex 12.6 | NOT_RUN | Implementation and real worker/UI faults pending |
| CW-08 | Annex 12.6 | NOT_RUN | Implementation and real worker/UI faults pending |

26 offline cases: baseline PASS at 6fdccff42 (26/26 and verifier exit 0); final combined file-01 acceptance NOT_RUN. Original suite contract is evals/meri/suite-contract.json; do not replace or renumber. Original M01–M20 contracts and applicability are preserved in 01-memory-strategy-acceptance.md; no M pass is claimed.
