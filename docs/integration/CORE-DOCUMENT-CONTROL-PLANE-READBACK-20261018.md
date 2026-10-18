# Retained document control-plane readback source

`EcsControlPlaneDocumentReadback` implements the independent readback port
already required by `EcsRetainedDocumentRuntimeIdentityReader`. It remains
**unregistered**. The mounted document receiver still returns 503 by default.

For each call, the source performs ECS `DescribeTasks` for the exact metadata
selected task in the exact `capiro-dev` cluster. It requires the running
`capiro-preview-first-chat-core` service task and the selected `core` Docker
runtime ID. The link-local selector accepts Fargate's documented 32 hex plus
10 decimal `DockerId` shape, and the ECS control-plane `runtimeId` must equal
it ([AWS metadata reference](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-metadata-endpoint-v4-response.html),
[ECS container API](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_Container.html)).
It then calls `DescribeTaskDefinition` for that task's ARN and
requires a `capiro/preview-core@sha256:<digest>` image reference whose digest
equals the running container's ECS `imageDigest`. It never treats a tag,
`RELEASE_SHA`, an OCI label, a request header or metadata `ImageID` as proof.
After collecting the other evidence, it describes the same task again to
reject a stopped task or changed digest during readback.

The source also requires two **separate current evidence ports**:

1. `QualifiedCoreImageProvenancePort` must read a reviewed immutable
   image-to-source build record keyed by that ECS digest and return the exact
   source commit. No qualifying record source is presently implemented.
2. `CurrentCoreEffectiveConfigurationPort` must independently measure the
   current effective configuration for the exact task/definition/digest,
   including separately governed feature/config inputs. No measurement
   definition or provider is presently implemented. Task environment alone
   does not satisfy this contract. A later provider must use immutable or
   versioned snapshots of those inputs so a change-and-revert between the
   existing before/after checks cannot masquerade as continuous agreement.

Both observations have exact result shapes and must match the live task and
digest. The existing outer reader has a five-second deadline and compares
this evidence to the original locked ADMITTED document allocation before and
after the canonical owner read.

## Operator bindings before registration

- Qualify and deploy an immutable Core image; record its build-source linkage,
  signed/approved provenance, actual ECR digest and selected ECS task
  definition. Source archive and local build evidence are not a running image.
- Independently define and measure the effective-config hash and bind it to
  the current task and image. Verify its match to Meri's original locked
  text-only allocation rather than changing that allocation.
- Review a deployment-owned control-plane access path for ECS `DescribeTasks`
  and `DescribeTaskDefinition` and for both evidence sources. The current
  preview Core task role grants bounded `kms:Sign`, not ECS Describe. This
  source adds **no** IAM permission, credential, secret or Nest provider.
- Verify the running task, role access, image, Meri relay, allocation and
  source/config readbacks before registering both the ECS reader and this
  port. If any access or evidence is missing, retain the default 503.

Focused unit tests cover the happy path, wrong/stopped/ambiguous tasks,
mutable/mismatched images, missing or mismatched provenance/config, a task
that stops during observation and the exact read-only SDK commands. They do
not assert runtime role access or deployment readiness. No live AWS call,
SQL, grant, paid build or receiver activation occurred.
