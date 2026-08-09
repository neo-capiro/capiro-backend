# Outreach V3 Context Security Runbook

## Runtime posture

Phase 5 context endpoints exist only in the existing `engagement-api` runtime and are dark by default.

Required gates:

```text
OUTREACH_V3_STATE_ENABLED=true
OUTREACH_V3_CONTEXT_ENABLED=true
```

An unset/false context flag returns 404. Phase 5 does not authorize enabling these flags in production.

## Tenant and owner scope

All Outreach session access remains authenticated, tenant-scoped, and owner-scoped through the Phase 2/3 state substrate.

Do not accept tenant/user authority from tool arguments or browser DTOs.

## Client context rule

Client-confidential context may be discovered/accepted only when the Campaign Spec has one explicit client sponsor matching that client.

`clientId=null` means tenant-neutral content only. It never means “any client I can technically read.”

Wrong sponsor, wrong tenant, ethical-wall denial, inaccessible private meeting, and missing resource should degrade to the same nonleaking not-found family where practical.

## Memory

Before using memory:

- verify tenant;
- enforce owner-private visibility;
- reject revoked/rejected/withdrawn/expired rows;
- enforce ethical-wall grants;
- keep `instructions_allowed` separate from factual evidence authority;
- preserve verification and sensitivity metadata.

Do not expose hidden/excluded memory identifiers as part of a denial.

## Documents

Never expose raw S3 credentials or unrestricted file bytes through Phase 5 context tools.

For meeting-linked attachments, re-check meeting visibility. A private meeting attachment must remain unavailable to another tenant member even when the attachment row itself is tenant-scoped.

Unapproved documents may be inspected as bounded candidates but must carry `usableAsEvidence=false` where policy requires it.

## Target-specific context

Target-specific context must reference an exact selected target key.

Removing a target removes its accepted target-specific context from canonical state.

Never promote a target-profile fact into group-safe context.

## Multi-client campaigns

Phase 5 intentionally does not combine confidential facts from multiple sponsor clients into one shared context packet.

Multi-client/coalition campaigns may use tenant-neutral public/shared context only until later generation phases create per-client isolation semantics.

## Reasoning boundary

Reasoning receives read tools only. It may create pending command proposals. It may not invoke the command engine, Apply a proposal, generate drafts, approve, preflight, or send.

Accepted context proposals must be grounded in exact tool-returned selections. Exclusions must reference either current Campaign Spec context or exact referenced tool evidence.

## Logging

Do not log:

- memory bodies;
- client context bodies;
- private meeting descriptions unnecessarily;
- private notes/transcripts/email bodies;
- raw document content;
- Campaign Spec context payloads;
- provider/tool error bodies that may contain content.

Use IDs/hashes/counts/classification/result codes/timing.

## Incident checks

For suspected context leakage:

1. disable `OUTREACH_V3_CONTEXT_ENABLED`;
2. preserve exact release SHA and audit/event records;
3. identify context locator/class/scope and campaign sponsor at the affected state version;
4. verify tenant/client/ethical-wall and meeting-visibility checks;
5. verify the reasoning turn’s referenced tool-result IDs;
6. do not mutate immutable Campaign Spec history to hide the event;
7. repair the authorization boundary and add a regression case;
8. include the finding in the combined Phase 4-6 validation ledger.

## Production activation

No production activation is authorized by Phase 5 completion. Activation requires the later rollout/cutover plan and explicit owner approval.
