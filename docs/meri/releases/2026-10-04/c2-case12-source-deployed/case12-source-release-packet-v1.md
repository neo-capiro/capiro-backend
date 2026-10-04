# Case12 exact images and temporary IAM change

Both immutable CodeBuild candidates passed source and packaged qualification. Source is merged in [PR1945](https://github.com/neo-capiro/capirov2/pull/1945). [Versioned evidence](https://github.com/neo-capiro/capirov2/blob/181fee276134b7983b937583842a456d8abfd56b/docs/meri/releases/2026-10-04/c2-case12-source-release/README.md) includes exact build logs, source/release reviews, a fresh read-only schema proof and the healthy rollback baseline.

Packet fingerprint: `781b944fee40f504c744dda2f609f0f63446b9693dd2cdb661ecde756f749fc2`. Prepared 2026-10-04T13:29:15.855Z; snapshot expires 2026-10-04T14:29:15.856Z.

| Service | Candidate digest | Rollback digest |
| --- | --- | --- |
| api | `sha256:202832655633f906dec412ca088a7263e8e8065cd9a602402d98e5d2b092fe22` | `sha256:00e8c5cac10d8b4cd3cc46a0a9a7602b51db4657e38fabe86f1f12999d2b2e31` |
| meriv2-orchestrator | `sha256:33ecf4fcaf2f691999d14d410b5f43539c13070d44a1135d148c68f41eda3369` | `sha256:94c82ec438a0cfee0da3869af284e107ae6aeff6157c8c0ff2f97dc991f6c5bf` |

Both candidates use source `e60f37189f8c9b68ab7d5ef66e515ed3be4ec3c1`. API packaged Case12 probes passed; orchestrator tests passed 1,571 with two existing live tests skipped. Current schema 609, index and retired-table checks passed. The read task stopped and its owned definition is inactive.

Promote API first, then orchestrator, verifying each before proceeding. Preserve Web390, all service configuration, models, providers, flags, capacity, schema and schedules, nightly136 and the disabled broad worker. Immutable rollback images are listed above.

Separately apply inline policy `MeriCase12NativeSetupReads20261004` to `arn:aws:iam::967807252336:role/Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ`. Exact policy SHA256 is `173d4b8f134c2d1fac50b9df7d3db6e4e136f1e965c293a258cee6407da50d3a`; its permissions expire at 2026-10-04T21:00:00Z. It adds DescribeTasks for owner-tagged capiro-dev tasks and DescribeTaskDefinition across us-east-1. All consumers of this shared API task role receive the temporary reads. It adds no RunTask grant; an existing Senate RunTask grant remains. All 11 original inline policy hashes and the empty attached-policy set were rechecked.

Actual intended helper-credential access must pass before setup execution. Remove this named policy after terminal reconciliation, or before expiry if no helper can proceed, then verify the original policy set. Expiration denies the new permissions but does not delete the policy object.

This packet contains no spend reservation, provider call, fixture reset, capture or journal mutation. Live setup/capture and human grading remain separately qualified work. The 26-event journal remains $16.200909 committed and $13.799091 available; prior failures and consumed claims remain unchanged. C2 is unfinished.

[Full packet](case12-source-release-packet-v1.json). The [repository release rule](https://github.com/neo-capiro/capirov2/blob/181fee276134b7983b937583842a456d8abfd56b/docs/meri/deployment-prerequisite.md#qualification-evidence-and-migration-rules) requires an explicit human-reviewed attestation. This is a new image pair and a separately scoped IAM change.
