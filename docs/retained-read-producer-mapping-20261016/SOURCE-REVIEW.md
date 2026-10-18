# Retained read producer mapping source review

Prepared docs-only publication derivative for `docs/retained-read-producer-mapping-20261016/`. Publication and independent sanitation review are pending. This is source mapping, not adapter admission or runtime qualification.

The [v2 index](MAPPING-HANDOFF-v2.json) resolves all 63 ledger operations across 33 families exactly once to the four producer reports. Record pointers and context keys are preserved. The source authority remains backend commit `b525032222515d636b0dae2d46e40c7c3d8b5528`, tree `16723770a8e111fc66bcf70d36ff32ab71eb9928`, and ledger commit `fb708d231c7273f86b1462c72a72e70ccc36a3d6`, blob `1546e9566cb0719261ca660bd5402732f65146e7`. Source path/line and immutable blob references remain in the reports; no full source files or receiving copies are included.

Original immutable inputs were left untouched. This publication removes checkout/machine paths, a source thread identifier, an operational verification timestamp, external-checkout permission history and unrelated test-run links. It preserves receiving-contract limitations, source effects, authorization/feature/client-wall gaps, current-clock dependencies, default-unavailable behavior and unrun caveats. Generic CONTROL native bearer plus existing service-secret requirements remain requirements only; no credential values are included.

Only bill-text had literal receiving-schema comparison. Other families still need exact frozen receiving compatibility and separately allocated adapters/current-use authority. No ALL3 expansion, new route, key/origin/trust grant or model-supplied authority is authorized by these documents. Native bearer/service identity stays on CONTROL and does not reach workers. No tests, compiler, application, DB, provider/network calls, install, activation, source change, commit or publication occurred in this preparation.

## Original input provenance

| Original artifact | Original SHA-256 |
| --- | --- |
| `MISSING-READS.json` | `8319101141697febe5ea115f6376c02260da8516c1e23db037832386c401fd8c` |
| `federal-producers.json` | `19aa0a0a3daef6dfcab37541a08b6d9f3aeccadaaa016982e2495719a1b6806e` |
| `market-producers.json` | `0a4458bfaf3e277a5f5bdce2d0bb7619e6d1aad6d4c557e8cad8257a4671b6aa` |
| `state-research-producers.json` | `d294db825ee3e7c03a873489d091b69cab54bff6f7dec579b23d3fdcf2cd5b9f` |
| `scoped-producers.json` | `61fc978bc31d651372340b7c15ebde71317a06716ce79974a9afc7d213c10255` |
| `MAPPING-HANDOFF-v2.json` | `5a498e4cd2e06a118d54bae3e0caba44e9418c524b57f9d27481a51c37c2dad8` |
| `MAPPING-REVIEW.md` | `53c2504919ea0742ba6b83f584649393f5af4a98515c70cc21fd2db3c164c01a` |

## Sanitized publication bindings

The index binds the sanitized ledger and four producer report hashes. The sanitized review identifies its original source-only review and rebinds its table to these publication bytes. The inventory outside this docs directory records every transformation and all final hashes; no machine metadata or raw operational records need publication.

| Publication artifact | Sanitized SHA-256 |
| --- | --- |
| [MISSING-READS.json](MISSING-READS.json) | `8319101141697febe5ea115f6376c02260da8516c1e23db037832386c401fd8c` |
| [federal-producers.json](federal-producers.json) | `61e2dccc226548abe41ab6103c054fccb87f198386a601f19cbf1f1bc46b2ce5` |
| [market-producers.json](market-producers.json) | `ddb07f7fb31968a654a836713eacf0e53a3b259b2a0fb4a495a02783c1c416fb` |
| [state-research-producers.json](state-research-producers.json) | `f2e95feccffdf5d6107b3d9b372ce6e64eb93ff534bda4c1a416a4a8c2e024b6` |
| [scoped-producers.json](scoped-producers.json) | `2b929c4b8ebe3c06e43b31c8e8a13b4896876dc70e32a2a13208fcad02653cc5` |
| [MAPPING-HANDOFF-v2.json](MAPPING-HANDOFF-v2.json) | `c6ebaf2987015db466e88b9d4c550ab77878582ab7142ab256d298ae16ed0def` |
| [MAPPING-REVIEW.md](MAPPING-REVIEW.md) | `253284a9b57a397498b058c416ae156d8970d7c2115562b2b303b87c191d0611` |
