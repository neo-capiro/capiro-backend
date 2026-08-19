# Phase 8 Session 5 validation evidence

Current corpus verdict:

`SESSION5_CORPUS_READY_AWAITING_LIVE_RUN_AUTHORIZATION`

Runtime verdict remains:

`SESSION5_P0_RUNTIME_ACCEPTED_LIVE_CORPUS_BLOCKED`

The corpus is source-grounded and ready. Live NVIDIA execution remains separately unauthorized. No stack deployment, SageMaker model creation, TransformJob submission, endpoint creation, or GPU spend occurred.

## Branch coordinates

- Repository: `neo-capiro/capirov2`
- Branch: `agent/phase8-session5-nvidia-benchmark`
- Session 5 remote head before this corpus closeout: `47cceede54aea238feb9ad2dad06f1d1f90218e0`
- Base branch: `agent/phase8-session4-after-s3`
- Current base SHA: `a5094361f9da82e70090f73da46b11108e6a8b45`
- `origin/main`: `e33b4bf9607ee61b912681fcb09ef3a2cd51d284`

## Corpus review

The ledger validates eight accepted strata and zero blocked strata:

- `r1_zero_native_tables`: `FY2027_r1.pdf`, physical page 10, source SHA `1aa8846edb69d4c3a54e03b383b0cabb77f93433162b8139ab8cbb55bcc7882a`, evidence SHA `b7ac7e9692714090e53883843b215bc7c80b190dfa4d047504777b408fa7f7e4`.
- `r2_identity_banner`: `RDTE_Vol_1_Budget_Activity_1.pdf`, physical page 34, source SHA `02f719c0d9d528284a70ec84b5e90e1a6a2008ebc5f610a56236db0a10e112c0`, evidence SHA `ced05e36c4106d204223062e46f067da803ff85cf8b8ccdb117c120abb290618`.
- `r2a_project_cost_table`: `RDTE_Vol_1_Budget_Activity_1.pdf`, physical page 54, source SHA `02f719c0d9d528284a70ec84b5e90e1a6a2008ebc5f610a56236db0a10e112c0`, evidence SHA `a04c7f83be2ed5e84d0b0c6dba8ffd31d1b4dfb2e05e0c8aab706b536e61337f`.
- `scanned_image_only`: `Missile_Procurement_Army.pdf`, physical page 7, source SHA `e47707f50d29ebf796a3db57877d104001c5679ce783f308ed1cd47cca1107f4`, evidence SHA `e9973a7cf190db6d46dfbe416dc48c7cbbe848735389c8f8adbdcbc29e5728e0`.
- `navy_ba6_duplicate_flattening`: `FY2027_r1.pdf` physical page 36 plus companion `NAVY_RDTE_BA6.pdf` pages 61 and 147; primary source SHA `1aa8846edb69d4c3a54e03b383b0cabb77f93433162b8139ab8cbb55bcc7882a`, companion SHA `3ccc4c32bd21af187a2399dc991be4e6a55637736f7e6c66779485d5f83bd3f6`, evidence SHA `b91708eac7588e62e14a0ca933112d8081b77273f777dc10b2b0f0565160285b`.
- `p1_table`: `FY2027_p1.pdf`, physical page 19 / printed page 14, source SHA `b8d5248257590856ee33ddb1b401ec2efcdfea219c05b5bc8ea1068d9000d0a6`, evidence SHA `fe1a320ad18d65d20afe154cbf5a9021e3379afb4202296e6a9c59bc04d90d92`.
- `o1_op5_table`: `FY2027_o1.pdf`, physical page 10 / printed page 5, source SHA `8c209bc2af590e460977649ba4e37645fd2ee8e3c8dbf61c227b7d3a27079c4d`, evidence SHA `09941d565b06d8484647b1136a6ce0fc8a9dd9a377a5cb4e3f42b66e356f3bc6`.
- `defense_wide_volume`: `OM_Volume1_Part1.pdf`, physical page 788 / printed `USSOCOM 784`, source SHA `99b8ea818a0df267b509665bbe5df9fb4d4128083dfa63b38b9fa17d653386f9`, evidence SHA `1f36d5839d09e629e7f509faa470734780790a6eeb58fd2a01248637e070b8ef`.

The scanned page was independently inspected visually and has full-page image content plus a useful FY27 P-1 appropriation summary and explicit correction footnote; it is not a blank or TOC page. The Navy entry retains R-1, R-2, and executive-summary roles separately and does not flatten conflicting values into one canonical assertion. P-1 and O-1 retain procurement/O&M-native identities rather than converting them to PEs.

Ledger content SHA: `b80c3334043bc1a22ff5256b95b84d3a03c129e9808f20caf7792befbe78c316`.

## Frozen corpus and Nemotron preparation

- Frozen corpus: `.session5-live/frozen-corpus.json`
- Final corpus SHA: `a4bf213ea908f6dff2988e1ec3c78d0d5359a8e085554cb1915721b687fc8e98`
- Exact entry count: 8
- Prepared page/payload count: 10 (the Navy role-separated stratum uses three source-role pages across two PDFs; the other strata use one page each)
- Maximum provider payload: 485,140 bytes, below the 5,500,000-byte hard limit
- Parser options SHA: `890f08082befbee5261b4c77f0646d647a98d402bfd31c0dcb022f2610cf688a`
- Rendering configuration SHA: `800a38fb9e8a4f8e014febe9822a5ca075596cf03d8544ab2aa67d9856f8a2fc`
- Renderer: PyMuPDF 1.28.2, RGB PNG, alpha false, 150 DPI
- Every prepared page rechecked PDF SHA, physical page, decoded PNG bytes, image SHA, rendering SHA, provider payload SHA, requested route intent, and actual `nemotron_parse` identity.
- No Capiro provenance was included in the provider payload.
- Separate NVIDIA OCR provider: no; recorded as not configured.
- Separate NVIDIA table provider: no; recorded as not configured.
- Cached LlamaParse: not available for these newly selected pages; no paid rerun was performed.
- Deterministic baseline: retained as the comparison provider; no paid baseline rerun was performed.

## Projected execution (not authorized or run)

Using 10 prepared pages, `maxPagesPerJob=8`, `maxJobSeconds=1800`, one `ml.g5.xlarge` instance, and the configured minimum reservation rate:

- TransformJob count: 2
- Projected host hours: 1.0
- Projected Marketplace cost: USD 1.00
- Projected infrastructure cost: USD 1.00
- Projected total: USD 2.00
- Initial cap: USD 50
- Hard cap: USD 150
- Extended budget authorization: false
- Maximum concurrency: 1
- Reservation projection at the USD 5/hour floor: USD 5.00 total

The projection is within the initial USD 50 target. No NVIDIA execution was started.

## Validation performed after the final corpus/code changes

- `pnpm install --frozen-lockfile`: PASS.
- Shared/auth/defense-contracts/defense-domain/defense-client builds: PASS.
- Session 5 Node tests: **40/40 PASS**.
- `node scripts/verify-phase8-session5.mjs`: PASS (`SESSION5_P0_RUNTIME_PASS`).
- `node scripts/verify-phase8-session5-corpus.mjs`: PASS (`SESSION5_CORPUS_READY_PASS`, accepted=8, blocked=0).
- Corpus review tests and live-gold tests: **8/8 PASS**.
- `pnpm --filter @capiro/infra-cdk typecheck`: PASS.
- Focused Session 5 CDK Jest: **6/6 PASS**.
- Session 2 boundary: PASS.
- Session 2 DB rehearsal: PASS, **36 checks** (downstream defense-api suite reported 64/64).
- Session 3 boundary/admin: PASS.
- Session 3 parity: **52/52 PASS**.
- Session 3 DB rehearsal: PASS, **86 checks**.
- Session 4 replay with `--enforce-replay`: PASS (`SESSION4_SOURCE_PARITY_PASS`).
- No-cache Docker build: PASS, image `capiro-defense-parser-orchestrator:phase8-session5`.
- Docker containment: PASS, UID `1001:1001`, no exposed ports, no CUDA/NVIDIA runtime, no static credentials, no Clerk secret, no `DATABASE_URL`, reconciliation CLI present.
- `git diff --check`: PASS.

## Mutation statement

- PR merged: no
- Benchmark stack deployed: no
- SageMaker model created: no
- Paid TransformJob submitted: no
- GPU spend: USD 0
- Production routing changed: no
- Parser default changed: no
- Production/shared DB changed: no
- Production data changed: no
- EventBridge changed: no
- Production IAM/secrets changed: no
- Snapshot activated: no
- Canonical promotion executed: no
- Persistent endpoint created: no
- Session 6 started: no

Live benchmark evidence is intentionally absent until separate live-run authorization.