# Core origin topology for frontend PR99 — 2026-10-18

This is a source handoff, based on the Core Portfolio template commit
`5cf5ca630cd4c237fd23019a101e5746c755a114`. No runtime, listener,
certificate, DNS, credential, grant, SQL, or frontend configuration was changed.
The receiving frontend contract is [PR99 at
`a8c2165f003d1d7bef0247e57fed925b78efcba5`](https://github.com/neo-capiro/capiro-frontend/commit/a8c2165f003d1d7bef0247e57fed925b78efcba5),
whose [source handoff](https://github.com/neo-capiro/capiro-frontend/blob/a8c2165f003d1d7bef0247e57fed925b78efcba5/docs/coordination/reports/CODEX-NON-MERI-CORE-PREVIEW-SLICE-20261018.md)
requires a separately qualified canonical HTTPS `/api` origin and native,
wall-visible Core GETs. The frontend owner owns PR99; the shipping owner owns
`apps/web/deployment/portfolio/service.yml` and the live frontend task.

## Why the existing Core template cannot serve that binding yet

* `infra/cdk/lib/preview/services-stack.ts` routes Core GETs on only
  `portfolio-preview.app.capiro.ai`; its Core task has
  `PREVIEW_NATIVE_GETS_ENABLED=false` and `CORE_DEPLOYMENT_PROFILE=standard`.
  This is the ordinary tenant path. It may provision/rebind application
  membership and update `lastSeenAt`, and its client roster is not the native
  ethical-wall-visible read promised by PR99.
* `apps/api/src/auth/preview-native-read-mode.ts` recognizes only
  `first-chat-preview.app-dev.capiro.ai` for the native path. With the flag on,
  any other Host receives `unavailable`. With it off, an unrecognized new Host
  receives the ordinary path. Adding a second ALB Host rule alone therefore
  cannot make PR99's native read available. Turning the flag on for the one
  current task would make the existing Portfolio-host GETs return 503.
* PR99's proposal rejects the Portfolio and first-chat hostnames as its new
  Core origin. Neither existing URL can be relabeled as the qualified target.
  PR99 currently pins backend source
  `784b1c3a91eb6d78f16d92c42e71f05c12c5b5bb`; a Core runtime change
  would require a new built, scanned image/source pin and a coordinated
  frontend source-marker update. The local PR96 ZIP is not such an image.
* `infra/cdk/lib/preview/bindings.ts` requires a Test Clerk
  `*.clerk.accounts.dev` issuer and preview secrets. The existing frontend
  `apps/web/deployment/portfolio/preview-config.mjs` pairs its current
  frontend task with `https://clerk.app.capiro.ai` and the dev Clerk app.
  The signed-in FE18 bearer cannot be assumed to authenticate to this Core
  template. The owner must decide and prove an isolated Clerk/tenant pairing;
  no production credential may be silently reused.
* The frontend-owned `service.yml` ALB accepts HTTPS from one approved browser
  `/32`; its frontend task has outbound 443, but its public-IP traffic is not
  automatically in that ingress allowlist. The existing listener's default
  action forwards to the frontend. A third Host therefore needs both network
  reachability proof and a Host-specific deny fallback, or it could hit the
  wrong target. No certificate SAN, DNS alias, priority inventory, or task
  reachability for a third Host has been read back here.

## Two bounded Core implementation choices after owner inputs

1. **Separate Core task/target.** Keep the existing 5cf5ca6 Core task and
   Portfolio-host GET behavior intact. A second, held Core service uses an
   exact third Host, native GET mode, its own target group and image pin.
   This is the clearest isolation but adds a task/resource commitment and
   requires its own capacity and credential review. The PR96 native code still
   needs an exact-host extension; it cannot serve the third Host as is.
2. **One task with explicit per-Host modes.** Extend Core native-read selection
   so the original Portfolio Host remains ordinary and only the owner-chosen
   third Host enters native read mode. The new Host must permit only
   `GET /api/me`, `GET /api/clients`, and a single-UUID client detail GET;
   the existing first-chat memory GET handlers and every other method/path
   must remain unavailable there, including from inside the VPC. Reject
   unmatched new-Host requests before the ordinary tenant middleware can
   provision a member or perform a write. This avoids a second task but
   couples both origins to one deployment and requires narrow
   middleware/controller tests.
   A generic Boolean flip or an arbitrary Host environment value is not an
   adequate authority boundary.

Either choice needs `apps/api/src/auth/preview-native-read-mode.ts`,
`apps/api/src/tenant/tenant-context.middleware.ts`, and
`apps/api/src/auth/preview-native-read.service.ts` to agree on the exact
Host/method/path policy. The controller's native client methods and
`ClientsService.listPreviewVisible/getPreviewVisible` already implement the
wall-visible roster and hidden-client 404 behavior; preserve them. The
operator's hostname and certificate decision determines whether
`infra/cdk/lib/preview/bindings.ts` and `services-stack.ts` can add only
Host-specific rules to the imported HTTPS listener or must model a separate
listener/ALB. On a shared listener, leave priorities 608–611, existing
Portfolio-host rules, and the frontend target unchanged; add only exact
new-Host native GET forwards and a later new-Host all-path 503 rule before
the listener's frontend default. Choose priorities from live readback, not a
guess. Reconcile the current CDK client-detail path regex (`[1-5]` UUID
version) with the frontend's accepted `[1-8]` UUID versions before claiming
that every otherwise valid selected client can pass the listener.

## Checks and release holds

Focused source checks belong in
`apps/api/src/auth/preview-native-read-mode.spec.ts`,
`apps/api/src/tenant/tenant-context.preview-native-read.http.spec.ts`,
`apps/api/src/clients/clients.preview-native-read.spec.ts`, and
`apps/api/src/users/users.preview-native-read.spec.ts`. Prove the old
Portfolio-host behavior, the exact new Host's native no-write/online session
and wall-visible roster, denied hidden client detail, and 503 for new-Host
memory/HEAD/POST/nearby routes at ingress; no such request may fall through
to ordinary membership work. Extend
`infra/cdk/test/preview-backends.spec.ts` for both Hosts, first-match
priorities, new-Host default denial, source/image pin, and held desired counts.

Before any activation, the operators must supply an exact hostname, ACM
certificate coverage on its HTTPS listener, DNS routing, frontend-task-to-ALB
TLS/ingress proof, current listener priority inventory, independent image
digest/source readback, compatible Clerk issuer/app/tenant and member proof,
and a real authorized roster/detail receipt. The frontend owner must reconcile
PR99's source marker and selected-client equivalence with Meri; the shipping
owner must update and validate `service.yml` without interrupting FE18.
These inputs are absent, so the third Core origin remains held.
