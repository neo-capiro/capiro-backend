# Package 3 operator runbook

## Runtime and publication boundary

- The API capability is deployed on ECS task definition `capiro-dev-api:445` from merge commit `f3c0bb74ba97541aba2676552a77539e97bd02d6` and immutable API image digest `sha256:99db81bbd38cfdd21c046f038c05d96a85b6fffe95da975e1aac63282e8bf6c6`.
- Deployment does not authorize a queue replay, drain, manifest creation, canonical write or snapshot activation. The registered drain task definition `:28` remains parked with a no-op default command.
- Keep congressional semantic production quarantined until both governed structured-table source inputs and exact persisted proof inputs are available and independently qualified.
- A generic component-wide book is not family-qualified evidence. Do not use it to infer complete procurement, O&M or MILCON coverage.
- The scoped-fact publication plan is read-only planning output. Rows are always labeled `reviewed_partial` and `partial`; executing or activating a canonical snapshot is outside this package.

## Artifact qualification

1. Bind the source document to its immutable identity and archived bytes. Record family, exhibit, fiscal year and source hash.
2. Route only RDT&E, procurement, O&M or MILCON to the corresponding family-specific semantic factory. Other families remain on the generic lineage path unless separately qualified.
3. For non-RDT&E artifacts, verify every selected parser run against the exact persisted parser artifact: recompute the run identity, locate the exact stored result, and read it through the verified store path. Missing or mismatched proof is a hard failure.
4. Persist the semantic artifact through the immutable artifact store and require the returned byte hash to equal the hash of the serialized bytes.
5. Compare qualification using the same `qualification_artifact_projection_v1` version. Record both the substantive projection hash and exact artifact-byte hash; they answer different questions.
6. Keep review, acceptance and publication decisions separate from successful parsing and artifact persistence.

## Scoped publication planning

1. Read the candidate cohort, active reviews and expected active snapshot without changing state.
2. Build the pure plan. It excludes missing, superseded, stale, ineligible or binding-mismatched candidates and projections.
3. Inspect rows and exclusions, confirming source and artifact bindings and the partial-coverage labels.
4. Store or share the plan only through the surrounding authorized evidence workflow. Do not treat plan construction as canonical publication or snapshot activation.

## Next manifest and rollback reference

The next bounded manifest may contain at most one exact source document, after read-only eligibility and format qualification confirm its immutable source/archive identity and readable bytes. Zero eligible sources is an acceptable result. No replay or drain is implied.

Pre-release rollback reference (account `967807252336`, `us-east-1`, cluster `capiro-dev`): API task definition `:444`, desired/running `2/2`, digest `sha256:11c97bae758709ea9becaa392e5b81e6805cc91395e1a813dad2833951bf6a7b`; drain `:27` parked with no service, digest `sha256:8ac22557…`; qualification `:33` used the same drain digest. Refresh live state before any rollback. A rollback changes only the API service task definition; it does not authorize running the drain or publishing canonical data.

Post-release reference: API `:445` is steady at desired/running/pending `2/2/0`, with both tasks and load-balancer targets healthy on digest `sha256:99db81bbd38cfdd21c046f038c05d96a85b6fffe95da975e1aac63282e8bf6c6`. Qualification `:34` completed two isolated runs with exit code zero and matching substantive hash `7cac359b01ae245d713f633345a2e0a9a3138b07ca62d3fa3762942205e71a0b`.
