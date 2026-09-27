#!/usr/bin/env python3
"""Fail-closed source contract for separating Meri image builds from promotion.

Native MeriV3 remains live; this does not retire its orchestrator or prove an
ECS deployment. No third-party YAML parser is required.
"""

import os
import sys
import re

WORKFLOWS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    ".github", "workflows"
)


def read_workflow(name):
    """Read workflow YAML file contents."""
    path = os.path.join(WORKFLOWS_DIR, name)
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def test_orchestrator_image_no_latest(content):
    """Assert :latest tag is NOT present in meriv2-orchestrator-image."""
    if ":latest" in content:
        print("FAIL: meriv2-orchestrator-image.yml: :latest tag found")
        return False
    print("PASS: meriv2-orchestrator-image.yml: no :latest tag")
    return True


def test_orchestrator_image_shhtag_present(content):
    """Require exactly one pushed Docker tag and bind it to github.sha."""
    tags = re.search(r"(?m)^          tags: \|\s*\n((?:^            \S.*\n)+)", content)
    if "push: true" not in content or not tags or tags.group(1).splitlines() != [
        "            ${{ steps.ecr.outputs.registry }}/capiro/${{ env.TARGET_ENV }}/meriv2-orchestrator:${{ github.sha }}"
    ]:
        print("FAIL: meriv2-orchestrator-image.yml: not an exclusive SHA-tagged push")
        return False
    print("PASS: meriv2-orchestrator-image.yml: exclusive SHA-tagged push")
    return True


def test_orchestrator_image_no_ecs_steps(content):
    """Assert the image workflow contains no ECS CLI side effects."""
    if re.search(r"\baws\s+ecs\b|\bupdate-service\b|\bservices-stable\b", content):
        print("FAIL: meriv2-orchestrator-image.yml: ECS command found")
        return False
    print("PASS: meriv2-orchestrator-image.yml: no ECS commands")
    return True


def test_deploy_all_no_orchestrator_option(content):
    """Fail if the service options block is absent or contains orchestrator."""
    options = re.search(
        r"(?m)^      service:\s*\n(?:^        [^\n]*\n)*?^        options:\s*\n"
        r"((?:^          - [^\n]+\n)+)", content,
    )
    if not options or "- meriv2-orchestrator" in options.group(1):
        print("FAIL: deploy-all.yml: missing service choices or orchestrator still offered")
        return False
    print("PASS: deploy-all.yml: orchestrator excluded from service options")
    return True


def test_deploy_all_guard_step(content):
    """Reject a direct dispatch before AWS credentials/image publication."""
    marker = "      - name: Deny unqualified orchestrator deployment"
    aws_marker = "      - name: Configure AWS credentials (OIDC)"
    if marker not in content or aws_marker not in content or content.index(marker) >= content.index(aws_marker):
        print("FAIL: deploy-all.yml: guard missing or too late")
        return False
    block = content[content.index(marker):content.index(aws_marker)]
    if not re.search(
        r'if \[ "\$SERVICE" = "meriv2-orchestrator" \]; then\s*'
        r'echo [^\n]+\n\s*exit 1\s*\n\s*fi', block,
    ):
        print("FAIL: deploy-all.yml: guard does not reject direct dispatch")
        return False
    print("PASS: deploy-all.yml: direct dispatch rejected before AWS access")
    return True


def main():
    """Run all tests."""
    print("=== Meri orchestrator build/deploy isolation contract ===\n")

    test_orchestrator_image = read_workflow("meriv2-orchestrator-image.yml")
    test_deploy_all = read_workflow("deploy-all.yml")

    results = []
    results.append(test_orchestrator_image_shhtag_present(test_orchestrator_image))
    results.append(test_orchestrator_image_no_latest(test_orchestrator_image))
    results.append(test_orchestrator_image_no_ecs_steps(test_orchestrator_image))
    results.append(test_deploy_all_no_orchestrator_option(test_deploy_all))
    results.append(test_deploy_all_guard_step(test_deploy_all))

    print("\n=== Results ===")
    passed = sum(results)
    total = len(results)
    print(f"Passed: {passed}/{total}")

    if passed == total:
        print("\nAll checks passed. Meri orchestrator is build-only.")
        return 0
    else:
        print("\nREGRESSION: Workflow changes did not match expected fail-closed pattern.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
