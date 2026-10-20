# Portfolio preview Core source candidate — 2026-10-18

This is source preparation for the existing `portfolio-preview.app.capiro.ai`
host. It does not create or change a live service. The Core image binding is the
reviewed backend PR96 commit
`784b1c3a91eb6d78f16d92c42e71f05c12c5b5bb`. Workspace and Intelligence
retain their separate held `e50aed3c5b5cce58317b37de442482fa970842cb`
source pins and all three service desired counts remain zero.

## Initial API surface

On the portfolio host, the Core target receives GET only for `/api/me`,
`/api/clients`, `/api/client-account-owners`,
`/api/client-account-owners/options`, and one
`/api/clients/{uuid}` detail path. The detail path is an anchored ALB regex for
a single UUID segment; it does not match `/api/clients/{uuid}/...`. Other
`/api` requests receive the host-specific 503 rule. Priority 608–609 Meri
holds, priority 610–611 frontend proxies, and priority 613–614 held
Workspace/Intelligence routes remain ahead of that 503 rule. The Core rules
still depend on the Core controller's Clerk verification, current member,
tenant and database authority. This first slice uses ordinary tenant-scoped
Core reads, not first-chat's host-specific native wall-visible roster.
The listener is GET-only, but Core's ordinary tenant middleware may provision
or rebind an application member and update `lastSeenAt` before these controller
reads. It is not a database-read-only task. The operator must review the
restricted role, migrations and expected membership side effects before
activation.

The source changes Core's target health path to the actual `/health` endpoint,
sets only the Core task to the approved 1024 CPU units / 2048 MiB, and gives
that API process the same explicit shadow/background/external-action-off
posture used in the first-chat template. It removes the false Directory bucket
mapping to the tenant assets bucket. Congressional Directory remains held
until its actual snapshot location and access are qualified; no Directory
permission is added here.

## Inputs before a deployment decision

1. The local PR96 tracked-only build input is
   `core-784b1c3a91eb6d78f16d92c42e71f05c12c5b5bb.zip`, SHA-256
   `949f9be825c85c75788975bc27761452025213af0dbdc671cf508dd76b3a3e82`.
   Its sibling manifest is SHA-256
   `e4dac262fb9699d7e7662b318b44e4aef988dd45a8d2e66e1994563fe2d47fc2`
   and records Git tree `93b41a8cb736a8276fcb32182c1e07e601e4b417`.
   The older `7b1bde0...` ZIP is not this Core image. The shipping operator
   still must verify the builder's actual inline recipe and image labels,
   record an S3 VersionId, ECR digest and scan, and bind that digest to PR96.
2. Read back the existing portfolio VPC, listener, frontend target and current
   priorities; check first-match routing for the GET rules and the 503 guard.
   The browser-facing same-host URL does not prove the frontend task can reach
   it as a server-side HTTPS upstream. Qualify its DNS, ingress and egress
   before enabling the frontend proxy's new target.
3. Supply the **existing, approved** preview Clerk webhook signing secret ARN
   in `clerkWebhookSecretArn`, check its account, KMS key and value presence via
   operator-controlled readback, and review the resulting ECS execution-role
   `GetSecretValue` grant before any stack apply. The binding contains no
   credential value and does not create a secret. A missing or mismatched ARN
   fails source validation; an unapproved secret or grant holds deployment.
4. Read back the target database's Prisma migration table and restricted app
   role. The account-owner read needs
   `20260816235000_add_client_account_owner`. No migration is run by this
   packet. The saved layout GET can update its stored order on catalog drift;
   it is deliberately excluded from this first pilot. The activity/timeline
   and Planner follow-up paths are outside the first GET-only slice.
5. Verify the effective ECS task environment, 1 vCPU / 2 GiB allocation,
   task and target health, image/source labels, tenant auth and 503 responses
   on POST, nested client GET, and held Meri paths. The source has not received
   a live readback.
6. This composition still requires immutable Workspace and Intelligence image
   URIs at the held `e50aed3...` source head even though those services have
   desired count zero. If those digests are absent, the bindings cannot render;
   a Core archive by itself is not a deployable stack input.

Do not activate Meri, retained reads, Directory snapshot access, background
Engagement actions, or Workspace/Intelligence through this candidate.
