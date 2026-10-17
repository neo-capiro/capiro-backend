# Core first-chat GET source qualification supplement

This docs-only supplement is stacked on draft Core PR #62, exact source
`4e6c84ec64613ac2f0e9ccd275869833b6fbfd8d` (tree
`a5d2b40ff25ed4c4bc023da3d786658ab08c05e3`). It corrects the earlier
source packet's provisional CDK gate. It does not change the Core app, CDK
construct, runtime image, AWS, Meri or frontend source.

## Completed source qualification

- A frozen, script-free install of the existing pnpm lock's exact
  `aws-cdk-lib` **2.271.0** completed in the task-owned PR #62 checkout.
  Focused `preview-first-chat-core.spec.ts` construct tests passed **2/2**,
  and `infra/cdk` TypeScript typecheck exited **0**.
- An independent exact-pinned synthesis compared PR #62 with retained Core
  preview source `8ea7acc85793402984a59a308100d64b88b5876b` using the
  locked CDK version. The [complete normalized comparison receipt](coordination/evidence/core-first-chat-get-pr62-pinned-comparison.json)
  is 2,377 bytes, SHA-256
  `2febd452b423b647d050970db67810326454ad359a69294431222ca79ba7c242`.
  It records only the same retained host-only JSON guard priority **3→4** and
  one added priority-3, host/method/three-anchored-path Core GET forward.
  All previous service-stack resources and outputs, including the ECS service
  `DesiredCount: 0` and `DependsOn`, compared equal. The receipt is a source
  template comparison, not an AWS change set.
- A subsequent read-only AWS inventory reported the deployed retained
  priority-3 guard, vacant priority 4, broad production `/api/*` rule at
  priority 10, and preview Core desired/running/pending **0/0/0** with no
  target registered. This is a historical readback; repeat it at action time.
  No guard move, GET forward, service scale-up or CloudFormation change set
  was executed by this source qualification.

## Still held

The Core API image remains PR #48 source
`6542f5b089656b6d255465edd464d06c2a0b408f`, immutable digest
`sha256:722a483259ebb5e9162b9294c26895bafa890fcfee45dc927ff1d2ec35fa071b`.
The proposed GET paths are `GET /api/me`, `GET /api/clients`, and
`GET /api/clients/:uuid`. Meri conversation history is served by Meri; the
Core native identity/context/membership routes are POST. The existing Core
ordinary GET middleware can write user/membership/last-seen/audit state,
permits same-tenant archived detail and does not perform the native POST
route's online session check. The [selected-client review](core-preview-pr48-selected-client-get-binding-review-20261017.md)
records these semantics; source qualification did not decide their public
acceptance.

Before any activation, the owner must freshly verify listener rules,
priority-4 vacancy, physical retained guard ARN, service/image/target, issuer
and same-application Clerk key pairing, current native member/client/session,
the ordinary GET authority decision, and the separate Meri admission route.
Guard-stack and service-stack change sets, exact security approval and a
coordinated rollback remain unexecuted. A desired-one service check is a
separate live operation. The [PR #62 routing packet](core-first-chat-get-routing-packet-20261017.md)
gives the guarded ordering and rollback, but its original pinned-CDK pending
sentence is superseded by the completed source qualification above.

The first-chat frontend PR #70 image build later failed its architecture size
gate before Docker push, so it yielded no PR70 ECR image. A source-only
successor review is separate; this Core supplement does not claim a frontend
image or deployment. Meri Temporal issuer draft PR #130 is also source-only,
unmounted and native-PG unrun; Fable owns its continuation. The historical
Core handoff reported a `$335/$400` reservation; a later coordination message
reported `$339/$400` reserved. Neither is a fresh bill or current budget
readback. No new paid run is authorized here.
