#!/usr/bin/env python3
"""Write the trusted api-image workflow's narrow source-to-digest build record."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

SCHEMA_VERSION = "capiro.api-image-build-record.v1"
EXPECTED_REPOSITORY = "neo-capiro/capirov2"
EXPECTED_WORKFLOW = "api-image"
WORKFLOW_PATH = ".github/workflows/api-image.yml"
EXPECTED_REGION = "us-east-1"
DOCKERFILE = "apps/api/Dockerfile"
BUILD_CONTEXT = "."
PLATFORM = "linux/arm64"
OUTPUT_PATH = Path("api-image-build-record.json")

COMMIT_RE = re.compile(r"[0-9a-f]{40}\Z")
DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
ECR_REGISTRY_RE = re.compile(
    rf"[0-9]{{12}}\.dkr\.ecr\.{re.escape(EXPECTED_REGION)}\.amazonaws\.com\Z"
)
REF_RE = re.compile(r"refs/(?:heads|tags)/[A-Za-z0-9._/-]+\Z")
POSITIVE_INTEGER_RE = re.compile(r"[1-9][0-9]*\Z")
ALLOWED_ENVIRONMENTS = frozenset({"dev", "staging", "prod"})


class RecordError(ValueError):
    """An input cannot safely identify this workflow build."""


def required_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RecordError(f"{name} is required")
    return value


def require_exact(name: str, expected: str) -> str:
    value = required_env(name)
    if value != expected:
        raise RecordError(f"{name} must be {expected!r}")
    return value


def parse_positive_integer(name: str) -> int:
    value = required_env(name)
    if not POSITIVE_INTEGER_RE.fullmatch(value):
        raise RecordError(f"{name} must be a positive decimal integer")
    parsed = int(value)
    if parsed > 9_223_372_036_854_775_807:
        raise RecordError(f"{name} is out of range")
    return parsed


def validate_ref(value: str) -> str:
    if not REF_RE.fullmatch(value):
        raise RecordError("GITHUB_REF must be a heads or tags ref using safe characters")
    if any(part in {"", ".", ".."} for part in value.split("/")):
        raise RecordError("GITHUB_REF contains an invalid path component")
    if ".." in value or "//" in value or value.endswith(("/", ".")):
        raise RecordError("GITHUB_REF is not canonical")
    return value


def build_record() -> dict[str, object]:
    github_sha = required_env("GITHUB_SHA")
    checked_out_sha = required_env("CHECKED_OUT_SHA")
    if not COMMIT_RE.fullmatch(github_sha):
        raise RecordError("GITHUB_SHA must be a full 40-character lowercase commit hash")
    if not COMMIT_RE.fullmatch(checked_out_sha):
        raise RecordError("CHECKED_OUT_SHA must be a full 40-character lowercase commit hash")
    if checked_out_sha != github_sha:
        raise RecordError("CHECKED_OUT_SHA must exactly match GITHUB_SHA")

    digest = required_env("IMAGE_DIGEST")
    if not DIGEST_RE.fullmatch(digest):
        raise RecordError("IMAGE_DIGEST must be sha256 followed by 64 lowercase hex characters")

    require_exact("GITHUB_REPOSITORY", EXPECTED_REPOSITORY)
    require_exact("GITHUB_WORKFLOW", EXPECTED_WORKFLOW)
    require_exact("AWS_REGION", EXPECTED_REGION)

    environment = required_env("TARGET_ENV")
    if environment not in ALLOWED_ENVIRONMENTS:
        raise RecordError("TARGET_ENV must be one of dev, staging, or prod")

    registry = required_env("ECR_REGISTRY")
    if not ECR_REGISTRY_RE.fullmatch(registry):
        raise RecordError(
            f"ECR_REGISTRY must be an account registry in {EXPECTED_REGION} with no path"
        )

    repository = f"{registry}/capiro/{environment}/api"
    return {
        "schemaVersion": SCHEMA_VERSION,
        "source": {
            "repository": EXPECTED_REPOSITORY,
            "ref": validate_ref(required_env("GITHUB_REF")),
            "commit": github_sha,
        },
        "build": {
            "context": BUILD_CONTEXT,
            "dockerfile": DOCKERFILE,
            "platform": PLATFORM,
        },
        "image": {
            "repository": repository,
            "digest": digest,
            "uri": f"{repository}@{digest}",
        },
        "environment": environment,
        "workflow": {
            "name": EXPECTED_WORKFLOW,
            "path": WORKFLOW_PATH,
            "runId": parse_positive_integer("GITHUB_RUN_ID"),
            "runAttempt": parse_positive_integer("GITHUB_RUN_ATTEMPT"),
        },
    }


def main() -> int:
    try:
        record = build_record()
        payload = json.dumps(record, indent=2, sort_keys=True) + "\n"
        OUTPUT_PATH.write_text(payload, encoding="utf-8", newline="\n")
    except (OSError, RecordError) as error:
        try:
            OUTPUT_PATH.unlink(missing_ok=True)
        except OSError:
            pass
        print(f"api-image-build-record: {error}", file=sys.stderr)
        return 2

    print(f"Wrote {OUTPUT_PATH} for {record['image']['uri']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
