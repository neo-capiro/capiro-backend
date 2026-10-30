#!/usr/bin/env python3
"""Fail-closed source contract for separating the legacy MeriV2 image build
from promotion.

Native MeriV3 remains live; this does not retire its orchestrator and does not
prove an ECS deployment.

WHY IT NO LONGER READS .github/workflows
----------------------------------------
`meriv2-orchestrator-image.yml` and `deploy-all.yml` were removed by the inert
backend repository import (c76f5fc0) and no longer exist at the frozen source.
The same semantics are carried by the retained inputs:

  * scripts/meri-image-build.mjs      the only build path for
    BUILD_SERVICE=meriv2-orchestrator: exact source SHA, one exact-SHA tag, no
    ECS or deploy command, offline image smoke, digest readback. The historical
    "deploy-all must not dispatch the orchestrator directly" gate now maps to:
    the retired multi-service executor stays retired and promotion can only run
    through scripts/meri-release.mjs with a validated one-service qualification.
  * apps/meriv2-orchestrator/Dockerfile + scripts/entrypoint.sh
    the retained serve-only runtime contract (dumb-init -> entrypoint serve ->
    node dist/main.js, port 4300, no migration on start).

Run:  python3 scripts/validate-meri-orchestrator-build-only.py
Test: python3 scripts/validate-meri-orchestrator-build-only.py --self-test
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_OPERATOR = os.path.join(ROOT, "scripts", "meri-image-build.mjs")
DOCKERFILE = os.path.join(ROOT, "apps", "meriv2-orchestrator", "Dockerfile")
ENTRYPOINT = os.path.join(ROOT, "apps", "meriv2-orchestrator", "scripts", "entrypoint.sh")
RELEASE_OPERATOR = os.path.join(ROOT, "scripts", "meri-release.mjs")
RETIRED_EXECUTOR = os.path.join(ROOT, "scripts", "execute-meriv2-ecs-release.mjs")

SHA_TAG_TEXT = r":\${EXPECTED_SHA}"
EXACT_SHA_TAG = re.escape(SHA_TAG_TEXT)


def read(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def collect():
    return {
        "build": read(BUILD_OPERATOR),
        "dockerfile": read(DOCKERFILE),
        "entrypoint": read(ENTRYPOINT),
        "release": read(RELEASE_OPERATOR),
        "retired": read(RETIRED_EXECUTOR),
    }


def check_no_latest(files):
    if re.search(r":latest\b", files["build"]):
        return False, "build operator: :latest tag found"
    return True, "build operator: no :latest tag"


def check_exclusive_sha_push(files):
    build = files["build"]
    refs = re.findall(r"dkr\.ecr\.\$\{REGION\}\.amazonaws\.com/\$\{REPOSITORY\}" + EXACT_SHA_TAG, build)
    if build.count("docker push") != 1 or 'docker push "$image"' not in build or len(refs) != 1:
        return False, "build operator: not an exclusive exact-SHA push"
    return True, "build operator: exclusive exact-SHA push"


def check_no_ecs_steps(files):
    if re.search(r"\baws\s+ecs\b|\bupdate-service\b|\bservices-stable\b|\bregister-task-definition\b", files["build"]):
        return False, "build operator: ECS command found"
    return True, "build operator: no ECS commands"


def check_orchestrator_pins(files):
    build = files["build"]
    required = (
        "python3 scripts/validate-meri-orchestrator-build-only.py",
        "docker pull public.ecr.aws/docker/library/node:22.23.3-bookworm-slim",
        "docker tag public.ecr.aws/docker/library/node:22.23.3-bookworm-slim node:22.23.3-bookworm-slim",
        "'--no-cache '",
        "--platform linux/arm64",
        "$(uname -m)\" = aarch64",
    )
    missing = [fragment for fragment in required if fragment not in build]
    if missing:
        return False, "build operator: missing orchestrator pin " + missing[0]
    return True, "build operator: orchestrator pins and native build retained"


def check_no_orchestrator_direct_dispatch(files):
    # The retired multi-service/direct executor must stay retired ...
    if "throw new Error('Retired:" not in files["retired"]:
        return False, "retired executor: no longer fail-closed"
    if re.search(r"\bimport\b|\brequire\(|execFile|spawn\(|update-service|run-task|aws ecs", files["retired"]):
        return False, "retired executor: dispatch capability reintroduced"
    # ... and the only promotion path must validate a one-service qualification.
    if "validateQualification" not in files["release"]:
        return False, "release operator: qualification validation missing"
    if re.search(r"start-build|startBuild|docker\s+(?:build|push)", files["release"]):
        return False, "release operator: promotion builds or dispatches an image"
    return True, "no direct dispatch: retired executor + qualified one-service promotion"


def check_serve_contract(files):
    dockerfile = files["dockerfile"]
    entrypoint = files["entrypoint"]
    required_dockerfile = (
        'ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/entrypoint.sh"]',
        'CMD ["serve"]',
        "EXPOSE 4300",
        "USER capiro",
    )
    missing = [fragment for fragment in required_dockerfile if fragment not in dockerfile]
    if missing:
        return False, "Dockerfile: serve contract changed (" + missing[0] + ")"
    if "exec node dist/main.js" not in entrypoint:
        return False, "entrypoint.sh: serve no longer starts dist/main.js"
    if re.search(r"prisma|migrate", entrypoint):
        return False, "entrypoint.sh: runtime migration reintroduced"
    if "Unknown command" not in entrypoint:
        return False, "entrypoint.sh: unknown verbs no longer rejected"
    return True, "serve-only runtime contract retained (4300, dumb-init, no migration)"


CHECKS = (
    check_no_latest,
    check_exclusive_sha_push,
    check_no_ecs_steps,
    check_orchestrator_pins,
    check_no_orchestrator_direct_dispatch,
    check_serve_contract,
)


def evaluate(files):
    failures = []
    for check in CHECKS:
        ok, message = check(files)
        if not ok:
            failures.append(message)
    return failures


def main():
    print("=== Meri orchestrator build/deploy isolation contract ===\n")
    failures = evaluate(collect())
    for check in CHECKS:
        ok, message = check(collect())
        print(("PASS: " if ok else "FAIL: ") + message)
    print("\n=== Results ===")
    print("Passed: {}/{}".format(len(CHECKS) - len(failures), len(CHECKS)))
    if failures:
        print("\nREGRESSION: retained build-only contract no longer matches.")
        return 1
    print("\nAll checks passed. Meri orchestrator is build-only.")
    return 0


import unittest


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.files = collect()
        self.assertEqual(evaluate(self.files), [])

    def mutate(self, key, before, after):
        self.assertIn(before, self.files[key])
        mutated = dict(self.files)
        mutated[key] = self.files[key].replace(before, after, 1)
        self.assertTrue(evaluate(mutated), "mutation did not fail closed: " + before)

    def test_latest(self):
        self.mutate("build", SHA_TAG_TEXT, ":latest")

    def test_second_push(self):
        self.mutate("build", 'docker push "$image"',
                    "docker push other:${EXPECTED_SHA}" + chr(10) + 'docker push "$image"')

    def test_ecs(self):
        self.mutate("build", 'docker push "$image"',
                    "aws ecs update-service" + chr(10) + 'docker push "$image"')

    def test_arch_pin_removed(self):
        self.mutate("build", '$(uname -m)" = aarch64', '$(uname -m)" = x86_64')

    def test_node_pin_removed(self):
        self.mutate("build", "docker pull public.ecr.aws/docker/library/node:22.23.3-bookworm-slim",
                    "docker pull node:latest")

    def test_executor_reactivated(self):
        self.mutate("retired", "throw new Error('Retired:", "console.log('Retired:")

    def test_promotion_builds(self):
        self.mutate("release", "const fail = (message) => {",
                    "const startBuild = () => 1;" + chr(10) + "const fail = (message) => {")

    def test_migration_entrypoint(self):
        self.mutate("entrypoint", "  serve)",
                    "  migrate)" + chr(10) + "    npx prisma migrate deploy" + chr(10) + "    ;;" + chr(10) + "  serve)")

    def test_serve_entrypoint_changed(self):
        self.mutate("entrypoint", "exec node dist/main.js", "exec node dist/other.js")

    def test_dockerfile_expose_changed(self):
        self.mutate("dockerfile", "EXPOSE 4300", "EXPOSE 8080")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        unittest.main(argv=[sys.argv[0]])
    else:
        sys.exit(main())
