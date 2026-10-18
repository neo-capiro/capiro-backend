# Core retained document runtime identity adapter

This branch adds `EcsRetainedDocumentRuntimeIdentityReader` as source preparation
for the existing `RetainedDocumentRuntimeIdentityReader` seam. It is **not
registered in `MeriModule`**. The document receiver still returns 503 before
reading attachment metadata or bytes when no reader is installed.

On each `readCurrent()` call, the adapter reads the ECS v4 link-local container
and task metadata endpoints. The ECS-injected URI is accepted only as a locator
under `169.254.170.2/v4/`; no environment value supplies a source, image, or
configuration pin. The adapter checks this is the running `core` container of
the `capiro-preview-first-chat-core` task family in the exact `capiro-dev`
cluster, and uses task ARN, task-definition ARN and Docker ID as a selector.
The metadata response is streamed with a 1 MiB cap and no redirects.

A separate, deployment-owned `TrustedCoreDeploymentReadbackPort` must observe
that same current task and container on **every** call. Its result must match
the selector and provide:

- Immutable image manifest digest read back for the selected running container.
- Source commit from the reviewed immutable image-to-source build record for
  that exact digest, rather than `RELEASE_SHA`, OCI labels, image tags or task
  environment.
- SHA-256 of the documented **current effective configuration**, including
  the selected task definition and any separately governed feature inputs.

The adapter enforces an independent-readback deadline and exact result shape.
The existing receiver compares its output to the original locked ADMITTED
document allocation before and after the canonical owner read. It does not
change admission, the signed request, task credential, tariff, or provider-free
extraction rule.

**Runtime dependency:** there is no implementation or registered provider for
`TrustedCoreDeploymentReadbackPort`. The preview Core task role currently has
only its bounded KMS signing permission, not an ECS control-plane describe
permission. A shipping owner must review the actual readback implementation,
its role access, image provenance and effective-config hashing procedure,
then qualify the running task and allocation pins before registering it.
Source compilation and test doubles do not establish that runtime evidence.
No new credential, grant, AWS call, live SQL, or deployment is in this branch.

Focused tests cover current selector matching, each readback pin, malformed
locators, stopped or ambiguous tasks, missing port evidence, metadata size,
and a noncooperative port timeout. The existing document receiver tests still
confirm its missing-reader 503 and before/after qualification behavior.
