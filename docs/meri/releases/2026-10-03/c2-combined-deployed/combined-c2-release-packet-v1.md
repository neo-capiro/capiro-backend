# C2 exact backup release ready for review

The three immutable CodeBuild images below repair Case17 recorded proposal provenance and Case20 controlled-source receipt qualification. Source is merged in [PR1937](https://github.com/neo-capiro/capirov2/pull/1937). [Versioned qualification](https://github.com/neo-capiro/capirov2/blob/a07ee9d1c0fafddfddb15e1458b8226b5f0a4d38/docs/meri/releases/2026-10-03/c2-combined-release/README.md) includes build logs, independent reviews, current schema and healthy rollback baseline. The service release is pending; C2 acceptance remains open.

Packet fingerprint: `8f246b44000e35548444642a31079c8b65f04aa3abf6fd0fcf6768864c3f9c7b`. Prepared 2026-10-04T03:24:21.134Z; snapshot expires 2026-10-04T04:24:21.142Z.

| Service | Candidate digest | Rollback digest |
| --- | --- | --- |
| api | `sha256:024fcc82a2db7701f4a3e3311598a9a1d0933b3fe4fcf73751bf0e3fb866d8ce` | `sha256:23f529da3c1c00d401968811575dc075bced6c60669baa9a09e9c23575c9c452` |
| meriv2-orchestrator | `sha256:5329e61c0234a5baca60b4475e49a88adf4d15c78dc555fd4d46a94b01f74b1a` | `sha256:1c491a5ac46ea320195fe8ab367322ad2ebbd0949d69530b5ccfba2de84eb491` |
| web-vnext | `sha256:fb594dabc437723fa6a28a7a6adcd54b13f813fcc52130f8458692aac2e9c8c6` | `sha256:a048aceec01c207b514f76fb447d4fb8bdb5ed17278642480008a1510a12de4c` |

All three candidates use source `c0f393f863bf73bd4e65e7a94e17c073e7be021e`. API packaged checks, 1568 orchestrator tests across130 suites (two existing skipped), and175 Web tests across11 files pass. The initial failed API harness and stale local build remain recorded; the corrected harness preserves assertions and passes on the actual candidate. Current ledger609/index hashes/retired-table checks pass.

Promote API, then orchestrator, then Web, verifying each before proceeding. Preserve all configuration, models, providers, flags, capacity, schema, nightly136 and disabled broad worker. No migration, cleanup replay, paid capture, budget installation or new admission is included. Case14 has a successful native plan only. The journal remains24 events, no active hold and $16.368942 capacity; consumed Case01/20 runs stay failed. Human benchmark grading remains separate.

[Full packet](combined-c2-release-packet-v1.json). The [repository release rule](https://github.com/neo-capiro/capirov2/blob/a07ee9d1c0fafddfddb15e1458b8226b5f0a4d38/docs/meri/deployment-prerequisite.md#qualification-evidence-and-migration-rules) states: “Qualification is an explicit **human-reviewed attestation**.” This packet is ready for that review; no human approval is fabricated from automated/Hermes checks.
