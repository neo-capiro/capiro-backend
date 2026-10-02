# Reply-only coverage repair handover

Candidate `bae902c734eea220b4c6299423119e7bdaac2f6b` on `codex/meri-reply-only-coverage-20261002` is clean and locally qualified. Base is `9071035830bb557cad917df4022daa605bb2b99e`. This lane performed no main merge, push, AWS or browser action.

The source helper excludes only a recognized response-format `only` token from the negative/exhaustive classifier. It preserves the following text and every other quantifier, so `Reply only: No awards exist` and `List all awards, reply only in JSON` still require coverage. Other claim categories and disclosure logic are unchanged. Unknown format wording remains conservative.

Changed files: `packages/meriv2-core/src/assurance/evidence-plan.ts`, new adjacent `evidence-plan.spec.ts`, new `apps/meriv2-orchestrator/src/meri/retrieval/meri-evidence-formatting.spec.ts`. Production delta is 21 lines; total three-file delta is 154 insertions/1 deletion, including 43 new cases.

Actual checks all exit 0: core assurance 12 suites/271 tests; orchestrator coverage 2 suites/34 tests, including the real plan→requirements→comparison→disclosure flow; shared and core TypeScript builds; full orchestrator typecheck including the new spec; scoped Prettier; git diff --check. Initial shared compiler lookup was unavailable in that package; attempt 1 was preserved, then the build passed using the existing core TypeScript executable without an install.

Actual Hermes/Qwen implementation session `20261002_041334_84754c` ended exit 1 with an invalid/incomplete patch. That exact attempt is preserved; Codex repaired it under the explicit user exception. Actual independent Bedrock Kimi session `20261002_042613_ca9e61` reviewed frozen inline source and returned PASS with actual process/result exit 0, zero tools, and 15,759 reported tokens. Hash/test verification belongs to the launcher/Codex readback. Its earlier tool-enabled budget-exit-1 review is preserved without a green claim.

Root owns the final deterministic Promptfoo/custom matrix, integration, release and post-release live QA. This qualification proves the narrow source repair, not all File01 acceptance. Receipts/hashes/process exits are in `reply-only-qualification.json` and adjacent files.
