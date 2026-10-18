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

**Runtime dependency:** a source-only implementation of
`TrustedCoreDeploymentReadbackPort` now validates service-filtered ECS
`ListTasks`, `DescribeTasks` and `DescribeTaskDefinition` results, including
the selected running container and immutable digest. See
[the control-plane source handoff](CORE-DOCUMENT-CONTROL-PLANE-READBACK-20261018.md).
It has no Nest provider. Its separate qualified-build and current-effective-
configuration evidence ports have no implementations, and the preview task
role has bounded KMS signing permission but no ECS List/Describe permission. A
shipping owner must bind those current readbacks and approved access, then
qualify the running task and allocation pins before registering it. Source
tests do not establish runtime evidence. No new credential, grant, AWS call,
live SQL or deployment is in this branch.

Focused tests cover current selector matching, each readback pin, malformed
locators, stopped or ambiguous tasks, missing port evidence, metadata size,
and a noncooperative port timeout. The existing document receiver tests still
confirm its missing-reader 503 and before/after qualification behavior.
