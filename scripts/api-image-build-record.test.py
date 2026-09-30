#!/usr/bin/env python3
"""Focused offline tests for the api-image build record and workflow wiring."""

from __future__ import annotations

import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "api-image-build-record.py"
WORKFLOW = ROOT / ".github" / "workflows" / "api-image.yml"
BASE_COMMIT = "84bc85e93"
SHA = "a" * 40
DIGEST = "sha256:" + "bc" * 32
REGISTRY = "123456789012.dkr.ecr.us-east-1.amazonaws.com"
OUTPUT_NAME = "api-image-build-record.json"


def valid_environment() -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(
        {
            "AWS_REGION": "us-east-1",
            "CHECKED_OUT_SHA": SHA,
            "ECR_REGISTRY": REGISTRY,
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_REPOSITORY": "neo-capiro/capirov2",
            "GITHUB_RUN_ATTEMPT": "2",
            "GITHUB_RUN_ID": "987654321",
            "GITHUB_SHA": SHA,
            "GITHUB_WORKFLOW": "api-image",
            "IMAGE_DIGEST": DIGEST,
            "TARGET_ENV": "dev",
        }
    )
    return environment


def run_record(overrides: dict[str, str | None] | None = None) -> tuple[subprocess.CompletedProcess[str], Path]:
    environment = valid_environment()
    for name, value in (overrides or {}).items():
        if value is None:
            environment.pop(name, None)
        else:
            environment[name] = value
    directory = Path(tempfile.mkdtemp(prefix="api-build-record-"))
    result = subprocess.run(
        [os.environ.get("PYTHON", "python"), str(SCRIPT)],
        cwd=directory,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )
    return result, directory / OUTPUT_NAME


def scalar(value: str) -> Any:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    if len(value) >= 2 and value[0] == value[-1] == '"':
        return value[1:-1]
    if value == "true":
        return True
    if value == "false":
        return False
    if value.isdecimal():
        return int(value)
    return value


def parse_workflow(text: str) -> dict[str, Any]:
    """Parse the mapping/list/block-scalar YAML subset used by this workflow."""

    lines = text.splitlines()

    def significant(index: int) -> int:
        while index < len(lines):
            stripped = lines[index].strip()
            if stripped and not stripped.startswith("#"):
                break
            index += 1
        return index

    def indentation(index: int) -> int:
        return len(lines[index]) - len(lines[index].lstrip(" "))

    def split_mapping(content: str) -> tuple[str, str]:
        if ":" not in content:
            raise AssertionError(f"unsupported workflow YAML line: {content!r}")
        key, value = content.split(":", 1)
        return key.strip(), value.strip()

    def parse_block_scalar(index: int, parent_indent: int) -> tuple[str, int]:
        collected: list[str] = []
        block_indent: int | None = None
        while index < len(lines):
            raw = lines[index]
            if raw.strip():
                current_indent = indentation(index)
                if current_indent <= parent_indent:
                    break
                block_indent = current_indent if block_indent is None else min(block_indent, current_indent)
            collected.append(raw)
            index += 1
        if block_indent is None:
            return "", index
        while collected and not collected[-1].strip():
            collected.pop()
        return "\n".join(line[block_indent:] if line.strip() else "" for line in collected) + "\n", index

    def parse_value(value: str, index: int, parent_indent: int) -> tuple[Any, int]:
        if value == "|":
            return parse_block_scalar(index, parent_indent)
        if value:
            return scalar(value), index
        child = significant(index)
        if child >= len(lines) or indentation(child) <= parent_indent:
            return None, index
        return parse_node(child, indentation(child))

    def parse_map(index: int, expected_indent: int) -> tuple[dict[str, Any], int]:
        result: dict[str, Any] = {}
        while True:
            index = significant(index)
            if index >= len(lines) or indentation(index) != expected_indent:
                return result, index
            content = lines[index].strip()
            if content.startswith("- "):
                return result, index
            key, raw_value = split_mapping(content)
            value, index = parse_value(raw_value, index + 1, expected_indent)
            if key in result:
                raise AssertionError(f"duplicate workflow key: {key}")
            result[key] = value

    def parse_list(index: int, expected_indent: int) -> tuple[list[Any], int]:
        result: list[Any] = []
        while True:
            index = significant(index)
            if index >= len(lines) or indentation(index) != expected_indent:
                return result, index
            content = lines[index].strip()
            if not content.startswith("- "):
                return result, index
            item = content[2:].strip()
            if ":" not in item:
                result.append(scalar(item))
                index += 1
                continue
            key, raw_value = split_mapping(item)
            first_value, index = parse_value(raw_value, index + 1, expected_indent)
            mapping = {key: first_value}
            next_index = significant(index)
            if next_index < len(lines) and indentation(next_index) > expected_indent:
                remainder, index = parse_map(next_index, indentation(next_index))
                overlap = mapping.keys() & remainder.keys()
                if overlap:
                    raise AssertionError(f"duplicate workflow list key: {sorted(overlap)}")
                mapping.update(remainder)
            result.append(mapping)

    def parse_node(index: int, expected_indent: int) -> tuple[Any, int]:
        if lines[index].strip().startswith("- "):
            return parse_list(index, expected_indent)
        return parse_map(index, expected_indent)

    start = significant(0)
    parsed, end = parse_node(start, indentation(start))
    if significant(end) != len(lines):
        raise AssertionError(f"workflow parser stopped at line {end + 1}")
    if not isinstance(parsed, dict):
        raise AssertionError("workflow root is not a mapping")
    return parsed


class BuildRecordTests(unittest.TestCase):
    def test_writes_exact_narrow_record(self) -> None:
        result, output = run_record(
            {
                "BUILD_CONTEXT": "../../tampered",
                "DOCKERFILE": "other/Dockerfile",
                "ECR_REPOSITORY": "attacker/repository",
                "PLATFORM": "linux/amd64",
            }
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(output.read_text(encoding="utf-8")),
            {
                "schemaVersion": "capiro.api-image-build-record.v1",
                "source": {
                    "repository": "neo-capiro/capirov2",
                    "ref": "refs/heads/main",
                    "commit": SHA,
                },
                "build": {
                    "context": ".",
                    "dockerfile": "apps/api/Dockerfile",
                    "platform": "linux/arm64",
                },
                "image": {
                    "repository": f"{REGISTRY}/capiro/dev/api",
                    "digest": DIGEST,
                    "uri": f"{REGISTRY}/capiro/dev/api@{DIGEST}",
                },
                "environment": "dev",
                "workflow": {
                    "name": "api-image",
                    "path": ".github/workflows/api-image.yml",
                    "runId": 987654321,
                    "runAttempt": 2,
                },
            },
        )

    def test_rejects_missing_digest_and_leaves_no_output(self) -> None:
        environment = valid_environment()
        environment.pop("IMAGE_DIGEST")
        with tempfile.TemporaryDirectory(prefix="api-build-record-") as directory:
            output = Path(directory) / OUTPUT_NAME
            output.write_text("stale", encoding="utf-8")
            result = subprocess.run(
                [os.environ.get("PYTHON", "python"), str(SCRIPT)],
                cwd=directory,
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("IMAGE_DIGEST is required", result.stderr)
            self.assertFalse(output.exists(), "a failed invocation left a stale or partial receipt")

    def test_rejects_tampered_identity_digest_and_repository_inputs(self) -> None:
        cases = {
            "checkout mismatch": {"CHECKED_OUT_SHA": "b" * 40},
            "short github sha": {"GITHUB_SHA": "a" * 39, "CHECKED_OUT_SHA": "a" * 39},
            "malformed digest": {"IMAGE_DIGEST": "sha256:abcd"},
            "wrong source repo": {"GITHUB_REPOSITORY": "attacker/fork"},
            "unsafe target env": {"TARGET_ENV": "dev/../../prod"},
            "registry with path": {"ECR_REGISTRY": f"{REGISTRY}/attacker"},
            "wrong region": {"AWS_REGION": "us-west-2"},
            "wrong workflow": {"GITHUB_WORKFLOW": "other-workflow"},
            "noncanonical ref": {"GITHUB_REF": "refs/heads/main/../prod"},
        }
        for label, overrides in cases.items():
            with self.subTest(label=label):
                result, output = run_record(overrides)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertFalse(output.exists())


class WorkflowContractTests(unittest.TestCase):
    def test_only_record_wiring_id_and_accurate_echo_change_workflow_semantics(self) -> None:
        baseline_text = subprocess.check_output(
            ["git", "show", f"{BASE_COMMIT}:.github/workflows/api-image.yml"],
            cwd=ROOT,
            text=True,
        )
        baseline = parse_workflow(baseline_text)
        current = parse_workflow(WORKFLOW.read_text(encoding="utf-8"))

        baseline_steps = baseline["jobs"]["build"]["steps"]
        current_steps = current["jobs"]["build"]["steps"]
        baseline_build = next(step for step in baseline_steps if step.get("name") == "Build and push (linux/arm64)")
        current_build = next(step for step in current_steps if step.get("name") == "Build and push (linux/arm64)")
        self.assertNotIn("id", baseline_build)
        self.assertEqual(current_build.get("id"), "build")

        current_output = next(step for step in current_steps if step.get("name") == "Output image digest")
        self.assertEqual(
            current_output,
            {
                "name": "Output image digest",
                "env": {
                    "ECR_REGISTRY": "${{ steps.ecr.outputs.registry }}",
                    "IMAGE_DIGEST": "${{ steps.build.outputs.digest }}",
                },
                "run": 'echo "Pushed ${ECR_REGISTRY}/capiro/${TARGET_ENV}/api@${IMAGE_DIGEST} (tag ${GITHUB_SHA})"',
            },
        )

        create = next(step for step in current_steps if step.get("name") == "Create API image build record")
        self.assertEqual(
            create,
            {
                "name": "Create API image build record",
                "env": {
                    "ECR_REGISTRY": "${{ steps.ecr.outputs.registry }}",
                    "IMAGE_DIGEST": "${{ steps.build.outputs.digest }}",
                },
                "shell": "bash",
                "run": 'set -euo pipefail\nexport CHECKED_OUT_SHA="$(git rev-parse HEAD)"\npython scripts/api-image-build-record.py\n',
            },
        )
        upload = next(step for step in current_steps if step.get("name") == "Upload API image build record")
        self.assertEqual(
            upload,
            {
                "name": "Upload API image build record",
                "uses": "actions/upload-artifact@v4",
                "with": {
                    "name": "api-image-build-record-${{ github.run_id }}-${{ github.run_attempt }}",
                    "path": OUTPUT_NAME,
                    "if-no-files-found": "error",
                },
            },
        )
        step_names = [step.get("name") for step in current_steps]
        ordered_names = [
            "Build and push (linux/arm64)",
            "Output image digest",
            "Create API image build record",
            "Upload API image build record",
            "Deploy to ECS",
        ]
        self.assertEqual(
            [step_names.index(name) for name in ordered_names],
            sorted(step_names.index(name) for name in ordered_names),
        )

        normalized = copy.deepcopy(current)
        normalized_steps = normalized["jobs"]["build"]["steps"]
        normalized_build = next(step for step in normalized_steps if step.get("name") == "Build and push (linux/arm64)")
        del normalized_build["id"]
        baseline_output = next(step for step in baseline_steps if step.get("name") == "Output image digest")
        output_index = next(index for index, step in enumerate(normalized_steps) if step.get("name") == "Output image digest")
        normalized_steps[output_index] = copy.deepcopy(baseline_output)
        normalized["jobs"]["build"]["steps"] = [
            step
            for step in normalized_steps
            if step.get("name") not in {"Create API image build record", "Upload API image build record"}
        ]

        self.assertEqual(
            normalized,
            baseline,
            "workflow commands/config changed beyond the build id, digest echo, and record steps",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
