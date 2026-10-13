# Preview backend source handoff — 2026-10-13

This is a concrete, independently reviewed **source-only** proposal for Core, Workspace and Intelligence behind the existing preview ALB. Frozen source: `42d6705b02af712f729150f51f11665290d696c7`, tree `9d56d0854b07ae1bd42a52ffcf992ddab75dccb4`. Receiving base: [PR2477](https://github.com/neo-capiro/capirov2/pull/2477), `b9da0ae2938821e08a3bfea563c6267608ae9909`, tree `91436b73ebff4c9807c5c877093e8502430a50c9`. The independent review commit is `a3f7d612933181c0af9969443c1516d361d22c91`; later packet commits do not change the ten infra source paths.

All three proposed ECS services have desired count zero. No AWS operation, deployment, schema execution, credential retrieval, provider call, customer mutation or main merge occurred in this slice. Rendered templates contain synthetic identifiers and must never be deployed. Production and existing frontend source are unchanged.

## Contract and topology

The dedicated local `infra/cdk/bin/preview-backends.ts --render` command requires a closed, explicit public metadata record and a fresh output path. It does not load ambient resource defaults or credentials. Missing/extra fields, production Clerk namespace, mutable/wrong-owner image, incorrect account/service, overlapping Neo/automation identities and legacy Meri URL input are refused. These checks establish shape; an operator must verify real resource ownership, identity and relationships before activation. Parent-directory symlinks and concurrent hostile filesystem replacement were not qualified.

The proposal imports the existing `capiro-portfolio-preview` VPC/cluster/HTTPS listener/frontend target and reuses `portfolio-preview.app.capiro.ai` and its certificate. It adds two isolated database subnets, separate backend/database security groups, a new canonical DataStack database/key/secrets, a new canonical AssetsStack bucket/key and three held service definitions. Database ingress is only from the proposed backend group. Core and Workspace currently have bucket-wide read/write/delete grants on the **new preview bucket**; independent review explicitly holds least-privilege acceptance. The proposal contains no connection to the old Capiro database, bucket, queue or Meri orchestrator. Reusing the existing hostname avoids another DNS record/certificate/ALB; exact listener priority and frontend proxy behavior still require acceptance.

| Priority | Preview host path | Proposed owner |
| --- | --- | --- |
| 608 | `/strategy-api/*`, `/onboard-api/*`, `/meri-api/*`, `/api/meri/*` | Fixed JSON HTTP503 |
| 609 | `/api/capiro/*`, `/api/backend/*`, `/api/action-followthrough/*`, `/api/documents/*`, `/api/conversations/*` | Existing frontend target |
| 610 | `/api/*` | Core4000; health `/api/health` |
| 611 | `/workspace-api/*` | Workspace4200; health `/health` |
| 612 | `/intel-api/*` | Intelligence4300; health `/health` |

New DataStack app-secret fields supply DB_USER/DB_PASSWORD. DB_HOST/PORT/NAME refer to the new cluster; DATABASE_URL is explicitly empty to clear an image override. The selected images must independently demonstrate their `serve` entrypoint composes that URL and starts healthy. Empty DATABASE_URL alone does not prove absence of every image-baked fallback. Explicit preview ASSETS_BUCKET/DIRECTORY_S3_BUCKET close the known bucket defaults. No provider secret, worker, consumer, model, schedule or Greenfield task is introduced. Existing canonical database-role/schema bootstrap and reviewed migrations are still missing and were not executed.

## Verification and preserved failures

At the same frozen source, [four source test groups](evidence/source-tests-receipt.json) passed in3.200s, including twenty malformed binding cases, held-resource/routing assertions and CLI/output-symlink checks. The full strict [infra typecheck](evidence/type-receipt.json) passed in6.731s. The actual dedicated [local synthetic render](evidence/render-receipt.json) passed in2.806s. Four templates and a complete output inventory are retained. W3010 warnings concern explicit synthetic AZ values; no live CloudFormation validation occurred. [Independent review](INDEPENDENT-BACKEND-REVIEW.md) parsed the retained templates rather than repeating checks.

The initial cross-stack grant cycle, subsequent stale owned-output fixture and initial CLI type error remain in the evidence directory. The first failing render's full uncommitted source snapshot was not saved; its correction receipt states that limit. Owned render/type outputs and borrowed-cache symlinks were retired; caches themselves were preserved. No synthetic/CDK/type evidence is native Postgres/RLS, live Clerk/session trust, real image ABI or deployment acceptance.

## Single receiving dependency and overlap matrix

| Slice / owner | Exact publication or source | Relationship / remaining gate |
| --- | --- | --- |
| Workspace native qualification | [PR2475](https://github.com/neo-capiro/capirov2/pull/2475): `6074d8a59d1fb5bc10bf9ccfbcb338bff68932e8`, tree `2e8ad33ead6aa40df1af191603831fa8363d81bc` | Ancestor;19/19 native groups. Initial post-drop preservation assertion failed without captured mismatch values; cause remains unresolved despite final matching recovery snapshots. Do not call cleanup unconditionally closed. |
| Intelligence receiving composition | [PR2477](https://github.com/neo-capiro/capirov2/pull/2477): `b9da0ae2938821e08a3bfea563c6267608ae9909`, tree `91436b73ebff4c9807c5c877093e8502430a50c9` | Direct base. Broad920-case/type/Nest checks pinned to raw composition; single SQL-space successor separately qualified with46 focused cases. |
| Remaining Intelligence extraction | [PR2476](https://github.com/neo-capiro/capirov2/pull/2476): `3d76ab21c1dcf9020b050988b315d11ab986a5d9`, tree `f7e48ceed36871f7b32d41835c6fd5d70f6091d2` | Preserved, queued for separate receiving composition. Not incorporated into this source or asserted as lost. Future admitted image source needs an explicit reviewed successor pin. |
| Frontend | Published `1da8a551b00bba0f98e87954ef0a87566db236e6`; existing template inspected at local `02c02d95bdf3949662b9123f425271c6491ffdab` | Namespace paths inform priority609. Existing template still defaults to os.capiro.ai and labels Clerk production. [Exact override proposal](FRONTEND-OVERRIDE-PROPOSAL.json) is a receiving-owner input, not an applied frontend fix. |
| Meri Greenfield | [Published audit9e2e197](https://github.com/neo-capiro/meri-greenfield/blob/9e2e197d1e0f11392e0284a77aea775393a3b23f/docs/coordination/reports/ORIGINAL-RUNTIME-DEPLOYMENT-CONTRACT-20261013.md); audited source `71d8c90c5a1fe5abc88b25fb74abba177949d3b1`, tree `1d2832f47c6b32295cf4dd6d8e837d27310bd468` | Separate infrastructure/runtime owner. Accepted HTTP/health/Temporal bootstrap image and coherent public0.1.4 freeze missing. [Boundary](GREENFIELD-BOUNDARY.md) preserves canonical conversation routing; no legacy target. |
| Backend repository split preparation | Separate prepared head `68ff5f6640e6d04b97ed1254ef69b7c0660bd8a7`, tree `47f92601304ed13c41fa73c24746134a93cf9cf4` | Documents only; destination404 means absent or inaccessible. No repo/remotes/CI/settings action. Final source authority awaits donor composition, this preview publication and independent quarantine review. |
| Protected Engagement reporting | Existing unpublished owner task `task01a12dc9-21a3-7062-908e-b6fabc37c027` | No branch or code-body inspection/change. Receiving preservation is mode/blob metadata only. |
| Objective, newsletter, effective-date and shared task owners | Existing receiving ancestors and candidate references retained | No API/product/schema paths changed here; no Quicklog commitment UI or abandoned semantics added. |

## Admission inputs

[Resource and cost proposal](RESOURCE-AND-COST-PROPOSAL.md) enumerates the missing bindings and modeled14-day budget. [REQUIRED-BINDINGS.json](REQUIRED-BINDINGS.json) deliberately contains nulls and cannot be rendered. Before any apply/activation: verify actual preview topology and free CIDRs/priorities, establish matching Test Clerk application/key/issuer and distinct Neo/automation authorities, publish scanned immutable images and demonstrate startup, approve source IAM/network scope and bootstrap/migrations, accept frontend proxy/strict CORS/session isolation, admit the separately owned Greenfield runtime and bounded costs. No credential values belong in this packet. Main remains unmerged; no deployment is authorized by this publication.
