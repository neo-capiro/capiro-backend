# Shared Capiro Capabilities V1

## Authority

A Capiro domain capability is authoritative. Provider adapters such as model function tools or MCP are transport layers and may not own business authorization, provenance, freshness, or result-shaping logic.

## Closed catalog

```text
search_capiro
get_capiro_record
get_client_context
search_memory
research_government
analyze_relationships
get_recent_activity
search_targets
get_target_profile
```

The catalog fixture records the domain owner, implementation status, schemas, tenant/client authorization boundary, ethical-wall behavior, provenance class, freshness behavior, sensitivity behavior, error contract, and both Meri and Outreach consumers.

Phase 1 implements `get_client_context`, `get_recent_activity`, and `get_capiro_record`. The other entries are contract-only; their names are reserved so later phases extend one registry rather than creating Meri-specific and Outreach-specific copies.

## Authorized context

The server supplies actor, effective tenant, role, request ID, surface, optional authorized client scope, and optional impersonation context. Model arguments never override an authenticated tenant.

## Result envelope

Every result is schema version 1 and includes data, structured provenance, redacted exclusion counts, effective scope, freshness status, and authorization filtering status. Results are bounded by timeout, maximum record count, and maximum serialized bytes.

## Errors

Model-facing errors expose only a stable code, safe message, retryability, and whether scope changed. Database details, SQL, provider bodies, stacks, secrets, and tokens are never included.
