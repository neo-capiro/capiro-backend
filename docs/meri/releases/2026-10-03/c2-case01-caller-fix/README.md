# Native read collector configured CLI repair

The case01 build reader, also used by controlled reads and case46, now accepts the configured `capirocli` IAM user alongside the existing `hermes-cli` user in the exact account. Native STS remains the only identity source and the returned proof includes the observed caller. Immutable source/build/recipe/ECR/ECS/ALB checks are byte-identical outside this guard.

The same tests reproduce rejection by the old guard (54 pass, 1 fail), then pass55/55 after repair. [Checkpoint](checkpoint.json), [red](red.receipt.json), [green](green.receipt.json). Codex root reviewed the exact two-file diff and rejection tests independently of the implementer. Source hashes match the checkpoint; formatting and diff checks passed. No native remote read, provider call, fixture operation, deployment or original acceptance is claimed by these tests. The actual configured principal was independently observed during the [case17 current-image work](../c2-case17-caller-fix/README.md).

Clock and memory source files were unchanged by this eval-only repair. [Artifact hashes](artifacts.json).
