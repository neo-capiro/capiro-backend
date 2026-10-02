# Reply-format coverage repair qualification

The candidate is qualified for the Meri orchestrator only. This record does not
claim that deployment or the full original live evaluation has completed.

- Source: `bae902c734eea220b4c6299423119e7bdaac2f6b`, merged in PR1928 after
  C-drive local main integration, then GitHub main publication.
- Immutable image: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/meriv2-orchestrator@sha256:94f49d77dd2770b4da93a1f1d8f7b112e7f4533c2c860be5eb42f1bbdddb095b`.
- CodeBuild: `capiro-build-web-dev:98fcfd2b-fc5e-4ca0-962c-32b9af96933f`, SUCCEEDED.
  Native ARM64, exact canonical GitHub source and resolved revision. The executed
  buildspec hash is `dd3aaac45be1eada1a2451add262b6407313d699b390deb0c0707455c370af90`.
- Independent readback at 04:39:23 UTC checked actual executed test markers,
  immutable ECR digest, source tag, build environment, recipe and packaged runtime.
  See `orchestrator-repair-independent-20261002T043923Z.json`.

## Validation and compatibility

The native build passed 125 orchestrator suites: 1,405 tests passed, zero failed
and two live tests skipped. Those two tests remain NOT RUN. The exact final image
passed its real packaged-entrypoint health and unauthenticated API rejection
checks with its network disabled. The build asserts its OCI revision label,
ARM64 architecture, Node version and local RepoDigest/ECR agreement before
publication.

Local qualification on the exact candidate passed 271 core assurance tests and
34 orchestrator coverage tests, including the original failing prompt and factual
requests that must still produce coverage warnings. Shared/core compilation,
orchestrator typecheck and formatting passed. Independent actual Hermes/Bedrock
Kimi review exited zero and found no blocking issue; it reviewed supplied exact
source and observed test evidence, and did not independently execute tests.
The failed Qwen implementation and first budget-exhausted review were not accepted.

The final deterministic Promptfoo evaluation passed 26/26, with its custom Python
verifier exiting zero, zero errors and zero provider model tokens. The full report
and source/input hash verification are in `offline/`. The earlier 53 Python,
40 runtime and 186 harness tests passed on the pre-repair baseline; they are
separately recorded in `original-eval/`, not relabeled as final-candidate tests.

Comparison with the currently served orchestrator source
`39cea28f31be07def2f67ddf06ac4c44ef4ab792` shows only the production helper change
and its two new test files across orchestrator/core/shared/auth/strategy/schema
and lockfile inputs. No schema, migration, retired persistence contract,
dependency, provider, routing, permission or flag change is included. The helper
removes only the quantifier in recognized response-format directives and retains
their payload, other quantifiers, other categories and unknown phrasing. Existing
disclosure and source-coverage enforcement remain active. This evidence supports
the candidate-bound retirement compatibility check; no database migration is needed.

## Release path and acceptance boundary

The exact image workflow dispatch
[36964895982](https://github.com/neo-capiro/capirov2/actions/runs/36964895982)
failed at startup with zero jobs on this source. The previously authorized AWS
fallback therefore used the existing native CodeBuild project and reviewed recipe;
no code-check failure was bypassed. The release operator must take a fresh baseline
of orchestrator revision87, preserve the existing two synthetic cohort additions
and all other configuration, and use its exact guarded promotion/rollback receipt.

After rollout, use the reviewed V7 Playwright operator for exactly one original
strict smoke turn per approved ordinary synthetic actor on `https://os.capiro.ai`.
It requires current independent source/digest/task/deployment/health readback and
retains the older database flag proof explicitly as historical. It checks actual
authentication/composer availability before sending and revokes each new session.
No live smoke has executed as of this qualification record.

The original 75 live cases, CD, CW and applicable memory contracts are separate.
Their fixture/capture work is incomplete and no original live case is claimed
passed. `original-eval/original-live-readiness-907103583.md` records the concrete
implementation gaps; parallel fixture work is outside this image.

Shared policy: `39590a3bfc57ce03b0411ff7912a7c8d99deb70c`; machine map dated
2026-09-30. Audit copies normalize text to LF; `artifact-copy-index.json` records
both original local and repository-copy hashes. These historical operators and
receipts are task evidence, not standing authorization to replay mutations.
