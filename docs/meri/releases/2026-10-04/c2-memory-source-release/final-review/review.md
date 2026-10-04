# Independent C2 two-image release qualification review

## Disposition

**PASS — automated candidate/build qualification for the frozen two-image packet.** The evidence joins both successful immutable ARM64 builds to the same merged candidate source, candidate checkpoint, buildspecs, requests, launch intents, build IDs, published image digests, and line-extracted build-log evidence. I found no concrete inconsistency in those joins or in the supplied schema/baseline/budget and acceptance-state records.

**Not a release approval or deployment verification.** `deployableManifest` is `false`, `humanApproval` is `null`, and deployment is `NOT_RUN`. Those are correct, expected pending gates—not candidate/build-qualification failures. No approval, deployment, live acceptance, or C2 completion is inferred here.

## Frozen scope and boundaries

Reviewed only files in the current packet: `evidence/manifest.json`, `evidence/independent-local-checks.json`, archive qualification/README, both services' build start/readback/intent/input/buildspec files, both extracted build-log-evidence JSON files, served baseline, source candidate/qualification/provenance and schema evidence, and the included previous source/template/operator reviews. No external files, cloud, provider, or live service were accessed; no code or evidence was changed other than writing this report.

Snapshot identifiers:

- Frozen time: `2026-10-04T07:43:53.645621+00:00`.
- Candidate source: `945179d44223882f9fe1da2fb4e41213bf5813c2` (merged PR #1941).
- Candidate checkpoint: `0b825aaf0c2c5140d166afcc628706649428d7d7e6263e05a8f9783a72e45307`.
- Archive qualification SHA-256: `48fa688aadf19ede1ad4908113d656ce5ecf8bdad3fc8fcdd74668323d3491eb`.
- Archive `README.md` SHA-256: `02cd2869af73d2baefd6d6a055645fac8ed0c475090287f85ca325854a763b1d`.
- `independent-local-checks.json` reports `PASS_LOCAL_RELEASE_ARTIFACT_JOIN`, 116 checks, including 27 copied-artifact records, exact copied artifacts, candidate/source pins, build/request/receipt/template joins, executed-template decodes, schema receipt reconstruction, baseline invariants, and no approval/deployment/acceptance promotion.
- Full build logs are intentionally omitted. The packet records their original byte lengths and whole-file SHA-256 values and says the independent reviewer compared the copied artifacts to the originals. This review examined the supplied verbatim line extracts and their asserted whole-log hashes; it did not independently retrieve or re-hash the omitted originals.

## Candidate and build joins — PASS

Both requests use project `capiro-build-web-dev`, source version `945179d44223882f9fe1da2fb4e41213bf5813c2`, and only the `EXPECTED_SHA` plaintext override for that candidate. Each intent records the same caller and the user-authorized backup build scope, binds its request SHA, buildspec SHA, candidate SHA and checkpoint SHA, and limits the action to immutable image build/publication. The build-start IDs agree with the readbacks; both readbacks resolve to the requested source SHA and report successful completed phases.

- **API:** build `capiro-build-web-dev:e7fa2d19-a094-4806-9c74-b592667ba1ce`; buildspec SHA-256 `b69ec8d59ab4a897f177c0a99c87a7fe0f4c3680c3a2e9b62126a97dbe91f258`; request SHA-256 `99718e3c38541bf050f712947b7b4e8fab439657db4470d94bff28f2a2ed9110`; candidate checkpoint SHA-256 `0b825aaf0c2c5140d166afcc628706649428d7d7e6263e05a8f9783a72e45307`. Readback and extracted log agree on `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:00e8c5cac10d8b4cd3cc46a0a9a7602b51db4657e38fabe86f1f12999d2b2e31`, ARM64, Node `22.23.3`.
- **meriv2-orchestrator:** build `capiro-build-web-dev:3588b57f-4e9f-4d14-8585-c3f751759a6e`; buildspec SHA-256 `2c385ca184bb7dd65770573eba645ccae735387019c4aea623aebe142e4acc7a`; request SHA-256 `57c6bd4ebc818dbbab0295c56daa62fb7965a4910dc498ff1490b237c8b4018e`; same candidate checkpoint. Readback and extracted log agree on `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/meriv2-orchestrator@sha256:94c82ec438a0cfee0da3869af284e107ae6aeff6157c8c0ff2f97dc991f6c5bf`, ARM64, Node `20.16.0`.

The image digests are distinct and service paths match. The readbacks report zero service mutations, database mutations, and provider calls. The buildspec hashes match the respective archived buildspecs; the request/receipt/buildspec joins and runtime execution-decode checks are explicitly reported PASS in the independent local check record. The supplied extracted logs contain the exact candidate source and image markers and `LOCAL_REPODIGEST_ECR_MATCH_PASS` for each service.

## Tests and packaged markers — PASS, with limits retained

- Orchestrator readback and its line-exact log evidence agree: **1570 passed, 0 failed, 2 skipped, 1572 total; 130/130 suites passed**. The extracted lines show the actual Jest summary and serialized counts. The two skipped tests are not described as passing. The earlier source qualification also reports **97/97 core focused tests** and the API focused groups (92 projection/adapter/context/HTTP, 17 source/service, 17 request/controller regression); these are source-qualification results, distinct from the immutable build's packaged probes.
- Orchestrator marker inventory includes the Case 20 source-proof tests, canonical-memory-source native tests, canonical-memory loopback test, capture-contract loopback tests, packaged entrypoint/auth, mail defaults, no-tools directive, semantic clock, provider guards, and local repo-digest/ECR match. The named new Case 01/14 checks are therefore not being inferred from a total count alone.
- API readback and the extracted log agree on the packaged/offline markers: runtime imports, Case 01 fixture/continuation/postapproval/postseed imports, exact 452-image-migration hashes, active-owner-index package, C2 memory/reconciliation/terminal lifecycle/source import, semantic clock, receipt contract, capture-provider guards, privacy, HTTP-success, canonical memory source, and repo-digest/ECR match. The excerpt contains actual line numbers/text and matches the readback marker list.
- API evidence is marker/probe based; no separate API full-suite aggregate count appears in the supplied API readback or extracted excerpt. The included earlier source qualification supplies its focused API counts above. This is a boundary of the evidence, not a discrepancy or an invented API test total.
- The template audit noted its retained orchestrator minimum was 1564, while this build reports 1570 passes. The actual result exceeds that minimum, and required new named markers appear in the extracted log. No under-threshold or skipped-as-passed discrepancy is present.

## Compatibility, schema, and operational invariants — PASS

- The read-only served baseline is pinned to API revision 523, orchestrator 119, and web-vnext 390, with the older served source SHA `c0f393f863bf73bd4e65e7a94e17c073e7be021e`. It records the allowlisted models/flags and endpoint/key presence-only observations; the packet claims no model, configuration, provider, web, schedule, capacity, or service change. It explicitly limits this snapshot to a drift fence, not a distributed deployment lock.
- Candidate-versus-served comparisons retain the Prisma schema, migration/dependency/lockfile, package and container invariant paths; the local checks report empty invariant diffs for API, orchestrator and web. No schema migration or dependency/container change is indicated. Retirement compatibility is marked PASS with the old tables absent and ordinary read shapes unchanged; this is compatibility evidence, not a claim that acceptance has passed.
- The schema task is bound to the currently served API 523 image and source, the exact inner script hash `4d8808af4b92dd4133f0c74410082e876630ede11fea2d168ac50b6ffed48ac7`, and the task/definition lineage. Intent states no workload task role, zero provider secrets and zero business writes; the read path uses only DB secret references. The script sets the transaction READ ONLY before catalog queries and asserts ledger/index/retirement facts. The receipt's BEGIN/CHUNK/END reconstruction and script binding are reported PASS. Result reports exit 0, 609 migration ledger rows (509 active-finished, 100 rolled back), exact prior-608 and migration checksums, both ready index definition hashes, retired tables absent, and no migration execution/provider/business writes or acceptance authority. Cleanup records the owned task stopped, its definition inactive, no cleanup errors, and complete cleanup.
- The served baseline and source qualification both pin the 26-event journal SHA-256 `816b04a47be56432846d1ee602370c3bea985eb497a7de9e899aee4d53f8b39e`; the schema task's journal-preserved record says unchanged. The qualification retains known cost `$15.200909`, conservative approval `$1`, committed `$16.200909`, available `$13.799091`, and no active reservation. No new budget event or reservation is evidenced.

## Acceptance state — correctly not promoted

The qualification explicitly retains `fullSuitePassed: 0/75`, `cdPassed: 0/7`, `c2Complete: false`, Case 14 as `CAPTURE_UNCERTAIN_FAILED_RUN_PRESERVED`, human rubric `NOT_RUN`, and replay authority `false`. The source qualification says the prior failed Case 14 run and consumed claims remain unchanged. The source archive also preserves the known limitations: null-client canonical memory and shortened citations remain conservative UNKNOWN; original prompt/final recall UI/human grading, initial-context coverage, and date inconsistency remain open. These are not converted into a successful capture or acceptance claim by source tests or image qualification.

## Findings and necessary pending gates

**Concrete inconsistencies found: none** in the frozen automated candidate/build qualification joins reviewed here.

**Known limitation, not an automated build blocker:** current client-bound Case 01/14 receipt validation cannot accept tenant-wide canonical memory rows whose client is null; those remain UNKNOWN rather than being attributed to a client. This is documented in both the prior source review and source qualification and must remain an acceptance limitation unless separately addressed and requalified.

**Pending gates (expected; do not interpret as qualification failure):** root must create fresh candidate-bound final manifests and rollback packet; refresh the relevant drift/baseline readback immediately before any promotion; obtain explicit human approval bound to the exact candidate/manifests; then perform any authorized deployment and verify it independently. Keep API/orchestrator mixed-identity rolling window out of acceptance captures. After deployment, any C2 acceptance/replay, original prompt/UI checks, human rubric, and full-suite/CD qualification remain separate work and authority. No step above is represented as already done.

Historical `providerCalls: 0` describes release/business-runtime actions in these records, not this review service.

## Final automated qualification result

**PASS — candidate 945179d44223882f9fe1da2fb4e41213bf5813c2 is correctly joined to both immutable image digests and the supplied build, package, schema, compatibility, and unchanged-budget evidence.** **Release approval/deployment: PENDING / NOT RUN, as expected.**

Reviewed from the frozen packet only; no external validation or live verification performed.