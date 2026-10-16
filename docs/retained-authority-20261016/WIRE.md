# Disabled retained-read source wire

This separate source increment is not mounted by Core AppModule or Intel. No issuer, key, audience origin, credential resource or workload trust is allocated. Missing genuine owners return 503. Existing public routes, guards, native identity/context receipts, Meri contexts and domain DTOs remain authoritative and unchanged.

## Current resource observations

Native Capiro/Clerk user Bearer is accepted only by CONTROL-side Core calls. Fixed POST siblings under `/api/clio/application-authority/` are `retained-research-portfolio`, `retained-research-portfolio-changes`, and `retained-florida-budget`.

Portfolio selector is exactly `{schemaVersion:1,portfolioId:lowercaseUUID}`. Florida selector is exactly `{schemaVersion:1,sessionKey:string(0..256),folderId:lowercaseUUID|null,clientSelector:trimmedNonemptyString(1..256)|null}`. Empty sessionKey is preserved byte for byte; no trim/current-session substitution.

Closed Portfolio response: `{schemaVersion:1,operation,principal:{tenantId,actorId},identityRevision:hex64,resourceRevision:hex64,selectorSha256:hex64,scope:{portfolioId},checkedAtMs,expiresAtMs}`. Florida replaces `scope` with `effectiveScope:{jurisdiction:'FL',sessionKey,folderId,clientId}` and `clientResolution:null|{selector,clientId}`. All returned client/portfolio/principal IDs are canonical lowercase UUIDs. `actorId` is Core `users.id`; `clerkUserId` is a separate verified native identity and is not interchangeable.

selectorSha256 binds the whole parsed fixed selector, including schemaVersion and explicit nulls. resourceRevision binds deterministic current producer-specific resource/grant/wall facts. It excludes observation clocks, expiry and identityRevision. Portfolio Detail observes currently linked-client walls; Changes observes the exact sorted tenant denied-client set including historical/unlinked IDs. False linked walls filter visibility and do not deny an otherwise readable portfolio. Florida observes current budget feature, native user/member, folder/client and wall facts. Before/after changes withhold results; observations are not locks or historical revocation logs.

## Issuer and data siblings

| Operation | Native CONTROL issuer POST, under `/api/clio/application-authority/` | Delegated data POST |
| --- | --- | --- |
| get_research_portfolio | retained-research-portfolio-principal | /api/clio/retained-reads/research-portfolio |
| get_research_portfolio_changes | retained-research-portfolio-changes-principal | /api/clio/retained-reads/research-portfolio-changes |
| get_florida_budget_project | retained-florida-principal | /intel-api/internal/legiwatch/retained-florida-budget |

Issuer body is exactly `{schemaVersion:1,request,context,originalExpiresAtMs}`. Data body is exactly `{schemaVersion:1,request,context}`. Bodies are bounded at 2 MiB. `request` and `context` are the existing accepted operation shapes at Meri `75a6bd646a7df70bb650afe6b5827cd5aeb88542`, not a new model-controlled portfolio selector. RP request has only optional conversationId; Changes additionally optional cursor/limit. RP context is exactly `{binding:fullMeriRunBinding,subject:fullMeriResolvedSubject}`; normalization derives the one portfolio ID from the captured entity subject. Florida context is exactly `{asOf:capturedObservationISO,effectiveScope:{jurisdiction:'FL',sessionKey,folderId,clientId},clientResolution:null|{selector,clientId}}`; normalization follows the accepted frozen Florida validator, including empty sessionKey behavior.

Core independently checks its native principal and current resource. Meri run/worker/fence/scopes in context are correlation data, not Core-issued authority. CONTROL checks the genuine current Meri store and the same admitted task before and after calls. Core never equates a Meri conversation UUID with a legacy Core conversation ID. Direct actor equality is usable only where a genuine canonical startup identity seeded that binding; absent mapping is unavailable.

Issuer success is the raw envelope, status 200, no wrapper. Data success is the existing canonical domain DTO. Native bearer never goes to data routes, workers, retained payloads or logs. Florida data uses no serviceSecret. No fallback to legacy Bearer/actor-plus-secret exists in delegated mode.

## Signed data envelope

The exact closed envelope fields are:

```ts
{
  schemaVersion: 1,
  purpose: 'capiro-retained-read-principal',
  algorithm: 'Ed25519',
  keyId, issuer, audienceOrigin, recipientPath, operation,
  principal: {tenantId, actorId, clerkUserId},
  identityRevision: hex64,
  resourceRevision: hex64,
  rawRequestSha256: hex64,
  normalizedArgsSha256: hex64,
  normalizationContextSha256: hex64,
  currentAuthority: boundedOpaqueCoreOnlyJSONString,
  issuedAtMs,
  originalExpiresAtMs,
  signature: base64url64Bytes
}
```

resourceRevision is required at top level and is computed by the same current producer vector as the fixed current-authority receipt. CONTROL compares it directly with its pinned receipt; it does not parse opaque currentAuthority. Digests bind the actual parsed raw request, normalized arguments and full accepted context using JCS (`canonicalize`), not caller-supplied hash echoes.

Sign exact UTF-8 bytes `capiro-retained-read-principal-v1\n` followed by JCS of the unsigned envelope; the namespace terminator is one actual newline. Header is exactly `Authorization: CapiroRetained <base64url(UTF8(JCS(fullEnvelope)))>`. Decoded envelope is at most 8192 bytes. Algorithm, key, issuer, exact recipient path and origin are trusted constructor pins; no Host/body/env/download fallback or algorithm negotiation. originalExpiresAtMs is bounded by original native evidence, original CONTROL task/request/fence cutoff, operation deadline and issuedAtMs+30000, and cannot renew.

Cryptographic verification alone is insufficient. Mandatory `verifyCurrent({assertionJson,operation,request,context,signal,deadlineMs})` returns closed `{principal:{tenantId,actorId,clerkUserId},identityRevision,resourceRevision,checkedAtMs,originalExpiresAtMs}` after fresh canonical session/current native user/member/impersonation and resource checks. The verifier must refuse changed, revoked, expired, foreign, drifted or unavailable authority. Core-only currentAuthority contains bounded verified provenance facts, no JWT/bearer; Core validates it only after the pinned signature and request binding. CONTROL retains its original task cutoff even if a new Core observation has a later individual expiry.

## Separate Florida authority-only bootstrap

Core must obtain genuine Intel current resource facts before issuing a resource-bound Florida data envelope. A distinct fixed authority-only purpose and recipient `/intel-api/internal/legiwatch/retained-florida-authority`, with the fixed Florida selector body, is reserved for that source plumbing. It returns authority facts only, never budget DTOs. It cannot use a dummy resourceRevision or the data-purpose envelope. Data guards reject this purpose. Fresh native-principal corroboration is mandatory; a signature alone, actor plus serviceSecret, echoed metadata or forwarded native bearer is insufficient. Exact private probe codec/composition is independently reviewed before adoption; it remains unavailable by default and does not change the agreed Meri envelope or public operation response.

## Validation and outstanding activation

The private current-resource source batch has a scoped independent source review. Membership PR33 has a separate exact 71/71 synthetic proof; it does not qualify these new resource/delegation files. New focused source and negative checks are being prepared. Broad build/type/native/startup/retained integrated checks remain unrun. No source-only receipt means deployment, live resource access, key creation or route activation.
