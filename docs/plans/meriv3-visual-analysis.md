# MeriV3 Visual Analysis

## Status

Feature branch: `agent/meriv3-visual-analysis`

This plan extends the existing `run_analysis` sandbox into a first-class MeriV3 visual-analysis capability. It does not replace Capiro retrieval, managed MCP apps, grounding, action approvals, or the existing sandbox isolation model.

No database migration is required.

The implementation is complete at the code level. Before merge/deployment it still requires reconciliation with current `main`, exact-head CI/typecheck/build, sandbox infrastructure verification, and live `capiro-internal` browser acceptance.

## Product objective

Meri should show a visual when a chart materially reduces the effort required to understand a government-affairs answer—not merely when a chart is technically possible.

Target behavior:

```text
user question
  -> Meri retrieves source-backed Capiro / connected-app rows
  -> deterministic visual-intent steering
  -> OpenAI reasoning decides whether analysis is warranted
  -> run_analysis performs real math in the Capiro sandbox
  -> structured findings + exact table + interactive visualization spec
  -> canonical matplotlib PNG
  -> persisted, user-scoped analysis artifact
  -> final Meri assurance decision
  -> interactive Capiro chart in MeriV3 with data and image fallback
```

The target is useful visuals in roughly 20–30% of substantive quantitative turns, not chart output in every response.

## Responsibilities

### Retrieval tools

Capiro and managed MCP tools retrieve authorized evidence. They remain the source of truth for facts and rows.

A visual is derived evidence. Every factual conclusion must continue to cite the original Capiro or connected-app retrieval that supplied its rows. `run_analysis` proves the computation; it does not replace source provenance.

### MeriV3 reasoning

The reasoning model decides what evidence is needed and whether a visual would materially improve the answer. It must not invent missing rows to complete a chart.

A deterministic classifier adds bounded steering for:

- explicit visual requests;
- substantive quantitative comparisons where a visual is recommended;
- writing/single-fact requests where the sandbox must not be called merely for decoration.

The frontier model still decides after retrieval whether the evidence is complete enough to justify analysis.

### Analysis sandbox

The sandbox performs computation and canonical rendering. It receives only bounded inline datasets already retrieved through governed tools.

Allowed pinned stack:

- pandas 2.2.3
- NumPy 2.1.3
- matplotlib 3.9.2
- SciPy 1.14.1
- statsmodels 0.14.4
- seaborn 0.13.2
- NetworkX 3.4.2

The sandbox retains:

- no network egress;
- zero-permission task role;
- scrubbed environment;
- wall-clock, CPU, memory, process, file and output limits;
- bounded queue/concurrency;
- code-hash-only audit records;
- no provider credentials.

### apps/api

`MeriV3VisualAnalysisService` is the persistence and validation boundary. It:

1. verifies the authenticated user owns the active conversation;
2. refuses a client label that differs from the conversation scope;
3. invokes the canonical `MeriToolsService.run_analysis` path;
4. validates structured visualization specs against a strict contract;
5. preserves `results.visuals[n]` ↔ `fig_n.png` alignment even when a prior spec is rejected;
6. persists structured specs and canonical PNGs as user-scoped `analysis_chart` artifacts;
7. computes canonical SHA-256 result/spec provenance hashes;
8. stores bounded dataset name/row-count provenance metadata;
9. strips raw PNG bytes and full visual rows before returning the tool result to OpenAI;
10. exposes user-scoped metadata and image endpoints to the MeriV3 web client;
11. deletes assurance-withheld, still-unlinked MeriV3 visual artifacts through a strict internal discard boundary;
12. performs a bounded 24-hour orphan recovery sweep for process/network failures.

### Isolated MeriV3 orchestrator

The orchestrator:

- checks API-owned sandbox availability before offering `run_analysis`;
- gives `run_analysis` a detailed visualization contract;
- adds deterministic per-turn visual steering;
- routes `run_analysis` through the API persistence bridge;
- exposes human work labels such as `Analyzing funding movement`, not implementation names;
- buffers visual artifact events behind the final assurance release decision;
- immediately requests discard for withheld visual IDs and for visuals buffered before an assistant-loop exception;
- emits only stable released artifact IDs to the browser;
- never exposes raw chain-of-thought;
- keeps HubSpot/Airtable optional and relevance-driven.

### Web

The MeriV3 chart card prefers the structured contract and uses the PNG as a canonical fallback/export.

The card supports:

- interactive charts;
- series toggles;
- exact data table;
- formula-safe CSV download;
- PNG download;
- expanded view;
- static fallback for older or spec-less chart artifacts;
- claim-first title;
- optional `INSIGHT` line;
- adjacent `◆ DERIVED` source/provenance strip.

## Supported visual types

| Type          | Government-affairs use                              |
| ------------- | --------------------------------------------------- |
| `line`        | budget or activity trajectory                       |
| `area`        | cumulative or composition trend                     |
| `bar`         | rankings and stage comparisons                      |
| `stacked_bar` | portfolio composition                               |
| `scatter`     | awards versus funding growth, relationship analysis |
| `pie`         | small categorical composition only                  |
| `waterfall`   | request-to-mark-to-enacted movement                 |
| `heatmap`     | client × issue exposure, urgency/materiality matrix |
| `timeline`    | hearings, marks, deadlines and engagement events    |

Complex NetworkX graphs, box plots and other matplotlib figures may still be returned as canonical PNG-only artifacts when they do not fit the version-1 interactive contract.

The interactive contract is versioned as `1` and bounded to:

- six visuals per sandbox run;
- 500 rows per visual;
- 18 scalar fields per row;
- six series per visual;
- scalar string/number/null row values only.

Unknown chart types, script fields, nested row objects, invalid field mappings, mixed prose/numeric quantitative series, negative/zero-total pies, ambiguous timeline dates and oversized payloads fail closed.

## Visual decision policy

### Explicit

Examples:

- “Chart FY24 through FY27 funding.”
- “Build a waterfall from request to enacted.”
- “Visualize portfolio exposure as a heatmap.”

Meri should retrieve the required evidence and use `run_analysis` when the rows are complete enough. If they are not, Meri explains the gap rather than producing a misleading visual.

### Recommended

Examples:

- “Compare House and Senate marks across the portfolio.”
- “What changed across this client's Program Elements?”
- “How has this client's defense exposure changed since FY24?”
- “Which PEs had the largest year-over-year cuts?”
- “What is the correlation between awards and budget growth?”

Meri should consider one decision-useful visual plus the exact table.

### Not needed

Examples:

- “What is the status of H.R. 1234?”
- “Rewrite this email.”
- “Summarize the hearing.”
- “What is 2 + 2?”

Meri must not call the sandbox merely to decorate the response.

## Structured result contract

A visual analysis script should assign a `results` object such as:

```python
results = {
    "findings": {
        "largestCut": -22.7,
        "largestCutPe": "0604201A",
    },
    "table": rows,
    "visuals": [
        {
            "chartType": "waterfall",
            "title": "House marks erase $22.7M from the FY27 request",
            "insight": "The Senate position remains at request while HAC-D is lower.",
            "description": "Request through current congressional position.",
            "xKey": "stage",
            "yAxisLabel": "USD millions",
            "series": [
                {
                    "dataKey": "delta",
                    "label": "Change",
                    "valueFormat": "currency",
                }
            ],
            "data": rows,
            "footer": "Authorization and appropriations stages remain distinct.",
        }
    ],
}
```

The same script should create the corresponding matplotlib figure in the same index order. The PNG is the canonical export artifact; the JSON spec powers the interactive browser view.

## Capiro Design System v2 visual contract

The attached Capiro Design System v2 is the UI source of truth where the original visual-analysis plan was underspecified.

Required visual grammar:

- Hanken Grotesk for product/body text;
- IBM Plex Mono for metadata, axes, units and dense tabular values;
- square persistent cards and controls;
- no persistent elevation;
- shadow only for transient expanded/modal layers;
- ink `#131A24` is the primary interactive/chart color;
- graphite/slate are supporting series;
- rust `#A85F42` is a restrained accent, not a primary button color;
- positive/negative semantics use `#2F6B4F` / `#A32B23` where appropriate;
- light gray-blue canvas/grid/divider treatment;
- linear budget/trend segments rather than decorative curves;
- tabular numerals;
- every visual marked `◆ DERIVED`;
- every visual carries an adjacent source/provenance line;
- chart titles state the claim and the chart proves it;
- missing/unknown values remain `—` rather than being silently converted to zero.

Static and interactive chart variants use the same persistent outer framing. The transient expanded overlay may use elevation.

## CSV export security

CSV export treats connected-app strings as untrusted input. String cells beginning with formula-triggering characters are prefixed with a literal apostrophe before normal CSV quoting:

```text
=  +  -  @  tab  CR/LF
```

Actual numeric values—including negative numbers—remain numeric.

## Canonical provenance hashing

Result and visual hashes use canonical JSON bytes before SHA-256:

- object keys sorted recursively;
- array order preserved;
- JSON-compatible omission/null semantics;
- UTF-8 hashing.

Object insertion order therefore cannot create different provenance hashes for the same logical result.

## Assurance and orphan lifecycle

A chart is persisted before the model can finish the answer, so artifact release is explicitly governed:

1. orchestrator buffers the artifact event;
2. base MeriV3 assurance completes;
3. released artifact IDs are emitted;
4. withheld visual IDs are sent to the strict internal discard endpoint and deleted immediately;
5. if the assistant loop throws before a final result, buffered visual IDs are also discarded immediately;
6. if the discard/link call itself fails because of process/network failure, apps/api later sweeps old unlinked V3 visuals.

Recovery defaults:

```text
MERIV3_ANALYSIS_ORPHAN_RETENTION_HOURS=24
MERIV3_ANALYSIS_ORPHAN_SWEEP_MINUTES=60
```

The recovery sweep is user-scoped, reads at most 100 old unlinked chart candidates, verifies the V3 visual source marker in application memory, and deletes only eligible IDs.

## Security and privacy

- Tool execution remains read-only.
- The browser cannot submit an arbitrary model, tenant, user, or service identity.
- Visual and managed-app execution bridges always require both forwarded authenticated user context and `INTERNAL_SERVICE_SECRET`.
- Conversation ownership is checked before compute.
- Artifacts are tenant + user scoped.
- Legacy image reads are routed through the same current-user predicate.
- Word/PowerPoint chart references are reauthorized by tenant + user + `analysis_chart` before embedding.
- Document chart-reference sets are bounded and fail instead of silently truncating authorization checks.
- PNG bytes never enter the OpenAI prompt.
- Structured visual rows are persisted, then removed from the model-facing tool result.
- Operational logs contain metadata/counts/hashes, not code, prompts, source datasets, chart rows, image bytes, client names or hidden reasoning.
- The sandbox has no network access.
- No hidden reasoning is stored in chart artifacts.

## Explicit nonchanges

This work does not change:

- Workspace generation or its in-editor assistant;
- Strategy;
- Deep Research architecture;
- Hearing Watch;
- Engagement Manager;
- action proposal / approval rules;
- institutional-memory governance;
- client/tenant walls;
- HubSpot/Airtable connection scope;
- database schema;
- MeriV2 fallback.

## Verification

Required gates:

1. sandbox typecheck;
2. sandbox containment pen-test;
3. advanced visual smoke test;
4. MeriV3 orchestrator typecheck/tests/build;
5. API visual sanitizer, canonical provenance, persistence, discard, authorization and routing tests;
6. strict internal-service-identity tests;
7. Word/PPT chart ownership/reference-bound tests;
8. assurance artifact-release and exception-cleanup tests;
9. web interactive-card + workspace rendering + formula-safe CSV tests;
10. web/API/orchestrator production builds;
11. no raw reasoning SSE events;
12. no Workspace/Strategy/intel-api MeriV3 imports;
13. live `capiro-internal` acceptance with explicit, recommended and no-chart prompts;
14. browser comparison against Capiro Design System v2.
