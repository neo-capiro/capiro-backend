# Capiro Capability Security Runbook

## Request construction

Create `AuthorizedCapabilityContext` only after authentication, tenant resolution, impersonation resolution, and role resolution. Do not accept `tenantId`, actor identity, or effective role from model/tool arguments.

## Client scope

When a surface establishes a client scope, include it in the context. Every client-bearing record is reauthorized. A record with no client is refused when the current context is client-scoped; it does not silently widen the query to tenant scope.

## Ethical walls

Client capabilities call the existing wall decision helper inside the tenant/user transaction. A denied or nonexistent client is returned through safe capability errors. Exclusion metadata carries counts and reason classes, never inaccessible object identities.

## Sensitive bodies

Do not return unrestricted memory, notes, transcripts, messages, drafts, or provider responses. `get_client_context` returns profile fields, bounded capability names, meeting metadata, open commitments, and empty governed-memory references until `search_memory` is implemented through the memory authorization layer.

## Provenance and logs

Results identify authorized record type, record ID, source system, source date, verification time, retrieval time, verification class, and fact/inference/recommendation class. Operational logs may record actor ID, effective tenant, surface, capability, input hash/class, client scope, source classes, counts, duration, and status; they must not record confidential result bodies.

## Incident response

On an authorization, wall, or scope defect: disable the affected adapter surface, retain audit identifiers and hashes, do not log or copy the exposed body, add a negative control, and rerun the Phase 1 and Phase 3 gates before re-enabling the adapter.
