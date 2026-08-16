# Meri V3 Semantic Skills Rollout

This runbook covers the production-safe rollout of Meri V3 Quick Actions, the semantic tool gateway, the Research Director company-research cutover, and the funding/artifact compatibility gateways.

The architecture rule is unchanged: OpenAI reasons over evidence; Capiro retrieves authoritative facts, enforces tenant and client scope, guarantees deterministic coverage where required, and governs real actions.

## Scope of this release

This release adds:

- one canonical `@capiro/shared/meri-skills` registry;
- five user-facing Quick Actions in the bottom-right Meri V3 workspace;
- editable starter prompts that never auto-send;
- Quick Action turn telemetry without prompt bodies;
- a semantic schema gateway with legacy, shadow and enabled modes;
- an allowlisted Research Director cutover for external-company strategy;
- an allowlisted `analyze_funding_opportunity` evidence gateway;
- an allowlisted `create_artifact` compatibility gateway.

It does not delete legacy tools or services and does not create a Meri-specific vector database, graph, canonical entity system, memory store, source catalog or data dictionary.

## Feature flags

All flags are server-side and default off unless stated otherwise.

| Flag | Service | Purpose |
| --- | --- | --- |
| `MERI_QUICK_ACTION_SKILLS_ENABLED` | API | Global emergency switch for the Quick Actions catalog. |
| `MERI_QUICK_ACTION_SKILLS_TENANTS` | API | Comma-separated tenant-slug allowlist. Defaults to `capiro-internal`. |
| tenant setting `meriv3.quickActionSkills` | API | Per-tenant carve-out; explicit `false` disables the surface. |
| `MERI_SEMANTIC_TOOL_GATEWAY_SHADOW` | orchestrator | Computes the proposed semantic tool set while preserving legacy schema exposure. |
| `MERI_SEMANTIC_TOOL_GATEWAY_ENABLED` | orchestrator | Exposes the reduced semantic tool set for allowlisted tenants. |
| `MERI_SEMANTIC_TOOL_GATEWAY_TENANTS` | orchestrator | Comma-separated tenant-ID allowlist for shadow/enabled gateway modes. `*` is supported only for an intentional fleet rollout. |
| `MERI_RESEARCH_DIRECTOR_CANONICAL_ENABLED` | orchestrator | Replaces the model-facing `research_external_company` reasoning path with `research_federal_market_strategy`. |
| `MERI_RESEARCH_DIRECTOR_CANONICAL_TENANTS` | orchestrator | Tenant-ID allowlist for company-research canonicalization. Falls back to the semantic-gateway allowlist. |
| `MERI_FUNDING_SEMANTIC_TOOLS_ENABLED` | orchestrator | Exposes `analyze_funding_opportunity` and hides redundant funding reasoning schemas. |
| `MERI_FUNDING_SEMANTIC_TOOLS_TENANTS` | orchestrator | Tenant-ID allowlist for funding consolidation. Falls back to the semantic-gateway allowlist. |
| `MERI_ARTIFACT_TOOL_V2_ENABLED` | orchestrator | Exposes `create_artifact` and hides the five legacy artifact schemas from the model. |
| `MERI_ARTIFACT_TOOL_V2_TENANTS` | orchestrator | Tenant-ID allowlist for artifact consolidation. Falls back to the semantic-gateway allowlist. |

Do not enable `MERI_SEMANTIC_TOOL_GATEWAY_SHADOW` and `MERI_SEMANTIC_TOOL_GATEWAY_ENABLED` simultaneously. If both are true, enabled mode wins.

## Release sequence

### Release A — registry and Quick Actions

Deploy `packages/shared`, `apps/api` and `apps/web` with every new flag off. Enable:

```text
MERI_QUICK_ACTION_SKILLS_ENABLED=true
MERI_QUICK_ACTION_SKILLS_TENANTS=capiro-internal
```

Set tenant setting `meriv3.quickActionSkills=true` for the internal tenant if it is not already inheriting the default.

Verify:

- all five actions appear in a fresh chat;
- the compact Quick Actions trigger appears in an existing thread;
- client scope hydrates the Client Changes starter prompt;
- clicking an action only fills and focuses the composer;
- the user can edit before sending;
- no telemetry event contains the prompt body;
- a disabled or non-allowlisted tenant receives an empty skill catalog.

Rollback: set `MERI_QUICK_ACTION_SKILLS_ENABLED=false`.

### Release B — semantic gateway shadow

Deploy the orchestrator and enable only:

```text
MERI_SEMANTIC_TOOL_GATEWAY_SHADOW=true
MERI_SEMANTIC_TOOL_GATEWAY_ENABLED=false
MERI_SEMANTIC_TOOL_GATEWAY_TENANTS=<internal-tenant-id>
```

Legacy schema exposure and behavior remain unchanged. Collect telemetry for the benchmark corpus and inspect:

- `semanticToolsAvailable`;
- `semanticToolsProposed`;
- `semanticToolsExposed`;
- `schemasExposedButUnused`;
- `missingToolFromSemanticSet`;
- `semanticFallbackToLegacy`;
- actual `modelTools` and `outOfPlanModelTools`;
- coverage, pagination debt, latency and failures.

A missing tool in the proposed set is a routing defect to fix. Do not resolve it by permanently restoring the entire raw catalog.

Rollback: set `MERI_SEMANTIC_TOOL_GATEWAY_SHADOW=false`.

### Release C — internal semantic gateway canary

After shadow parity, switch the internal tenant to:

```text
MERI_SEMANTIC_TOOL_GATEWAY_SHADOW=false
MERI_SEMANTIC_TOOL_GATEWAY_ENABLED=true
MERI_SEMANTIC_TOOL_GATEWAY_TENANTS=<internal-tenant-id>
```

The gateway exposes at most 20 schemas. If its proposed set is empty, it fails safe to the governed legacy surface for that turn and records the fallback reason.

Rollback: set `MERI_SEMANTIC_TOOL_GATEWAY_ENABLED=false`.

### Release D — Research Director canonicalization

After company-research regression parity:

```text
MERI_RESEARCH_DIRECTOR_CANONICAL_ENABLED=true
MERI_RESEARCH_DIRECTOR_CANONICAL_TENANTS=<internal-tenant-id>
```

Verify that the Research a Company Quick Action and ordinary comprehensive federal-market requests force `research_federal_market_strategy`. The old `research_external_company` implementation remains available internally as a compatibility/evidence collector.

Rollback: set `MERI_RESEARCH_DIRECTOR_CANONICAL_ENABLED=false`.

### Release E — funding evidence gateway

After the Funding Opportunities feature is already enabled for the tenant:

```text
MERI_FUNDING_SEMANTIC_TOOLS_ENABLED=true
MERI_FUNDING_SEMANTIC_TOOLS_TENANTS=<internal-tenant-id>
```

The model keeps atomic search/get access and receives `analyze_funding_opportunity`. The wrapper calls the existing governed opportunity facts, client context, deterministic match evidence and government-landscape tools. OpenAI performs comparison, ranking, pursuit recommendations, strategy and action planning.

The following schemas are hidden from direct model exposure only for the allowlisted tenant:

- `explain_opportunity_match`;
- `get_opportunity_client_context`;
- `get_opportunity_government_landscape`;
- `compare_funding_opportunities`;
- `build_opportunity_action_plan`.

Their backend implementations remain intact.

Rollback: set `MERI_FUNDING_SEMANTIC_TOOLS_ENABLED=false`.

### Release F — artifact gateway

After Word, Excel, PowerPoint, meeting-brief and policy-memo regression tests pass:

```text
MERI_ARTIFACT_TOOL_V2_ENABLED=true
MERI_ARTIFACT_TOOL_V2_TENANTS=<internal-tenant-id>
```

The model receives `create_artifact`; the wrapper delegates to the existing generation tool for the requested type. The underlying tool still owns validation, compliance, approval, persistence, versioning and export. No write bypass is introduced.

Rollback: set `MERI_ARTIFACT_TOOL_V2_ENABLED=false`.

## Required benchmark corpus

Run at least these cases in legacy, shadow and canary modes:

1. **Company strategy:** “Give me a comprehensive strategy on kindeticindustries.inc. Tell me what Program Elements, grants, or government contracts they should pursue.”
2. **Relationship:** “Look in my inbox and tell me everything I should know about Victory Six.”
3. **Client changes:** “Nothing happened with this client this week, right?”
4. **Portfolio changes:** “What changed across my clients this week?”
5. **Portfolio overlap:** “Research Shield AI and search across my clients for overlap.”
6. **Legislation:** bill status, committee roster and vote questions.
7. **Funding:** search, exact opportunity retrieval and a client-specific pursuit analysis.
8. **Artifacts:** Word, spreadsheet, PowerPoint, meeting brief and policy memo.
9. **Governed actions:** email, reply, task, client update and memory lifecycle.
10. **Managed MCP:** one request that names a connected app and one that does not.

Compare quality, coverage, exactness, latency, tokens, tool failures and tenant scope. Negative claims are allowed only when the coverage manifest supports them.

## Telemetry and privacy

Quick Action telemetry records only:

- tenant and user IDs;
- `skillId`;
- `quickActionUsed=true`;
- subject scope;
- whether a client was selected;
- canonical recipe.

It never records the starter prompt or the user's edited prompt.

Retrieval telemetry records schema/tool names, routing, coverage, timing and failures. Do not add email bodies, document bodies, memory contents, tool payloads or retrieved evidence to these logs.

## Knowledge Plane boundary

Knowledge Plane integration remains a separate parity-gated release. Meri must consume the canonical source catalog, data dictionaries, entity definitions, exact retrieval, semantic retrieval, provenance, freshness, relationship graph, temporal events and context resolver when those interfaces are production-ready.

Do not implement a temporary Meri-owned substitute. In particular, do not add:

- a parallel vector database;
- a parallel knowledge graph;
- a parallel canonical entity model;
- a parallel memory lifecycle;
- a duplicate data dictionary or source catalog.

`retrieve_context`, `query_relationship` and graph-backed portfolio overlap should first run in shadow against the existing retrieval recipes. Cutover requires structured/exact parity, tenant-wall parity, provenance/freshness parity and a retained legacy fallback. Semantic similarity alone is not a completion criterion.

## Production ramp and cleanup

Ramp each enabled capability independently:

```text
internal → selected design partners → 25% → 50% → 100%
```

Do not perform destructive cleanup between ramp stages. Compatibility code may be deleted only after the replacement survives at least one complete production release cycle, telemetry shows no required caller, regression benchmarks equal or beat the legacy behavior, and rollback has been exercised successfully.
