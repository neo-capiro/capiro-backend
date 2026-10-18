# Core memory task-bound receiving continuation — source only

Base: Core memory PR #88 `20fc9f5473e0b5f3a7d9057c4e0417b9701855d3`.
Compared with Meri PR #157 `ab83ee97e9cb88b4727291284da9e2485157c309`, including its `search_memory@0.2.0` client-knowledge adapter and `memory.list_own_proposals@0.2.0` proposal adapter. The exact shared-boundary request is [Meri PR #121 comment 6252043483](https://github.com/neo-capiro/meri-greenfield/pull/121#issuecomment-6252043483).

## Prepared Core source

- `admitPassiveMemoryPage` compares a middleware-owned, already consumed Option B tool grant with the exact `{input,metadata}` page, signed canonical correlation, original seven-field ADMITTED binding, normalized input hash, client subject/scope and selected-client grant. It refuses null/personal selection. This pure helper has no route, credential issuer or active call site.
- `readTaskBoundMemoryProposalPage` accepts only the exact normalized `{clientId,cursor,limit}` client selection and a middleware-owned grant for `memory.list_own_proposals@0.2.0`. It checks the selected client wall before and after the existing `readOwnPendingMemoryProposals` owner read, including an empty or continuation page, then checks the returned tenant/actor/client/page bounds. It does not replace that owner or infer personal authority. This pure producer is not mounted.
- The PR #88 passive eligibility parser and canonical current-row check remain unchanged. Its callback fields are correlations, not authorization. The ordinary raw `search_memory` and `list_memory_proposals` tool paths remain unchanged.

## Required shared receiving contract before a route can open

1. Meri must forward the trusted post-`UNKNOWN` invocation/call key, issue the exact signed parent `search_memory@0.2.0` page token and use the existing selected-client/native actor authority. Its PR #157 adapter currently asks only for an ordinary bearer and service secret. The Core page needs pre-byte Option B release recheck after canonical retrieval.
2. A centrally allocated additive Core schema and closed DTO must add a distinct one-use eligibility helper, tied to the **consumed** parent page token JTI and the same original UNKNOWN reservation. Bind the parent emitted-body hash, canonical page request/input hashes, exact result hash, helper emitted-body hash, original ADMITTED run/attempt/fence, actor/subject/client, policy and deadline. Reuse the snapshot lock, original grant set, consent/member/wall and release rechecks. Do not widen `READ_TOKEN_CEILINGS.tool = 1`, add eligibility to model discovery, or use a second ordinary tool token.
3. Meri must carry Core's short eligibility receipt expiry through authorization, retention and settlement; final dispatcher release must refuse at `now >= expiresAtMs`. A local adapter check cannot cover a later settlement.
4. Meri's proposal operation `memory.list_own_proposals@0.2.0` currently sends an ordinary bearer to `/api/clio/tools/list_memory_proposals`. The existing Option B token fixes the operation ID to its exact path and has no approved alias to that legacy Core name. The shared owner must define a signed, reservation-bound alias or an exact versioned source target, plus its output validator and continuation correlation. This branch does not change the shared token parser, ordinary allowlist, controller, listener or Meri files.
5. A separate reviewed authority is needed for personal passive recall. The current delegation selects one client; `clientId:null` may search a wider authorized roster and is refused here.

The Core `20281018090000_clio_meri_memory_submissions_content_free` migration still raises SQLSTATE `55000` unconditionally before any column drop. That release hold is intentional: every target's applied `020000` checksum and table shape, retention/suppression/holds and explicit data-disposition authorization are required. Plain Prisma migration deploy across this file cannot complete. This branch does not edit either migration or authorize live SQL.

## Verification and status

Focused Jest suites for the prepared source and prior passive source: 14/14. Scoped TypeScript on the three touched source/test files: zero diagnostics. These checks prove source behavior only. No memory page, eligibility or proposal continuation HTTP route was mounted; no service secret, bearer, grant, SQL, provider, AWS or deployment action was performed. Runtime source/image/config readback remains separate.
