# MeriV3 Visual Analysis — Implementation Handoff

## Git

- Repository: `neo-capiro/capirov2`
- Feature branch: `agent/meriv3-visual-analysis`
- Created from `main` at: `aff4e5a23001edd52c7728440900dd5dc21ced28`
- Merge/deployment status: **not merged, not deployed**
- Database migration: **none**

`main` has moved since this branch was created. Before shipping, resolve the exact feature/main heads and reconcile onto a fresh integration branch rather than deploying this old-lineage feature branch directly.

```bash
git fetch origin --prune
git rev-parse origin/main
git rev-parse origin/agent/meriv3-visual-analysis
git rev-list --left-right --count origin/main...origin/agent/meriv3-visual-analysis
```

## Product result

MeriV3 now uses Capiro's existing no-egress analysis sandbox as a governed quantitative and visual analyst:

```text
user question
  -> governed Capiro / connected-app retrieval
  -> source-backed rows
  -> visual-intent steering
  -> OpenAI reasoning decides whether analysis materially helps
  -> run_analysis in Capiro sandbox
  -> findings + exact table + structured visual spec + matplotlib PNG
  -> API validates and persists a user-scoped artifact
  -> Meri answer retains original source citations
  -> interactive Capiro chart renders inline
```

Meri does not create a chart merely because the sandbox is available.

## Supported analysis stack

The pinned sandbox includes:

- pandas 2.2.3
- NumPy 2.1.3
- matplotlib 3.9.2
- SciPy 1.14.1
- statsmodels 0.14.4
- seaborn 0.13.2
- NetworkX 3.4.2

The sandbox keeps the existing containment model: no network egress, zero-permission task role, scrubbed environment, no provider credentials, bounded process/resources/output, bounded concurrency, and code-hash audit rather than source-code logging.

## Interactive visual contract

Version 1 supports:

- line
- area
- bar
- stacked bar
- scatter
- pie
- waterfall
- heatmap
- timeline

Complex NetworkX diagrams, distributions, box plots and other matplotlib output may still be returned as canonical PNG-only artifacts.

The structured contract is bounded to six visuals, 500 rows per visual, 18 scalar fields per row and six series. It fails closed on unsupported/script chart types, nested rows, malformed mappings, prose-formatted numeric series, nonnumeric scatter axes, multi-series waterfalls, negative/zero-total pies and ambiguous timeline dates.

Visual candidates retain their original index so a rejected visual can never become paired with the wrong `fig_n.png`.

## Capiro Design System v2 UI

The inline chart card was revised against the supplied **Capiro Design System v2** rather than introducing a separate visualization aesthetic.

Implemented design rules:

- Hanken Grotesk for product/UI text;
- IBM Plex Mono for metadata, axes, units and dense values;
- square persistent cards and controls;
- persistent cards have **no elevation**;
- shadow exists only on the transient expanded overlay;
- ink/graphite are the primary interactive colors;
- rust is an accent, not a primary button color;
- neutral canvas/borders use the Capiro gray-blue palette;
- chart axes use 11px mono metadata treatment;
- budget/trend lines use linear segments rather than decorative smoothing;
- values use tabular numerals;
- every visual is explicitly marked `◆ DERIVED`;
- every card carries an adjacent source/provenance strip;
- titles are decision claims (`HAC-D sits $22.7M below the FY27 request`) rather than generic labels (`Funding chart`);
- optional `INSIGHT` copy explains the decision-useful takeaway;
- missing heatmap values remain `—` rather than being silently rendered as zero;
- static PNG and interactive variants use the same outer framing.

The card supports:

- interactive chart;
- series toggles/evidence markers;
- exact data table;
- CSV download;
- canonical PNG download;
- expanded view;
- static fallback;
- persisted reload.

Static fallback copy is intentionally calm:

```text
INTERACTIVE VIEW UNAVAILABLE · SHOWING SAVED ANALYSIS IMAGE
```

The provenance strip is intentionally separate from the factual citations in Meri's answer:

```text
◆ DERIVED · SOURCE DATA · <authorized dataset labels> · <row count> · <generated time> · SOURCES · SEE MERI CITATIONS
```

`run_analysis` proves the computation, not the provenance of its input facts. The surrounding Meri answer must continue citing the original Capiro/HubSpot/Airtable retrieval sources.

## Human-readable work activity

The UI no longer exposes `run_analysis` as the work label. Depending on the task, the user sees bounded activity such as:

- `Analyzing funding movement`
- `Analyzing trend`
- `Ranking results`
- `Mapping exposure`
- `Calculating relationship`
- `Building decision timeline`
- `Testing scenarios`
- `Analyzing relationships`

No chain-of-thought or hidden reasoning is exposed.

## Closed hardening gaps

### 1. CSV formula injection — CLOSED

CSV export now neutralizes untrusted string cells that can be interpreted as spreadsheet formulas when they begin with:

```text
=  +  -  @  tab  CR/LF
```

The string receives a leading apostrophe before normal CSV quoting. Real numeric values, including negative numbers, remain numeric.

This protects chart data originating from connected apps such as Airtable/HubSpot without corrupting legitimate quantitative values.

### 2. Canonical provenance hashing — CLOSED

Analysis result/spec hashes now use a canonical serializer:

- object keys sorted recursively;
- array order preserved;
- JSON-compatible omission/null behavior;
- SHA-256 over canonical UTF-8 bytes.

Logically identical JSON objects therefore receive the same provenance hash regardless of insertion order.

### 3. Assurance-held orphan artifacts — CLOSED

Artifact events remain buffered behind the MeriV3 assurance release decision.

If assurance withholds a chart:

1. its artifact event never reaches the browser;
2. it is absent from the released assistant result;
3. the isolated orchestrator calls the strict internal discard endpoint;
4. apps/api re-checks tenant, owning user, `analysis_chart`, `messageId=null`, and the V3 visual source marker;
5. the artifact is deleted immediately.

A bounded opportunistic cleanup remains as crash/network recovery only:

```text
MERIV3_ANALYSIS_ORPHAN_RETENTION_HOURS=24    # default
MERIV3_ANALYSIS_ORPHAN_SWEEP_MINUTES=60     # default
```

The recovery sweep reads at most 100 old unlinked candidates per user, checks their source marker in application memory, then deletes only eligible IDs. It cannot delete a released chart because released artifacts are linked to the assistant message.

## Security boundaries

### User-scoped chart reads

Both metadata and image reads require tenant + owning user:

```text
GET /api/clio/analysis-artifacts/:artifactId
GET /api/clio/analysis-artifacts/:artifactId/image
```

The legacy analysis image path delegates through the same user-scoped reader.

### Word / PowerPoint embedding

Before `create_word` or `create_powerpoint` can embed `imageArtifactIds`, the governed Meri tool proxy reauthorizes every referenced chart against:

- tenant;
- current user;
- `kind=analysis_chart`.

The reference set is bounded to 240. Oversized input fails instead of silently truncating authorization checks.

### Strict internal service identity

New MeriV3 internal execution surfaces use `MeriV3InternalServiceGuard`, not the legacy observe-capable guard:

```text
POST /api/clio/v3/mcp-tools/:toolName
POST /api/clio/v3/visual-analysis
POST /api/clio/v3/visual-analysis/discard
```

They always require the shared `INTERNAL_SERVICE_SECRET` in addition to the forwarded authenticated user context. Missing service configuration fails closed.

## Artifact and model-context discipline

The API persistence boundary:

1. verifies conversation ownership;
2. checks client scope;
3. calls the canonical `run_analysis` implementation;
4. validates the structured spec;
5. persists the chart artifact;
6. returns stable artifact IDs;
7. strips PNG base64 and the full visual row payload before the tool result re-enters model context.

Persisted metadata can include bounded provenance aids (dataset name/count summaries, purpose and hashes), but operational telemetry contains IDs/counts/types/duration only—never Python code, prompt/purpose text, source data rows, image base64, client names, or hidden reasoning.

## CI gate

Dedicated workflow:

```text
.github/workflows/meriv3-visual-analysis-ci.yml
```

It covers:

- Prettier;
- sandbox/API/orchestrator/web typecheck;
- advanced sandbox containment + visual smoke;
- all isolated MeriV3 tests;
- strict visual contract;
- canonical provenance hashing;
- visual/PNG index alignment;
- persistence/access control;
- immediate discard + bounded orphan recovery;
- strict internal service identity;
- Word/PPT chart ownership and reference bounds;
- assurance artifact release ordering;
- human-readable work labels;
- formula-safe CSV export;
- design-system card behavior;
- production builds;
- no hidden-reasoning SSE;
- no Workspace/Strategy/intel-api MeriV3 spillover.

## Verification commands

```bash
pnpm install --frozen-lockfile

pnpm --filter @capiro/api exec prisma generate
pnpm --filter @capiro/workspace exec prisma generate
pnpm --filter @capiro/intel-api exec prisma generate
pnpm --filter @capiro/onboard-api exec prisma generate
pnpm --filter @capiro/api-strategy exec prisma generate

pnpm --filter @capiro/shared build
pnpm --filter @capiro/auth build
pnpm --filter @capiro/meriv2-core build
pnpm --filter @capiro/strategy-verifier build

pnpm --filter @capiro/clio-sandbox typecheck
pnpm --filter @capiro/clio-sandbox pentest
pnpm --filter @capiro/clio-sandbox visual-smoke

pnpm --filter @capiro/meriv2-orchestrator typecheck
pnpm --filter @capiro/meriv2-orchestrator exec jest --runInBand --forceExit src/meri/meriv3
pnpm --filter @capiro/meriv2-orchestrator build

pnpm --filter @capiro/api exec tsc --noEmit
pnpm --filter @capiro/api exec jest --runInBand --forceExit \
  src/meri/governed-meri-tools.chart-scope.spec.ts \
  src/meri/meri-analysis-artifact.controller.spec.ts \
  src/meri/meri-analysis-provenance.spec.ts \
  src/meri/meri-analysis-visualization.spec.ts \
  src/meri/meri-v3-internal-service.guard.spec.ts \
  src/meri/meri-v3-visual-analysis.service.spec.ts \
  src/meri/meri-v3-visual-analysis.alignment.spec.ts \
  src/meri/meriv3-runtime.proxy.spec.ts \
  src/meri/meriv3-settings.controller.visual-analysis.spec.ts
pnpm --filter @capiro/api build

pnpm --filter @capiro/web typecheck
pnpm --filter @capiro/web exec vitest run \
  src/components/chat/AnalysisChartCard.test.tsx \
  src/components/chat/MeriWorkspaceConversation.test.tsx \
  src/components/chat/MeriWorkspaceWindow.test.tsx \
  --testTimeout=20000 --hookTimeout=20000
pnpm --filter @capiro/web build

git diff --check
git status --short
```

## Deployment order

After reconciliation with current main and green exact-head verification:

```text
sandbox
→ API
→ isolated MeriV3 orchestrator
→ web
```

No database migration is required. Do not deploy Workspace, Strategy, scheduler or workers for this feature.

## Remaining blockers before merge/deploy

The previously documented **code hardening gaps are closed**.

Remaining gates are verification/environment gates, not unfinished feature implementation:

1. reconcile the branch with current `main` on a fresh integration branch;
2. run the dedicated CI/local gate at the exact integrated SHA;
3. confirm `INTERNAL_SERVICE_SECRET` exists on both API and isolated orchestrator;
4. confirm the sandbox task still has zero egress, zero IAM permissions, read-only root and writable `/tmp`;
5. perform `capiro-internal` browser acceptance using explicit-chart, recommended-chart and no-chart prompts.

Do not call the feature production-ready until those exact-head/live gates pass.
