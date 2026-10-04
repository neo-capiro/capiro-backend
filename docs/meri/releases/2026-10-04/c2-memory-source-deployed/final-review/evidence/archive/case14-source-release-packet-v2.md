# C2 memory source repair: exact release ready for review

Both immutable CodeBuild candidates passed source and packaged qualification. They repair canonical memory source ownership/receipt joins and internal-tool HTTP success status. Source is merged in [PR1941](https://github.com/neo-capiro/capirov2/pull/1941). [Versioned evidence](https://github.com/neo-capiro/capirov2/blob/e4217c653f197945f5e5b17faeb5a598d0818503/docs/meri/releases/2026-10-04/c2-memory-source-release/README.md) includes build logs, source/release reviews, read-only schema proof and the healthy rollback baseline. Production promotion is pending; C2 acceptance remains open.

Packet fingerprint: `1dba538b156ddbdac729dbc0c647d0d3c4b4f38bb3a583a8edc08ef6b0f2b5e2`. Prepared 2026-10-04T07:59:13.002Z; snapshot expires 2026-10-04T08:59:13.015Z.

| Service | Candidate digest | Rollback digest |
| --- | --- | --- |
| api | `sha256:00e8c5cac10d8b4cd3cc46a0a9a7602b51db4657e38fabe86f1f12999d2b2e31` | `sha256:024fcc82a2db7701f4a3e3311598a9a1d0933b3fe4fcf73751bf0e3fb866d8ce` |
| meriv2-orchestrator | `sha256:94c82ec438a0cfee0da3869af284e107ae6aeff6157c8c0ff2f97dc991f6c5bf` | `sha256:5329e61c0234a5baca60b4475e49a88adf4d15c78dc555fd4d46a94b01f74b1a` |

Both candidates use source `945179d44223882f9fe1da2fb4e41213bf5813c2`. Native core97 and orchestrator1570 tests across130 suites passed; two existing live tests remain skipped. API final-image request/source proof and HTTP status/guard probes passed. Both Hermes reviews and root checks are retained, including repaired failures. Current schema609/index/retired-table checks passed, and the read task stopped with its definition inactive.

Promote API, then orchestrator, verifying each before proceeding. Preserve Web390, all configuration/models/providers/flags/capacity/schema/schedules, nightly136 and the disabled broad worker. No new capture, model call, fixture reset/reapproval, budget admission or journal change is included. Prior failed captures remain failed; human benchmark grading is separate. The26-event journal remains $16.200909 committed/$13.799091 available, including $1 conservative approval cost.

Tenant-wide null-client memory and changed/shortened citation bytes remain outside accepted client-bound source evidence. The source repair does not close initial-context coverage, the answer's date issue, the original Case14 prompt/final recall UI or human grading.

[Full packet](case14-source-release-packet-v2.json). The [repository release rule](https://github.com/neo-capiro/capirov2/blob/e4217c653f197945f5e5b17faeb5a598d0818503/docs/meri/deployment-prerequisite.md#qualification-evidence-and-migration-rules) requires an explicit human-reviewed attestation. This is a new exact image pair; the previously approved three-image release is already complete.
