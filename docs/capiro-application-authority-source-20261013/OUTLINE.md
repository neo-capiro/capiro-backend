# Application authority source outline

Base: published PR2445 `9db4e1cd5589a05e08fb88caa38a4ac44937def5`. Five selected existing owners equal main4be; middleware retains the published newsletter-public bypass and conditional logging.

Canonical owners: ClerkService adds bounded read-only current-session verification, retaining original token verification/client construction. TenantContextMiddleware retains private per-request selected membership and impersonation provenance, then rechecks exact current rows and Clerk mapping after the async read. Existing provisioning, lastSeen and denial audit effects remain. MeriController/Service add two thin HTTP200/no-store routes; a cohesive pure auth application-authority module handles closed inputs, minimal receipts and deterministic revisions. ContextSecurityScopeService owns current client-only ethical-wall facts and is registered/exported in its existing ContextModule. No new service, persistent store, schema, credential, grant, lease/run or shared wire version.

Context reuses current active owned-conversation, portfolio/prospect authorization and nonarchived client lookup; unbound/portfolio contexts cannot produce a selected-client receipt. Supplied hash is correlation only. Expiry uses original verified JWT/current session/operator expiry; revisions exclude activity/profile timestamps.

Source/mock validation only, with controlled owner closures; no app/bootstrap, real SDK/provider, DB/native or customer reads. SDK getSession has no AbortSignal, so timeout bounds refusal, not transport cancellation.

Exact private read locators only: Meri7ad86d7acc1234e446cacb61c8e7f00b4bf989ab request blob0762bc4877875f6e5d5adeabbb71cdd984d35c06 and wire blob391e047b61fac0fab12ae061768e50dbcfc61e6a, PR47 comment6138126976, final84c2ca01d0bce025a0003b6e724d675a05f2975a. Private document/module contents are not copied into this packet.
