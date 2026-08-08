# MeriV3 Visual Analysis — Capiro Internal Canary Runbook

## Scope

Deploy and validate MeriV3 visual analysis for the `capiro-internal` canary.

Affected deployables only:

1. `clio-sandbox`
2. `apps/api`
3. `apps/meriv2-orchestrator`
4. `apps/web`

No database migration is required. Do not deploy Workspace, Strategy, workers or scheduler for this feature.

## Preconditions

- Feature work has been reconciled onto the intended current-main integration SHA.
- `.github/workflows/meriv3-visual-analysis-ci.yml` is green at that exact SHA.
- MeriV3 remains canaried to `capiro-internal`.
- MeriV2 rollback remains available.
- Sandbox retains no-egress security group, zero-permission task role, read-only root filesystem and writable `/tmp`.
- API and sandbox share `CLIO_SANDBOX_TOKEN` through secret references.
- API and isolated orchestrator share `INTERNAL_SERVICE_SECRET` through secret references.

Do not print secret values.

## Required configuration

### API

```text
CLIO_ANALYSIS_SANDBOX_ENABLED=true
CLIO_SANDBOX_URL=<private sandbox service URL>
CLIO_SANDBOX_TOKEN=<secret reference>
MERIV3_ENABLED=true
MERIV3_CANARY_TENANT_SLUGS=capiro-internal
INTERNAL_SERVICE_SECRET=<secret reference>

# optional; defaults shown
MERIV3_ANALYSIS_ORPHAN_RETENTION_HOURS=24
MERIV3_ANALYSIS_ORPHAN_SWEEP_MINUTES=60
```

The two orphan variables are crash/network-recovery hygiene. A chart withheld by final assurance is normally deleted immediately through the strict discard bridge.

### Sandbox

```text
CLIO_SANDBOX_TOKEN=<same secret reference>
CLIO_SANDBOX_CONCURRENCY=<existing bounded value, normally 2>
```

### Isolated MeriV3 orchestrator

```text
MERIV3_ENABLED=true
MERIV3_CANARY_TENANT_SLUGS=capiro-internal
MERIV2_API_BASE_URL=<existing internal API URL>
INTERNAL_SERVICE_SECRET=<same service-identity secret>
```

## Exact-head build gate

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
```

Stop on any P0/P1 or failed gate.

## Deployment order

### 1. Sandbox

Deploy the pinned analysis image first.

Required Python packages:

```text
pandas 2.2.3
NumPy 2.1.3
matplotlib 3.9.2
SciPy 1.14.1
statsmodels 0.14.4
seaborn 0.13.2
NetworkX 3.4.2
```

Verify private health:

```text
GET /healthz
```

Expected shape:

```json
{ "ok": true, "active": 0, "queued": 0 }
```

Run a private authenticated smoke that imports the entire pinned stack, loads a bounded inline dataset, performs a calculation, returns `results.visuals`, and emits at least one matplotlib PNG.

Do not expose the sandbox publicly.

### 2. API

Deploy API after sandbox health passes.

Verify:

- `/health` passes;
- `GET /api/clio/v3/capabilities` reports `visualAnalysis.enabled=true` for `capiro-internal`;
- disabling the sandbox gate causes `visualAnalysis.enabled=false`;
- user bearer without `x-internal-service-secret` cannot call `POST /api/clio/v3/visual-analysis`;
- the same is true for `POST /api/clio/v3/visual-analysis/discard` and managed-app execution;
- another user in the same tenant cannot read chart metadata or PNG;
- legacy analysis image URL is also user scoped;
- Word/PowerPoint cannot embed another user's chart ID.

### 3. Isolated MeriV3 orchestrator

Deploy after API health passes.

Verify:

- MeriV2 remains healthy;
- `run_analysis` is offered only when apps/api reports the sandbox available;
- a visual analysis uses the API bridge;
- work UI says `Analyzing funding movement`, `Ranking results`, etc., never `run_analysis`;
- raw PNG base64 and full visual row arrays do not return to OpenAI;
- artifact SSE waits for final assurance;
- a held chart triggers the discard bridge and is not released;
- no raw reasoning/thinking event is emitted.

### 4. Web

Deploy last.

## Capiro Design System v2 visual acceptance

Compare the live analysis card against the supplied Capiro Design System v2.

Required:

- Hanken Grotesk product/body text;
- IBM Plex Mono metadata, axes, units and table values;
- square card and square controls;
- no persistent-card shadow;
- expanded overlay may use elevation because it is transient;
- ink/graphite active controls, not rust-filled controls;
- rust used as restrained insight/source accent;
- neutral gray-blue canvas/dividers;
- 11px mono chart axes/units;
- linear budget/trend lines rather than decorative smoothing;
- tabular numerical values;
- `◆ DERIVED` evidence marker;
- adjacent source/provenance strip;
- claim-first chart title;
- optional `INSIGHT` line when a concise takeaway exists;
- missing values displayed as unknown/`—`, never silently zeroed;
- static PNG fallback uses the same card framing as the interactive chart.

Required controls:

```text
CHART
DATA
IMAGE (when PNG exists)
CSV
PNG (when PNG exists)
EXPAND / CLOSE
```

Fallback copy:

```text
INTERACTIVE VIEW UNAVAILABLE · SHOWING SAVED ANALYSIS IMAGE
```

Do not add a chart mode, chart button, graph-library picker, Python/code panel, or separate analytics workspace.

## Live acceptance prompts

Use real authorized data under `capiro-internal`.

### Explicit funding trajectory

> Chart the most relevant Program Element's funding trajectory from FY24 through FY31. Keep request, authorization marks, appropriations marks, conference, enacted, and outyear projections clearly labeled and do not connect incomparable stages.

PASS:

- real PE/source retrieval happens first;
- analysis runs only after source-backed rows exist;
- chart title states the principal finding;
- exact data table exists;
- line is not decorative/smoothed;
- missing stages remain missing;
- answer cites the original budget sources;
- chart shows `◆ DERIVED` + source strip.

### Budget waterfall

> Build a waterfall showing how the FY27 position moved from the President's Budget request through the House and Senate marks to the current authoritative appropriations figure. Explain each movement and cite the underlying source.

PASS:

- signed changes reconcile;
- one decision-useful waterfall;
- no invented conference/enacted value;
- original source citations remain in the answer;
- positive/negative movements use restrained semantic colors.

### Portfolio heatmap

> Show a heatmap of our clients against their most material current issues. Use only evidence Capiro has, explain the scoring basis, and leave cells empty when coverage is insufficient.

PASS:

- no cross-client leak;
- unknown cell renders `—`/missing treatment rather than zero;
- source/evidence strip visible;
- no unsupported NOT FILED/UNPUBLISHED label is invented.

### Ranking

> Rank the ten largest verified budget cuts affecting this client and show them as a horizontal bar chart with the exact amount and stage.

PASS:

- descending real ranking;
- exact signed values;
- stage/fiscal year retained;
- data table available.

### Correlation

> Is there a relationship between this client's relevant federal awards and the growth of its linked Program Elements? Show the scatterplot, calculate the correlation, and explain why correlation is not causation.

PASS:

- real join keys and coverage stated;
- statistic calculated in sandbox;
- no causal claim;
- original award/budget retrieval cited.

### Decision timeline

> Build a timeline of the upcoming hearings, markups, deadlines, meetings, and outreach commitments that matter to this client over the next 60 days.

PASS:

- authorized sources only;
- ISO-backed dates;
- public events remain distinct from internal commitments;
- no invented dates.

## No-chart controls

Ask each:

```text
What is the current status of H.R. 1234?
Rewrite this sentence more professionally.
Draft a short thank-you email to the client.
What is 2 + 2?
```

PASS:

- sandbox is not called merely to decorate the answer;
- no chart appears.

## CSV security acceptance

Use an authorized Airtable/HubSpot test record containing literal string cells beginning with:

```text
=SUM(1,1)
+SUM(1,1)
-2+3
@IMPORTDATA("x")
```

Download CSV.

PASS:

- untrusted string cells have a leading apostrophe before CSV quoting;
- Excel/Sheets does not execute them as formulas;
- actual numeric negative values remain numeric.

## Artifact persistence and isolation

1. Generate a chart.
2. Close the Meri workspace.
3. Reopen the conversation.
4. Confirm chart reloads by artifact ID.
5. Open DATA and verify exact rows.
6. Download PNG and CSV.
7. Try metadata/image reads as another same-tenant user.
8. Try Word/PPT embedding using another user's chart ID.

PASS:

- owner can reload and export;
- other user receives not-found/denial;
- no provider call is required to rerender;
- document generation cannot bypass chart ownership.

## Assurance/discard acceptance

Use a high-risk exact-number prompt with intentionally incomplete evidence.

PASS:

- final assurance holds the answer where required;
- chart artifact event never reaches browser;
- strict discard endpoint is called for withheld chart IDs;
- unlinked withheld chart is deleted;
- normal hold explanation remains visible;
- cleanup failure, if simulated, does not turn a safe held response into an unsafe model retry;
- recovery sweep later removes any old unlinked V3 visual left by process/network failure.

## Rollback

Visual-analysis-only rollback:

```text
CLIO_ANALYSIS_SANDBOX_ENABLED=false
```

Roll API tasks. On the next turn, orchestrator capability discovery removes `run_analysis`.

Full MeriV3 rollback remains the existing tenant/runtime flag rollback.

Restore the previous sandbox task definition/image digest if the new analysis image itself is defective.

No migration rollback is needed.

## Exit criteria

Do not mark production-ready until all are true:

- exact integrated SHA recorded;
- dedicated CI green;
- sandbox containment + advanced smoke PASS;
- API/orchestrator/web typecheck/tests/build PASS;
- design-system browser acceptance PASS;
- explicit/recommended/no-chart prompts PASS;
- CSV formula test PASS;
- same-tenant artifact isolation PASS;
- document chart ownership PASS;
- assurance discard PASS;
- source citations remain grounded in original retrieval;
- no open P0/P1.
