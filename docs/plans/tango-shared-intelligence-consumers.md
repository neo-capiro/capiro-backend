# Tango shared federal intelligence consumers

Branch: `agent/tango-shared-intelligence-consumers`

This implementation extends the already-merged MakeGov/Tango substrate for three consumers:

1. District Nexus — contracts, subawards, and future opportunities remain separate geographic rails.
2. Federal Spending — local exploration of normalized contracts, vehicles, subawards, and forecasts.
3. Meriv3 — read-only tools over the same local normalized intelligence.

## Locked boundaries

- Funding Opportunities remains the owning roadmap for provider ingestion and source precedence.
- Existing first-party SAM.gov, Grants.gov, and USAspending fields remain canonical.
- Tango data is additive, provider-labelled, and never fetched synchronously from a user request.
- Awarded money is never blended with forecasts or open opportunities.
- Null means unknown/not stated, never zero.
- Client-specific reads require confirmed mappings and tenant/client scope.
- Meriv3 tools read local tables only and cannot retrieve provider credentials.
- No feature flags, schedules, migrations, data jobs, or deployments are executed by this branch.
