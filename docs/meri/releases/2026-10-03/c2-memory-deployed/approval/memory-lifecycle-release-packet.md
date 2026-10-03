# C2 memory release review

This packet is prepared and has not been deployed. Technical qualification and independent review passed.

Packet fingerprint: `98b400994ce4af4b7b0b01cd1d907b7d708172a3bce9608ffa158998af31ffcb`. Prepared 2026-10-03T15:57:35.774Z; expires 2026-10-03T16:55:55.907Z. [Versioned evidence](https://github.com/neo-capiro/capirov2/blob/75fb394938144b5a78c9e9c74165a5399d69d3f3/docs/meri/releases/2026-10-03/c2-memory-lifecycle/README.md).

| Target | Exact source | Image digest | Current rollback |
| --- | --- | --- | --- |
| api | `f00e5dfb4fd3e47ac6aa4aca741023cc02f6314f` | `sha256:1a4aef121151bb5da7f70417539ece2faff392842809e6b557370c2d6cf8a49d` | `sha256:5e52f9b06658b0462672d070928e0c2afd6ea229b61c3b887371f3f66196c316` |
| meriv2-orchestrator | `ed44f2c6cfdfda5150f75ab198a6e52d2377880f` | `sha256:53b06f768d8a26a8a5c6124f0f7bb55a0e2117fde050706360c6108c98887faa` | `sha256:a53bf1a432f212b8e43be903f766c52ec4a8307d5fce1cbec1bdfbf45196ddea` |

The existing nightly refresh uses the same proposed API image. Its schedule, command, roles, network, feature flags and secret references stay unchanged. No manual all-tenant refresh is proposed. The separate broad projection worker stays disabled.

The subsequent maintenance is limited to six original cleanup obligations and three metadata repairs in the existing synthetic fixture. The live preview passed and rolled back. Fresh identical-scope plans must pass before either operation commits; original approvals, memory content and historical evidence are preserved. No paid capture or new capture authority is included.

Application rollback uses the exact prior healthy images above and retains the existing additive mail indexes. Keep the guarded writer for unrelated application rollback; disable only the nightly rule if that writer fails. Do not restore retired projections.

[Complete operation sequence and hashes](memory-lifecycle-release-packet.json). The repository [release rule](https://github.com/neo-capiro/capirov2/blob/75fb394938144b5a78c9e9c74165a5399d69d3f3/docs/meri/deployment-prerequisite.md#qualification-evidence-and-migration-rules) requires an **explicit human-reviewed attestation** for these artifacts. Human approval is pending; no approval is inferred from passing automated tests.
