# File 01 source acquisition and adoption register

Reviewed 2026-09-28 against Capiro source `71efe006a7c120f157a90a6dac6adaf743353937`.

Acquisition means exact donor bytes were saved for inspection. It does not mean adoption, compatibility, acceptance, release, or deployment. `01-source-inventory.json` preserves the original 103 acquired identities and hashes plus seven unsuccessful metadata probes (110 original records total), and adds machine-readable adoption records without replacing an original field or hash. Raw donor files remain under `C:/dev/cap-meri-foundation-evidence/upstream`; none was executed for this review.

The original Hermes source pin `516535b54275e963a82b4c28f866338fb768e7bc` and later coworker/test pin `062dc1e7f0f5faa5114b4d98b94c48f5ec5df36f` remain separate. A shared hash does not merge their provenance.

## Classification rules

- `copied`: donor source or fixture bytes are present in a Capiro target.
- `adapted`: donor implementation or test behavior was deliberately translated into Capiro code/tests. This requires concrete function/test mapping; shared vocabulary is insufficient.
- `dependency`: a donor package is installed and used through its maintained interface.
- `retained-equivalent`: existing Capiro behavior independently satisfies the requirement and is retained with evidence; it is not relabeled donor adaptation.
- `candidate-held`: donor-informed code exists on a non-integrated candidate and is not in the current product.
- `conditional-deferred`: the original plan's measured trigger is absent; this classification is allowed only for originally conditional work.
- `not-yet-implemented`: mandatory behavior remains pending. Acquisition alone is never PASS.

## Concrete adoption disposition

| ID | Current classification | Exact disposition at `71efe006a` | Notice disposition |
|---|---|---|---|
| H1 guardrails | `adapted`, integrated bounded slice | Request-local native model/tool/retry/no-progress admission is integrated through replays `f2151de654926ef8950029cc9226aceff7426a02` and `170f73c43e0583f27eb8aad0ddaec085cbc009d2`. Canonical scoped signatures, unchanged period-1..4 failure cycles, changed revision/query allowance, explicit pending polls, atomic batch admission, Stop/deadline precedence, and synthesis reserve are present. | Existing Hermes MIT notice retained. |
| H2 compaction | `adapted`, integrated bounded slice | Initial `a9f5819557f6a7fde1c839f86a3504a44a087f34` was rejected as sufficient acceptance evidence, but its implementation was initially replayed as `085db54ed09eb007277efab00c937a5721985ee0`. Original repairs `8ee5c2e0b601d7f53a166735cb66075002cf37a5` -> `0bb847e7d91d48fccebf1d323e4de35e3af35a26` -> `89b3612073809fd894ffc8b69341f27b8028c15c` -> `f910369fcef9802509670140a792ff96e183fcf6` -> `72519696d84ebb5b83a39c357524d68a5d1fe978` are integrated through repair replays `2d1b33ff95393818255d33d49eab91a9c49f5d53` -> `35e76021b908f430d74ac9885f917b5cefde2d74` -> `3f5adcf1c1b44898f89419c3d78c47343d288df2` -> `9df51eb883858de00f32f8f77b6b7d92adb6fa2e` -> `a884d6445344fdce1ab94f3d7abe0589677dbf4c`: bounded history/protected-state characters, complete contiguous suffix, exact PostgreSQL revision/CAS, and truthful partial/omission state only. | H2 added to existing Hermes MIT notice; donor Python is not shipped. |
| H3 citations | `not-yet-implemented` | Exact stable source/version/passage and consulted-versus-discovered behavior is not implemented by the increments reviewed here. Existing Capiro evidence/JEV remains its own authority. | No H3 adaptation notice claim. |
| H4 discovery | `candidate-held` | Donor-informed served candidate inspected as Git blobs at `9a651d5fae1f240a36fc9b04c7007d76d8cba172`; absent from current integration. It implements static request-time selection, not Hermes progressive search/describe/call. Mandatory H4 remains pending. | Candidate line has a notice; current distribution does not add H4. |
| H5 commitments | `adapted`, metadata/service slice integrated; served candidate held | Manifest/version work `aa6c161f73786eb3fdbdca5709cef4b0df63a8c5` / `7acbf3607247ee5d7e9968b8ca5083331809785c` is integrated as `92cecbef3ea16370460901ee77589079352db7cb` / `e4680ada973f4b8ceb2a2a65cadb7f7ab0b09c49`. It adapts playbook concepts into a protected, read-only C&D manifest and current-row binding. Served binding candidate `5a1985ce9ccf2f6e33a91b95fc0b36a85adfc645` (in candidate line `9a651d5fae1f240a36fc9b04c7007d76d8cba172`) is absent. CD-01..CD-07 remain NOT_RUN. | Existing Hermes MIT notice retained. |
| O1 OpenAI tools | `retained-equivalent` / mandatory gaps remain | Existing adapter behavior is retained; this review does not claim a source adaptation or SDK change. Completed-output, strict arguments and call-ID correlation remain acceptance duties. | Installed dependency licensing remains package/lockfile owned; no new notice here. |
| E1 Promptfoo | `dependency`, retained | Existing pinned evaluation dependency/harness retained. The 26 offline, 75 live and seven CD suites remain distinct; this review ran none. | Existing dependency notice process; no source adaptation claim. |
| E2 Playwright | `dependency`, retained | Existing authenticated fixture mechanism retained; no browser/runtime upgrade or capture was performed. | Existing dependency notice process. |
| L1 LibreChat | `not-yet-implemented` | Acquired for workflow study only. Existing proposal authority is retained; no LibreChat code adoption is claimed. | No current adaptation notice claim. |
| T1 telemetry | `not-yet-implemented` | Required joined/redacted run-step-child-source-artifact-proposal telemetry and cost evidence remains pending. | No telemetry convention adaptation notice claim. |
| R1 pgvector example | `conditional-deferred` | Example RRF strategy is not adopted. Existing PostgreSQL/pgvector qualification does not turn the example into production logic. Trigger remains a measured authorized old-memory recall gap after current baseline qualification. | No example adaptation notice claim. |
| R2 retrieval harness | `conditional-deferred` | Harness and placeholder evaluator are not adopted. Trigger remains a measured held-out retrieval gap. | No harness adaptation notice claim. |
| W1 Firecrawl | `retained-equivalent`, trigger not met | Existing historical Capiro adapter remains primary. No server adoption; activate only for a measured page/content extraction gap. | Component-specific terms remain separately owned. |
| D1 Docling | `conditional-deferred` | No Docling dependency/model activation. Trigger requires a failing table-extraction fixture plus weights/dependency review and correct page-coordinate benefit. | No Docling distribution from this increment. |
| G1 LangGraph | `conditional-deferred` | No dependency or runtime activation. Trigger requires a documented native recovery/maintainability failure after delivery cycles and a fair same-provider/source/budget comparison with measured recovery/RLS/cost benefit. | No LangGraph distribution from this increment. |
| G2 GovCon / ODBA | `conditional-deferred` | No playbook/parser adoption. Trigger requires a relevant domain fixture, rights review and measured advantage over existing qualified owners. | No adaptation notice claim. |
| Additional Hermes coworker sources | `not-yet-implemented` | Child persistence, ordered steering, durable delivery, todo projection and background procedure proposal patterns are acquired but not adopted by the implemented increments. Local-only durability, warning-only limits, optional validation and automatic memory promotion remain explicitly rejected. | No additional adaptation notice claim. |

Detailed records:

- H1: `acquisitions/runtime-guardrails.md`
- H2: `acquisitions/context-compaction.md`
- H4 held candidate: `acquisitions/governed-tool-selection.md`
- H5: `acquisitions/procedure-manifests.md`

## Implemented behavior boundaries

### H1

H1 covers request-local served MeriV3 attempts only. It does not provide token or durable cost reservation, parent/child shared durable budgets, tenant metering, queue admission, or restart-safe counters. Cases 71–72 and CW-07 remain original authenticated acceptance work; focused local tests are not substitutes.

### H2

H2 covers persisted replay history plus protected-state characters, a complete contiguous suffix and exact CAS publication. It does not prove durable provider call/output pairing, full provider token input authority, source-current-authority hydration, or semantic revocation of source text copied into user messages. Initial `a9f581955` was rejected as sufficient acceptance evidence, initially replayed as `085db54ed`, and then repaired; the original SHA not being an ancestor reflects the replay and does not mean its implementation was excluded. Only the repaired integrated chain supports the bounded disposition.

### H4

`9a651d5fa` is a candidate source identity, not current Capiro source. Saved tests on its ancestry do not make it integrated. It lacks donor-style provider-driven progressive discovery and retained review findings include required meetings coverage and unknown-name privacy/freshness gaps. It is held, not PASS.

### H5

Current integration contains the canonical C&D recipe, validation, current-row/version resolution and concurrency repair. It does not contain the served selector/procedure guard from `5a1985ce9`, a durable selected starter identity, or actual CD source-family execution. The observed 51 manifest tests are not the seven CD cases.

## Conditional activation decisions

These decisions preserve the original I/X/M/F and donor triggers; they do not turn mandatory H1–H5/O1/T1 behavior into conditional work.

| Decision | Actual state | Original trigger before activation | Current reason |
|---|---|---|---|
| I1/I2 clean native runtime/compute | `NOT_ACTIVATED` | Read-only live drift inventory establishes operational separation; same native image/config then passes caller, recovery and rollback parity before persisted cohort routing. | No live inventory or measured compute need was produced by this docs-only review. Current native runtime remains authoritative. |
| GPU/new specialist serving | `NOT_ACTIVATED` | File-03 role/model evidence demonstrates a task-quality benefit and separately qualified capacity/cost/fallback; existing NVIDIA owners remain primary. | No measured model gap, capacity evidence, authorization or model candidate. |
| D1 Docling | `NOT_ACTIVATED` | A concrete failing table/OCR fixture, rights/weights review and page-coordinate improvement over the qualified pipeline. | No qualifying failed fixture or measured benefit. |
| G1/X1 LangGraph comparison | `NOT_ACTIVATED` | A documented native recovery/maintainability failure after delivery cycles; then a bounded same-provider/source/tool/budget comparison. | Native mandatory recovery work is incomplete, so framework adoption would hide rather than measure the gap. |
| X2/model migration | `NOT_ACTIVATED` | A candidate beats repaired native on correct completion/recovery under identical inputs, then satisfies replacement-runtime gates, compatibility and rollback. | No qualifying X1 result, model comparison, full 75/CD gate or release authority. |
| M1 service relocation | `NOT_ACTIVATED` | Separate operational case and complete authority/caller/job ownership inventories. | No measured relocation need or ownership transfer evidence. |
| F1 breadth expansion | `NOT_ACTIVATED` | Relevant workflow contracts are qualified and an additional jurisdiction/connector/model role shows independent measured benefit. | Mandatory current workflow/source boundaries remain open. |

## License and distribution rule

The pinned Hermes license text is retained verbatim once in root `THIRD_PARTY_NOTICES`, with exact adapted slices listed above it. That notice covers distributed Capiro source/product artifacts containing the integrated H1, H2 and H5 adaptations. Raw donor snapshots remain external inspection evidence. H4 is omitted from the current notice because its candidate is absent from current integration; an H4 integration must update the notice in the same commit.

No acquisition row is promoted by repository popularity, a successful download, source presence, or a passing donor test. Mandatory remaining adapters cannot be reclassified as conditional experiments.