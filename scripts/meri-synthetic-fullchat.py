#!/usr/bin/env python3
"""Run the fixed two-tenant Meri fullChat flag command in a qualified API one-off image."""

from __future__ import annotations

import argparse
import base64
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Mapping, Sequence

ACCOUNT_ID = "967807252336"
REGION = "us-east-1"
CLUSTER = "capiro-dev"
SERVICE = "capiro-dev-api"
TASK_FAMILY = "capiro-dev-api-diag"
CONTAINER = "db-inspect"
REPOSITORY = "neo-capiro/capirov2"
WORKFLOW_PATH = ".github/workflows/meri-synthetic-fullchat.yml"
WORKFLOW_NAME = "meri-synthetic-fullchat"
ARTIFACT_PREFIX = "synthetic-fullchat-receipt"
API_IMAGE_WORKFLOW_PATH = ".github/workflows/api-image.yml"
API_IMAGE_WORKFLOW_NAME = "api-image"
API_IMAGE_ARTIFACT_PREFIX = "api-image-build-record"
API_IMAGE_SCHEMA_VERSION = "capiro.api-image-build-record.v1"
API_IMAGE_PRODUCER_COMMIT = "2b524fd2ae77ab07f7b3b83beafac5186a501663"
IMAGE_REPOSITORY = f"{ACCOUNT_ID}.dkr.ecr.{REGION}.amazonaws.com/capiro/dev/api"
FLAG = "meriv3.fullChat"
TENANTS = (
    ("f2d6cf8f-057c-479a-8110-62fe5086d43f", "meri-foundation-20260928-t1"),
    ("52e91176-08f0-4d89-9633-bc212f5bdbbf", "meri-foundation-20260928-t2"),
)
APPLY_CONFIRMATION = "APPLY_FIXED_MERI_FOUNDATION_FULLCHAT"
ROLLBACK_CONFIRMATION = "ROLLBACK_FIXED_MERI_FOUNDATION_FULLCHAT"
RESULT_PREFIX = "MERI_FOUNDATION_FULLCHAT_RESULT="
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
INTEGER_RE = re.compile(r"^[1-9][0-9]*$")
TASK_ARN_RE = re.compile(
    rf"^arn:aws:ecs:{REGION}:{ACCOUNT_ID}:task/{CLUSTER}/[0-9a-f]{{32}}$"
)
TD_ARN_RE = re.compile(
    rf"^arn:aws:ecs:{REGION}:{ACCOUNT_ID}:task-definition/{TASK_FAMILY}:[1-9][0-9]*$"
)
REGISTER_SOURCE_FILES = (
    "apps/api/scripts/set-tenant-flag.ts",
    "apps/api/scripts/set-tenant-flag-foundation.ts",
    "apps/api/scripts/entrypoint-dispatcher.inc",
)
MAX_ARCHIVE_BYTES = 1024 * 1024
MAX_RECEIPT_BYTES = 512 * 1024
MAX_GITHUB_METADATA_BYTES = 1024 * 1024
GITHUB_API_ORIGIN = "https://api.github.com"
DB_SECRET_NAMES = frozenset({"DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD"})
DB_RESULT_KEYS = frozenset({"schemaVersion", "operation", "mode", "result", "flag", "tenants"})
BUILD_RECORD_KEYS = frozenset({"schemaVersion", "source", "build", "image", "environment", "workflow"})
BUILD_PROOF_KEYS = frozenset({
    "runId", "runAttempt", "headSha", "runCreatedAt", "runStartedAt", "runUpdatedAt",
    "artifactId", "artifactName", "artifactCreatedAt", "artifactUpdatedAt", "archiveDigest", "record",
})
BUILD_SELECTION_KEYS = BUILD_PROOF_KEYS - {"record"}
RECEIPT_BASE_KEYS = frozenset({
    "schemaVersion", "workflow", "workflowPath", "repository", "runId", "runAttempt",
    "artifactName", "workflowSha", "actor", "actorId", "mode", "result", "verified",
    "target", "flag", "tenants", "qualifiedTaskDefinition", "imageDigest",
    "imageSourceCommit", "taskArn", "buildProof", "priorStates", "readback",
})
RECEIPT_SOURCE_KEYS = frozenset({"sourceRunId", "sourceRunAttempt", "sourceArtifactDigest"})


class FullchatError(RuntimeError):
    pass


class RejectGithubMetadataRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        raise FullchatError("authenticated GitHub metadata redirect refused")


class AwsCli:
    def _json(self, args: Sequence[str]) -> dict[str, Any]:
        command = ["aws", *args, "--region", REGION, "--output", "json", "--no-cli-pager"]
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            raise FullchatError(f"AWS CLI operation failed: {' '.join(args[:2])}")
        try:
            value = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise FullchatError("AWS CLI returned invalid JSON") from exc
        if not isinstance(value, dict):
            raise FullchatError("AWS CLI returned an unexpected JSON shape")
        return value

    def identity(self) -> dict[str, Any]:
        return self._json(("sts", "get-caller-identity"))

    def describe_service(self) -> dict[str, Any]:
        return self._json(("ecs", "describe-services", "--cluster", CLUSTER, "--services", SERVICE))

    def describe_task_definition(self, name: str) -> dict[str, Any]:
        return self._json(("ecs", "describe-task-definition", "--task-definition", name, "--include", "TAGS"))

    def list_tasks(self, *args: str) -> list[str]:
        value = self._json(("ecs", "list-tasks", "--cluster", CLUSTER, *args))
        tasks = value.get("taskArns")
        if not isinstance(tasks, list) or not all(isinstance(item, str) for item in tasks):
            raise FullchatError("list-tasks returned an unexpected task set")
        return tasks

    def describe_tasks(self, tasks: Sequence[str]) -> dict[str, Any]:
        if not tasks:
            return {"tasks": [], "failures": []}
        return self._json(("ecs", "describe-tasks", "--cluster", CLUSTER, "--tasks", *tasks))

    def run_task(self, task_definition: str, network: Mapping[str, Any], command: Sequence[str], started_by: str) -> str:
        overrides = {"containerOverrides": [{"name": CONTAINER, "command": list(command)}]}
        try:
            value = self._json(
                (
                    "ecs", "run-task", "--cluster", CLUSTER,
                    "--launch-type", "FARGATE",
                    "--task-definition", task_definition,
                    "--network-configuration", json.dumps(network, separators=(",", ":")),
                    "--overrides", json.dumps(overrides, separators=(",", ":")),
                    "--started-by", started_by,
                    "--count", "1",
                )
            )
            if value.get("failures"):
                raise FullchatError("run-task returned a failure")
            tasks = value.get("tasks") or []
            if len(tasks) != 1 or not isinstance(tasks[0].get("taskArn"), str):
                raise FullchatError("run-task did not acknowledge exactly one task")
            return tasks[0]["taskArn"]
        except FullchatError as exc:
            # The acknowledgement may have been lost after ECS accepted the task.
            # Reconcile the unique startedBy identity; never issue a second RunTask.
            # ECS requires startedBy to be the only ListTasks filter. A unique
            # still-visible task is authoritative; zero/multiple matches remain
            # ambiguous and fail closed rather than broad-scanning or retrying.
            observed = set(self.list_tasks("--started-by", started_by))
            if len(observed) != 1:
                raise FullchatError("run-task acknowledgement was ambiguous; no retry was attempted") from exc
            return next(iter(observed))

    def log_events(self, group: str, stream: str) -> list[str]:
        value = self._json(
            (
                "logs", "get-log-events", "--log-group-name", group,
                "--log-stream-name", stream, "--start-from-head",
            )
        )
        events = value.get("events")
        if not isinstance(events, list):
            raise FullchatError("CloudWatch returned an unexpected event set")
        return [str(item.get("message", "")) for item in events]


class GitCli:
    def run(self, args: Sequence[str]) -> str:
        completed = subprocess.run(["git", *args], capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            raise FullchatError(f"Git provenance check failed: {' '.join(args[:2])}")
        return completed.stdout.strip()


def strict_json_loads(payload: str, label: str) -> Any:
    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise FullchatError(f"{label} contains duplicate JSON keys")
            result[key] = value
        return result

    try:
        return json.loads(payload, object_pairs_hook=object_pairs)
    except json.JSONDecodeError as exc:
        raise FullchatError(f"{label} is invalid JSON") from exc


class GithubApi:
    def __init__(self, token: str | None = None) -> None:
        self.token = token if token is not None else os.environ.get("GITHUB_TOKEN", "")
        if not self.token:
            raise FullchatError("GITHUB_TOKEN is required for authenticated provenance retrieval")
        self.opener = urllib.request.build_opener(RejectGithubMetadataRedirects())

    @staticmethod
    def _origin(url: str) -> tuple[str, str, int | None]:
        parsed = urllib.parse.urlsplit(url)
        if parsed.username is not None or parsed.password is not None:
            raise FullchatError("authenticated GitHub metadata URL has an invalid origin")
        try:
            port = parsed.port
        except ValueError as exc:
            raise FullchatError("authenticated GitHub metadata URL has an invalid origin") from exc
        return parsed.scheme.lower(), (parsed.hostname or "").lower(), port

    def _json(self, path: str) -> dict[str, Any]:
        url = f"{GITHUB_API_ORIGIN}/repos/{REPOSITORY}/{path}"
        expected_origin = self._origin(GITHUB_API_ORIGIN)
        if self._origin(url) != expected_origin:
            raise FullchatError("authenticated GitHub metadata URL has an invalid origin")
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "capiro-meri-synthetic-fullchat",
            },
        )
        try:
            with self.opener.open(request, timeout=30) as response:
                if self._origin(response.geturl()) != expected_origin:
                    raise FullchatError("authenticated GitHub metadata response changed origin")
                payload = response.read(MAX_GITHUB_METADATA_BYTES + 1)
        except (OSError, urllib.error.HTTPError, urllib.error.URLError) as exc:
            raise FullchatError("authenticated GitHub metadata retrieval failed") from exc
        if len(payload) > MAX_GITHUB_METADATA_BYTES:
            raise FullchatError("authenticated GitHub metadata exceeded the bounded response size")
        try:
            decoded = payload.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise FullchatError("authenticated GitHub metadata was not UTF-8") from exc
        value = strict_json_loads(decoded, "authenticated GitHub metadata")
        if not isinstance(value, dict):
            raise FullchatError("authenticated GitHub metadata has an unexpected shape")
        return value

    def run_attempt(self, run_id: str, attempt: str) -> dict[str, Any]:
        artifact_name(run_id, attempt)
        return self._json(f"actions/runs/{run_id}/attempts/{attempt}")

    def artifacts(self, run_id: str) -> dict[str, Any]:
        if not INTEGER_RE.fullmatch(run_id):
            raise FullchatError("run ID must be a positive decimal integer")
        return self._json(f"actions/runs/{run_id}/artifacts?per_page=100")


def artifact_name(run_id: str, attempt: str) -> str:
    if not INTEGER_RE.fullmatch(run_id) or not INTEGER_RE.fullmatch(attempt):
        raise FullchatError("run ID and attempt must be positive decimal integers")
    return f"{ARTIFACT_PREFIX}-{run_id}-{attempt}"


def build_artifact_name(run_id: str, attempt: str) -> str:
    if not INTEGER_RE.fullmatch(run_id) or not INTEGER_RE.fullmatch(attempt):
        raise FullchatError("build run ID and attempt must be positive decimal integers")
    return f"{API_IMAGE_ARTIFACT_PREFIX}-{run_id}-{attempt}"


def github_time(value: Any, field: str) -> datetime.datetime:
    if not isinstance(value, str):
        raise FullchatError(f"trusted GitHub {field} is missing")
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise FullchatError(f"trusted GitHub {field} is invalid") from exc
    if parsed.tzinfo is None:
        raise FullchatError(f"trusted GitHub {field} has no timezone")
    return parsed


def select_artifact(
    run_id: str,
    attempt: str,
    run: Mapping[str, Any],
    artifacts: Mapping[str, Any],
) -> dict[str, Any]:
    expected_name = artifact_name(run_id, attempt)
    if (
        str(run.get("id")) != run_id
        or str(run.get("run_attempt")) != attempt
        or run.get("event") != "workflow_dispatch"
        or run.get("head_branch") != "main"
        or run.get("path") != WORKFLOW_PATH
        or (run.get("repository") or {}).get("full_name") != REPOSITORY
        or (run.get("head_repository") or {}).get("full_name") != REPOSITORY
        or run.get("status") != "completed"
        or run.get("conclusion") != "success"
    ):
        raise FullchatError("trusted GitHub run is not the exact successful fullChat workflow attempt")
    created = github_time(run.get("created_at"), "run created_at")
    started = github_time(run.get("run_started_at"), "run_started_at")
    updated = github_time(run.get("updated_at"), "run updated_at")
    if not created <= started <= updated:
        raise FullchatError("trusted GitHub run timestamps are inconsistent")
    values = artifacts.get("artifacts")
    if not isinstance(values, list) or artifacts.get("total_count") != len(values):
        raise FullchatError("trusted GitHub artifact metadata is incomplete")
    if not all(isinstance(item, dict) for item in values):
        raise FullchatError("trusted GitHub artifact metadata contains an invalid entry")
    matches = [item for item in values if item.get("name") == expected_name]
    if len(matches) != 1:
        raise FullchatError("trusted GitHub metadata does not select one exact run-attempt artifact")
    item = matches[0]
    workflow_run = item.get("workflow_run") or {}
    digest = item.get("digest")
    if (
        not isinstance(item.get("id"), int)
        or item["id"] <= 0
        or not DIGEST_RE.fullmatch(str(digest or ""))
        or item.get("expired") is not False
        or str(workflow_run.get("id")) != run_id
        or workflow_run.get("head_sha") != run.get("head_sha")
        or workflow_run.get("head_branch") != "main"
        or workflow_run.get("repository_id") != (run.get("repository") or {}).get("id")
        or workflow_run.get("head_repository_id") != (run.get("head_repository") or {}).get("id")
    ):
        raise FullchatError("trusted GitHub artifact is not bound to the exact source run")
    artifact_created = github_time(item.get("created_at"), "artifact created_at")
    artifact_updated = github_time(item.get("updated_at"), "artifact updated_at")
    if not started <= artifact_created <= artifact_updated <= updated:
        raise FullchatError("trusted GitHub artifact timestamps are outside its run")
    return {
        "artifactId": item["id"],
        "artifactName": expected_name,
        "archiveDigest": digest,
        "runId": run_id,
        "runAttempt": attempt,
    }


def select_build_artifact(
    run_id: str,
    attempt: str,
    run: Mapping[str, Any],
    artifacts: Mapping[str, Any],
) -> dict[str, Any]:
    expected_name = build_artifact_name(run_id, attempt)
    head_sha = run.get("head_sha")
    if (
        str(run.get("id")) != run_id
        or str(run.get("run_attempt")) != attempt
        or run.get("event") not in ("push", "workflow_dispatch")
        or run.get("head_branch") != "main"
        or not SHA_RE.fullmatch(str(head_sha or ""))
        or run.get("path") != API_IMAGE_WORKFLOW_PATH
        or (run.get("repository") or {}).get("full_name") != REPOSITORY
        or (run.get("head_repository") or {}).get("full_name") != REPOSITORY
        or run.get("status") != "completed"
        or run.get("conclusion") != "success"
    ):
        raise FullchatError("trusted GitHub run is not the exact successful main API image workflow attempt")
    created_at = run.get("created_at")
    started_at = run.get("run_started_at")
    updated_at = run.get("updated_at")
    created = github_time(created_at, "build run created_at")
    started = github_time(started_at, "build run_started_at")
    updated = github_time(updated_at, "build run updated_at")
    if not created <= started <= updated:
        raise FullchatError("trusted GitHub build run timestamps are inconsistent")
    values = artifacts.get("artifacts")
    if not isinstance(values, list) or artifacts.get("total_count") != len(values):
        raise FullchatError("trusted GitHub build artifact metadata is incomplete or paginated")
    if not all(isinstance(item, dict) for item in values):
        raise FullchatError("trusted GitHub build artifact metadata contains an invalid entry")
    matches = [item for item in values if item.get("name") == expected_name]
    if len(matches) != 1:
        raise FullchatError("trusted GitHub metadata does not select one exact build run-attempt artifact")
    item = matches[0]
    workflow_run = item.get("workflow_run") or {}
    digest = item.get("digest")
    if (
        not isinstance(item.get("id"), int)
        or isinstance(item.get("id"), bool)
        or item["id"] <= 0
        or sum(candidate.get("id") == item["id"] for candidate in values) != 1
        or not DIGEST_RE.fullmatch(str(digest or ""))
        or item.get("expired") is not False
        or str(workflow_run.get("id")) != run_id
        or workflow_run.get("head_sha") != head_sha
        or workflow_run.get("head_branch") != "main"
        or workflow_run.get("repository_id") != (run.get("repository") or {}).get("id")
        or workflow_run.get("head_repository_id") != (run.get("head_repository") or {}).get("id")
    ):
        raise FullchatError("trusted GitHub build artifact is not bound to the exact source run")
    artifact_created_at = item.get("created_at")
    artifact_updated_at = item.get("updated_at")
    artifact_created = github_time(artifact_created_at, "build artifact created_at")
    artifact_updated = github_time(artifact_updated_at, "build artifact updated_at")
    if not started <= artifact_created <= artifact_updated <= updated:
        raise FullchatError("trusted GitHub build artifact timestamps are outside its run")
    return {
        "runId": int(run_id),
        "runAttempt": int(attempt),
        "headSha": head_sha,
        "runCreatedAt": created_at,
        "runStartedAt": started_at,
        "runUpdatedAt": updated_at,
        "artifactId": item["id"],
        "artifactName": expected_name,
        "artifactCreatedAt": artifact_created_at,
        "artifactUpdatedAt": artifact_updated_at,
        "archiveDigest": digest,
    }


def github_artifact_selection(
    github: GithubApi,
    run_id: str,
    attempt: str,
    build: bool,
) -> tuple[dict[str, Any], dict[str, Any]]:
    run = github.run_attempt(run_id, attempt)
    artifacts = github.artifacts(run_id)
    selection = (
        select_build_artifact(run_id, attempt, run, artifacts)
        if build
        else select_artifact(run_id, attempt, run, artifacts)
    )
    return run, selection


def load_archive_json(
    archive: Path,
    selection: Mapping[str, Any],
    expected_selection: Mapping[str, Any],
    filename: str,
    label: str,
) -> dict[str, Any]:
    if dict(selection) != dict(expected_selection):
        raise FullchatError(f"{label} artifact selection changed after authenticated validation")
    if not archive.is_file() or not 0 < archive.stat().st_size <= MAX_ARCHIVE_BYTES:
        raise FullchatError(f"{label} archive is absent or oversized")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if f"sha256:{digest}" != selection.get("archiveDigest"):
        raise FullchatError(f"{label} archive digest does not match GitHub metadata")
    try:
        with zipfile.ZipFile(archive) as value:
            entries = value.infolist()
            if len(entries) != 1 or entries[0].filename != filename:
                raise FullchatError(f"{label} archive must contain only {filename}")
            entry = entries[0]
            mode = (entry.external_attr >> 16) & 0o170000
            if entry.is_dir() or mode == 0o120000 or entry.flag_bits & 1 or not 0 < entry.file_size <= MAX_RECEIPT_BYTES:
                raise FullchatError(f"{label} archive entry is unsafe")
            payload = value.read(entry).decode("utf-8")
    except (OSError, UnicodeDecodeError, zipfile.BadZipFile) as exc:
        raise FullchatError(f"{label} archive is unreadable") from exc
    result = strict_json_loads(payload, label)
    if not isinstance(result, dict):
        raise FullchatError(f"{label} has an unexpected shape")
    return result


def load_source_receipt(
    archive: Path,
    selection: Mapping[str, Any],
    expected_selection: Mapping[str, Any],
) -> dict[str, Any]:
    return load_archive_json(
        archive, selection, expected_selection, "receipt.json", "source receipt"
    )


def validate_db_states(values: Any, field: str) -> list[dict[str, Any]]:
    if not isinstance(values, list) or len(values) != len(TENANTS):
        raise FullchatError(f"{field} must contain exactly two tenant states")
    result: list[dict[str, Any]] = []
    for index, candidate in enumerate(values):
        tenant_id, slug = TENANTS[index]
        if not isinstance(candidate, dict) or set(candidate) != {"tenantId", "tenantSlug", "flag", "state"}:
            raise FullchatError(f"{field} contains an invalid state entry")
        validate_flag_state(candidate.get("state"), field)
        if candidate.get("tenantId") != tenant_id or candidate.get("tenantSlug") != slug or candidate.get("flag") != FLAG:
            raise FullchatError(f"{field} is not bound to the fixed IDs, slugs, and flag")
        result.append(candidate)
    return result


def validate_flag_state(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict) or (
        not (value == {"present": False})
        and not (value.get("present") is True and set(value) == {"present", "value"})
    ):
        raise FullchatError(f"{field} contains more than flag presence/value")
    return value


def state_token(states: Sequence[Mapping[str, Any]]) -> str:
    raw = json.dumps(list(states), separators=(",", ":"), ensure_ascii=False).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def validate_build_selection(selection: Mapping[str, Any]) -> None:
    if set(selection) != BUILD_SELECTION_KEYS:
        raise FullchatError("build artifact selection shape is not exact")
    run_id = selection.get("runId")
    attempt = selection.get("runAttempt")
    if (
        not isinstance(run_id, int)
        or isinstance(run_id, bool)
        or run_id <= 0
        or not isinstance(attempt, int)
        or isinstance(attempt, bool)
        or attempt <= 0
        or selection.get("artifactName") != build_artifact_name(str(run_id), str(attempt))
        or not isinstance(selection.get("artifactId"), int)
        or isinstance(selection.get("artifactId"), bool)
        or selection["artifactId"] <= 0
        or not SHA_RE.fullmatch(str(selection.get("headSha", "")))
        or not DIGEST_RE.fullmatch(str(selection.get("archiveDigest", "")))
    ):
        raise FullchatError("build artifact selection identity is invalid")
    created = github_time(selection.get("runCreatedAt"), "bound build run created_at")
    started = github_time(selection.get("runStartedAt"), "bound build run_started_at")
    updated = github_time(selection.get("runUpdatedAt"), "bound build run updated_at")
    artifact_created = github_time(
        selection.get("artifactCreatedAt"), "bound build artifact created_at"
    )
    artifact_updated = github_time(
        selection.get("artifactUpdatedAt"), "bound build artifact updated_at"
    )
    if not created <= started <= artifact_created <= artifact_updated <= updated:
        raise FullchatError("bound build run/artifact timestamps are inconsistent")


def validate_build_record(
    record: Mapping[str, Any], selection: Mapping[str, Any]
) -> dict[str, Any]:
    validate_build_selection(selection)
    source = record.get("source")
    build = record.get("build")
    image = record.get("image")
    workflow = record.get("workflow")
    digest = image.get("digest") if isinstance(image, dict) else None
    if (
        set(record) != BUILD_RECORD_KEYS
        or record.get("schemaVersion") != API_IMAGE_SCHEMA_VERSION
        or not isinstance(source, dict)
        or set(source) != {"repository", "ref", "commit"}
        or source.get("repository") != REPOSITORY
        or source.get("ref") != "refs/heads/main"
        or source.get("commit") != selection.get("headSha")
        or not isinstance(build, dict)
        or build != {
            "context": ".",
            "dockerfile": "apps/api/Dockerfile",
            "platform": "linux/arm64",
        }
        or record.get("environment") != "dev"
        or not isinstance(image, dict)
        or set(image) != {"repository", "digest", "uri"}
        or image.get("repository") != IMAGE_REPOSITORY
        or not DIGEST_RE.fullmatch(str(digest or ""))
        or image.get("uri") != f"{IMAGE_REPOSITORY}@{digest}"
        or not isinstance(workflow, dict)
        or set(workflow) != {"name", "path", "runId", "runAttempt"}
        or workflow.get("name") != API_IMAGE_WORKFLOW_NAME
        or workflow.get("path") != API_IMAGE_WORKFLOW_PATH
        or type(workflow.get("runId")) is not int
        or type(workflow.get("runAttempt")) is not int
        or workflow.get("runId") != selection.get("runId")
        or workflow.get("runAttempt") != selection.get("runAttempt")
    ):
        raise FullchatError("API image build record does not match the exact Version 1 dev contract")
    return dict(record)


def load_build_proof(
    archive: Path,
    selection: Mapping[str, Any],
    expected_selection: Mapping[str, Any],
) -> dict[str, Any]:
    validate_build_selection(expected_selection)
    record = load_archive_json(
        archive,
        selection,
        expected_selection,
        "api-image-build-record.json",
        "API image build record",
    )
    normalized = validate_build_record(record, expected_selection)
    return {**dict(expected_selection), "record": normalized}


def validate_bound_build_proof(
    proof: Any, image_digest: Any, image_source_commit: Any
) -> dict[str, Any]:
    if not isinstance(proof, dict) or set(proof) != BUILD_PROOF_KEYS:
        raise FullchatError("source receipt build proof shape is not exact")
    selection = {key: proof[key] for key in BUILD_SELECTION_KEYS}
    record = proof.get("record")
    if not isinstance(record, dict):
        raise FullchatError("source receipt build record is absent")
    normalized = validate_build_record(record, selection)
    if (
        normalized["image"]["digest"] != image_digest
        or normalized["source"]["commit"] != image_source_commit
    ):
        raise FullchatError("source receipt build proof contradicts its runtime identity")
    return {**selection, "record": normalized}


def validate_source_receipt(
    receipt: Mapping[str, Any],
    run: Mapping[str, Any],
    selection: Mapping[str, Any],
    expected_mode: str,
) -> list[dict[str, Any]]:
    expected_keys = RECEIPT_BASE_KEYS | (
        RECEIPT_SOURCE_KEYS if expected_mode == "apply" else frozenset()
    )
    if set(receipt) != expected_keys:
        raise FullchatError("source receipt root fields are not the exact successful schema")
    if (
        receipt.get("schemaVersion") != 1
        or receipt.get("workflow") != WORKFLOW_NAME
        or receipt.get("workflowPath") != WORKFLOW_PATH
        or receipt.get("repository") != REPOSITORY
        or receipt.get("runId") != selection.get("runId")
        or receipt.get("runAttempt") != selection.get("runAttempt")
        or receipt.get("artifactName") != selection.get("artifactName")
        or receipt.get("workflowSha") != run.get("head_sha")
        or receipt.get("mode") != expected_mode
        or receipt.get("result") != ("PLANNED_AND_VERIFIED" if expected_mode == "plan" else "APPLIED_AND_VERIFIED")
        or receipt.get("verified") is not True
        or receipt.get("flag") != FLAG
    ):
        raise FullchatError("source receipt is not the exact expected successful operation")
    actor = run.get("actor") or {}
    if receipt.get("actor") != actor.get("login") or str(receipt.get("actorId")) != str(actor.get("id")):
        raise FullchatError("source receipt actor is not bound to trusted GitHub metadata")
    if receipt.get("target") != {"account": ACCOUNT_ID, "region": REGION, "cluster": CLUSTER}:
        raise FullchatError("source receipt target is not exact")
    if receipt.get("tenants") != [
        {"tenantId": tenant_id, "tenantSlug": slug} for tenant_id, slug in TENANTS
    ]:
        raise FullchatError("source receipt tenant set is not exact")
    if (
        not TD_ARN_RE.fullmatch(str(receipt.get("qualifiedTaskDefinition", "")))
        or not TASK_ARN_RE.fullmatch(str(receipt.get("taskArn", "")))
        or not DIGEST_RE.fullmatch(str(receipt.get("imageDigest", "")))
        or not SHA_RE.fullmatch(str(receipt.get("imageSourceCommit", "")))
    ):
        raise FullchatError("source receipt runtime/image binding is invalid")
    validate_bound_build_proof(
        receipt.get("buildProof"), receipt.get("imageDigest"), receipt.get("imageSourceCommit")
    )
    if expected_mode == "apply" and (
        not INTEGER_RE.fullmatch(str(receipt.get("sourceRunId", "")))
        or not INTEGER_RE.fullmatch(str(receipt.get("sourceRunAttempt", "")))
        or not DIGEST_RE.fullmatch(str(receipt.get("sourceArtifactDigest", "")))
    ):
        raise FullchatError("source apply receipt chain identity is invalid")
    prior = validate_db_states(receipt.get("priorStates"), "source priorStates")
    readback = receipt.get("readback")
    if not isinstance(readback, dict):
        raise FullchatError("source receipt omits exact sanitized DB readback")
    _, readback_before, _ = parse_db_result(
        [RESULT_PREFIX + json.dumps(readback, separators=(",", ":"))], expected_mode
    )
    if readback_before != prior:
        raise FullchatError("source receipt prior state contradicts its DB readback")
    return prior


def verify_execution_context(env: Mapping[str, str], git: GitCli) -> str:
    if env.get("GITHUB_REPOSITORY") != REPOSITORY or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch":
        raise FullchatError("workflow repository/event is not exact")
    if env.get("GITHUB_REF") != "refs/heads/main":
        raise FullchatError("workflow must be dispatched from main")
    if not env.get("GITHUB_WORKFLOW_REF", "").endswith(f"/{WORKFLOW_PATH}@refs/heads/main"):
        raise FullchatError("workflow file is not the merged main copy")
    head = git.run(("rev-parse", "HEAD"))
    if head != env.get("GITHUB_SHA") or git.run(("rev-parse", "origin/main")) != head:
        raise FullchatError("checked out workflow source is not current origin/main")
    if git.run(("rev-parse", "--is-shallow-repository")) != "false":
        raise FullchatError("workflow checkout does not have complete history")
    git.run(("cat-file", "-e", f"HEAD:{WORKFLOW_PATH}"))
    return head


def source_commit(container: Mapping[str, Any]) -> str:
    candidates: set[str] = set()
    labels = container.get("dockerLabels") or {}
    if not isinstance(labels, dict):
        raise FullchatError("qualified task dockerLabels have an unexpected shape")
    for key in ("org.opencontainers.image.revision", "git.sha", "git.commit"):
        value = labels.get(key)
        if isinstance(value, str) and SHA_RE.fullmatch(value.lower()):
            candidates.add(value.lower())
    environment = unique_named_values(
        container.get("environment"), "value", "container source environment"
    )
    for name, raw_value in environment.items():
        if name in ("GIT_SHA", "RELEASE_SHA", "SOURCE_COMMIT"):
            value = raw_value.lower()
            if SHA_RE.fullmatch(value):
                candidates.add(value)
    if len(candidates) != 1:
        raise FullchatError("qualified image must expose one exact 40-character source commit")
    return next(iter(candidates))


def unique_named_values(
    values: Any,
    value_field: str,
    field: str,
) -> dict[str, str]:
    if not isinstance(values, list):
        raise FullchatError(f"{field} must be a list")
    result: dict[str, str] = {}
    for item in values:
        if not isinstance(item, dict) or set(item) != {"name", value_field}:
            raise FullchatError(f"{field} contains an invalid entry")
        name = item.get("name")
        value = item.get(value_field)
        if (
            not isinstance(name, str)
            or not name
            or not isinstance(value, str)
            or not value
            or name in result
        ):
            raise FullchatError(f"{field} names and values must be nonempty and unique")
        result[name] = value
    return result


def validate_image_source(git: GitCli, sha: str) -> None:
    git.run(("cat-file", "-e", f"{sha}^{{commit}}"))
    git.run(("merge-base", "--is-ancestor", sha, "origin/main"))
    git.run(("merge-base", "--is-ancestor", API_IMAGE_PRODUCER_COMMIT, sha))
    for path in REGISTER_SOURCE_FILES:
        git.run(("cat-file", "-e", f"{sha}:{path}"))
    for path in (
        API_IMAGE_WORKFLOW_PATH,
        "scripts/api-image-build-record.py",
        "docs/contracts/api-image-build-record.md",
    ):
        git.run(("cat-file", "-e", f"{sha}:{path}"))
    script = git.run(("show", f"{sha}:apps/api/scripts/set-tenant-flag.ts"))
    foundation = git.run(("show", f"{sha}:apps/api/scripts/set-tenant-flag-foundation.ts"))
    dispatcher = git.run(("show", f"{sha}:apps/api/scripts/entrypoint-dispatcher.inc"))
    if "--foundation-fullchat" not in script or FLAG not in foundation or "set-tenant-flag)" not in dispatcher:
        raise FullchatError("qualified image source predates the fixed foundation command")


def capture_runtime(aws: AwsCli, git: GitCli) -> dict[str, Any]:
    service_response = aws.describe_service()
    services = service_response.get("services") or []
    if service_response.get("failures") or len(services) != 1:
        raise FullchatError("API service discovery was not exact")
    service = services[0]
    expected_service_arn = f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:service/{CLUSTER}/{SERVICE}"
    expected_cluster_arn = f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:cluster/{CLUSTER}"
    if service.get("serviceArn") != expected_service_arn or service.get("clusterArn") != expected_cluster_arn:
        raise FullchatError("API service escaped the fixed account/region/cluster")
    if (
        not isinstance(service.get("desiredCount"), int)
        or service.get("desiredCount", 0) <= 0
        or service.get("runningCount") != service.get("desiredCount")
        or service.get("pendingCount") != 0
    ):
        raise FullchatError("API service is not at exact steady task counts")
    deployments = service.get("deployments") or []
    primary = [item for item in deployments if item.get("status") == "PRIMARY"]
    if (
        len(primary) != 1
        or primary[0].get("taskDefinition") != service.get("taskDefinition")
        or primary[0].get("rolloutState") not in (None, "COMPLETED")
        or any(
            primary[0].get(field) != service.get(field)
            for field in ("desiredCount", "runningCount", "pendingCount")
        )
    ):
        raise FullchatError("API service PRIMARY deployment is not exact and steady")
    if any(
        any(int(item.get(field, 0)) != 0 for field in ("desiredCount", "runningCount", "pendingCount"))
        for item in deployments
        if item is not primary[0]
    ):
        raise FullchatError("API service has a concurrent deployment")
    network = service.get("networkConfiguration")
    if not isinstance(network, dict) or set(network) != {"awsvpcConfiguration"}:
        raise FullchatError("API service network configuration is not exact awsvpc")

    running_arns = aws.list_tasks("--service-name", SERVICE, "--desired-status", "RUNNING")
    running = aws.describe_tasks(running_arns)
    tasks = running.get("tasks") or []
    if running.get("failures") or not tasks or len(tasks) != service.get("runningCount"):
        raise FullchatError("API running task set is not steady and exact")
    expected_task_prefix = f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:task/{CLUSTER}/"
    for task in tasks:
        if (
            not str(task.get("taskArn", "")).startswith(expected_task_prefix)
            or task.get("taskDefinitionArn") != service.get("taskDefinition")
            or task.get("lastStatus") != "RUNNING"
            or task.get("desiredStatus") != "RUNNING"
        ):
            raise FullchatError("API running task identity/status is not exact")
    digests: set[str] = set()
    for task in tasks:
        containers = task.get("containers")
        api_containers = [
            item for item in containers or []
            if isinstance(item, dict) and item.get("name") == "api"
        ]
        if len(api_containers) != 1 or not DIGEST_RE.fullmatch(
            str(api_containers[0].get("imageDigest", ""))
        ):
            raise FullchatError("each API running task must expose one immutable api image digest")
        digests.add(str(api_containers[0]["imageDigest"]))
    if len(digests) != 1 or not DIGEST_RE.fullmatch(next(iter(digests))):
        raise FullchatError("API running tasks do not agree on one immutable image digest")
    digest = next(iter(digests))

    service_td_response = aws.describe_task_definition(str(service.get("taskDefinition", "")))
    service_td = service_td_response.get("taskDefinition") or {}
    if service_td.get("taskDefinitionArn") != service.get("taskDefinition"):
        raise FullchatError("served API task definition readback is not exact")
    service_containers = [
        item for item in service_td.get("containerDefinitions") or [] if item.get("name") == "api"
    ]
    if len(service_containers) != 1:
        raise FullchatError("served API task definition does not have one api container")
    served_source = source_commit(service_containers[0])

    response = aws.describe_task_definition(TASK_FAMILY)
    td = response.get("taskDefinition") or {}
    arn = str(td.get("taskDefinitionArn", ""))
    if not TD_ARN_RE.fullmatch(arn) or td.get("status") != "ACTIVE" or td.get("networkMode") != "awsvpc":
        raise FullchatError("qualified one-off task definition identity/runtime is not exact")
    if td.get("requiresCompatibilities") != ["FARGATE"]:
        raise FullchatError("qualified one-off is not the existing Fargate runtime")
    if (
        td.get("taskRoleArn") != service_td.get("taskRoleArn")
        or td.get("executionRoleArn") != service_td.get("executionRoleArn")
    ):
        raise FullchatError("qualified one-off does not reuse the served API task/execution roles")
    containers = td.get("containerDefinitions")
    if (
        not isinstance(containers, list)
        or len(containers) != 1
        or not isinstance(containers[0], dict)
        or containers[0].get("name") != CONTAINER
    ):
        raise FullchatError("qualified one-off must contain only the db-inspect container")
    container = containers[0]
    if container.get("entryPoint") not in (None, []):
        raise FullchatError("qualified one-off overrides the API image entrypoint")
    image = str(container.get("image", ""))
    if image != f"{IMAGE_REPOSITORY}@{digest}":
        raise FullchatError("qualified one-off is not pinned to the currently served API digest")
    one_off_secrets = unique_named_values(container.get("secrets"), "valueFrom", "qualified one-off secrets")
    served_secrets = unique_named_values(
        service_containers[0].get("secrets"), "valueFrom", "served API secrets"
    )
    if set(one_off_secrets) != DB_SECRET_NAMES or any(
        one_off_secrets[name] != served_secrets.get(name) for name in DB_SECRET_NAMES
    ):
        raise FullchatError("qualified one-off must reuse only the served API four-field DB credential mechanism")
    one_off_environment = unique_named_values(
        container.get("environment"), "value", "qualified one-off environment"
    )
    served_environment = unique_named_values(
        service_containers[0].get("environment"), "value", "served API environment"
    )
    if (
        set(one_off_secrets) & set(one_off_environment)
        or set(served_secrets) & set(served_environment)
        or DB_SECRET_NAMES & set(one_off_environment)
        or DB_SECRET_NAMES & set(served_environment)
        or "DB_NAME" in one_off_secrets
        or "DB_NAME" in served_secrets
    ):
        raise FullchatError("DB credential and name sources must be unique and disjoint from plaintext environment")
    if not one_off_environment.get("DB_NAME") or one_off_environment["DB_NAME"] != served_environment.get("DB_NAME"):
        raise FullchatError("qualified one-off does not reuse the served API DB_NAME")
    commit = source_commit(container)
    if commit != served_source:
        raise FullchatError("qualified one-off source commit differs from the currently served API image")
    validate_image_source(git, commit)
    logs = container.get("logConfiguration") or {}
    options = logs.get("options") or {}
    if logs.get("logDriver") != "awslogs" or not isinstance(options.get("awslogs-group"), str) or not isinstance(options.get("awslogs-stream-prefix"), str):
        raise FullchatError("qualified one-off does not use bounded awslogs output")
    return {
        "taskDefinition": arn,
        "image": image,
        "imageDigest": digest,
        "sourceCommit": commit,
        "network": network,
        "logGroup": options["awslogs-group"],
        "logPrefix": options["awslogs-stream-prefix"],
    }


def validate_runtime_build(runtime: Mapping[str, Any], proof: Mapping[str, Any]) -> None:
    record = proof.get("record")
    if not isinstance(record, dict):
        raise FullchatError("current API image build proof is absent")
    if (
        runtime.get("imageDigest") != record["image"]["digest"]
        or runtime.get("sourceCommit") != record["source"]["commit"]
        or runtime.get("image") != record["image"]["uri"]
    ):
        raise FullchatError("current served/diag runtime does not match the authenticated API image build record")


def command_for(mode: str, expected: Sequence[Mapping[str, Any]] | None) -> list[str]:
    command = ["set-tenant-flag", "--foundation-fullchat"]
    if mode == "plan":
        return command
    confirmation = APPLY_CONFIRMATION if mode == "apply" else ROLLBACK_CONFIRMATION
    return [*command, "--mode", mode, "--confirmation", confirmation, "--expected-state", state_token(expected or [])]


def wait_for_task(aws: AwsCli, arn: str, timeout: int) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = aws.describe_tasks((arn,))
        tasks = response.get("tasks") or []
        if response.get("failures") or len(tasks) != 1:
            raise FullchatError("one-off task readback was not exact")
        task = tasks[0]
        if task.get("lastStatus") == "STOPPED":
            return task
        time.sleep(min(10, max(0, deadline - time.monotonic())))
    raise FullchatError("one-off task did not stop within the bounded timeout")


def wait_for_log_messages(
    aws: AwsCli, group: str, stream: str, timeout: int = 90
) -> list[str]:
    deadline = time.monotonic() + timeout
    last_error: FullchatError | None = None
    while time.monotonic() < deadline:
        try:
            messages = aws.log_events(group, stream)
            if any(
                line.strip().startswith(RESULT_PREFIX)
                for message in messages
                for line in message.splitlines()
            ):
                return messages
        except FullchatError as exc:
            # awslogs stream creation/flush may lag the STOPPED task readback.
            last_error = exc
        time.sleep(min(5, max(0, deadline - time.monotonic())))
    detail = str(last_error) if last_error else "sanitized result was not flushed"
    raise FullchatError(f"bounded CloudWatch readback timed out: {detail}")


def parse_db_result(
    messages: Sequence[str], mode: str
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    lines = [line.strip() for message in messages for line in message.splitlines() if line.strip().startswith(RESULT_PREFIX)]
    if len(lines) != 1:
        raise FullchatError("one-off logs do not contain exactly one sanitized DB result")
    try:
        value = json.loads(lines[0][len(RESULT_PREFIX):])
    except json.JSONDecodeError as exc:
        raise FullchatError("sanitized DB result is invalid JSON") from exc
    expected_result = {"plan": "PLAN_ONLY", "apply": "APPLIED_AND_VERIFIED", "rollback": "ROLLED_BACK_AND_VERIFIED"}[mode]
    if (
        not isinstance(value, dict)
        or set(value) != DB_RESULT_KEYS
        or value.get("schemaVersion") != 1
        or value.get("operation") != "meri-foundation-fullchat"
        or value.get("mode") != mode
        or value.get("result") != expected_result
        or value.get("flag") != FLAG
    ):
        raise FullchatError("sanitized DB result does not match the requested operation")
    tenants = value.get("tenants")
    if not isinstance(tenants, list) or len(tenants) != 2:
        raise FullchatError("sanitized DB result does not contain both fixed tenants")
    before_values: list[dict[str, Any]] = []
    after_values: list[dict[str, Any]] = []
    for index, tenant in enumerate(tenants):
        tenant_id, slug = TENANTS[index]
        if not isinstance(tenant, dict) or set(tenant) != {"tenantId", "tenantSlug", "before", "after"}:
            raise FullchatError("sanitized DB result tenant shape is not exact")
        if tenant.get("tenantId") != tenant_id or tenant.get("tenantSlug") != slug:
            raise FullchatError("sanitized DB result tenant identity is not exact")
        before_state = validate_flag_state(tenant.get("before"), "DB result before")
        # Validate after independently without retaining any surrounding settings.
        state = validate_flag_state(tenant.get("after"), "DB result after")
        if mode == "apply" and state != {"present": True, "value": True}:
            raise FullchatError("apply DB readback is not literal boolean true")
        if mode == "plan" and state != tenant.get("before"):
            raise FullchatError("plan changed the DB flag state")
        identity = {"tenantId": tenant_id, "tenantSlug": slug, "flag": FLAG}
        before_values.append({**identity, "state": before_state})
        after_values.append({**identity, "state": state})
    sanitized = {
        "schemaVersion": 1,
        "operation": "meri-foundation-fullchat",
        "mode": mode,
        "result": expected_result,
        "flag": FLAG,
        "tenants": [
            {
                "tenantId": tenant_id,
                "tenantSlug": slug,
                "before": before_values[index]["state"],
                "after": after_values[index]["state"],
            }
            for index, (tenant_id, slug) in enumerate(TENANTS)
        ],
    }
    return sanitized, before_values, after_values


def base_receipt(
    mode: str,
    runtime: Mapping[str, Any],
    task_arn: str,
    build_proof: Mapping[str, Any],
) -> dict[str, Any]:
    run_id = os.environ.get("GITHUB_RUN_ID", "local")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "local")
    return {
        "schemaVersion": 1,
        "workflow": WORKFLOW_NAME,
        "workflowPath": WORKFLOW_PATH,
        "repository": REPOSITORY,
        "runId": run_id,
        "runAttempt": attempt,
        "artifactName": artifact_name(run_id, attempt) if INTEGER_RE.fullmatch(run_id) and INTEGER_RE.fullmatch(attempt) else f"{ARTIFACT_PREFIX}-{run_id}-{attempt}",
        "workflowSha": os.environ.get("GITHUB_SHA", "local"),
        "actor": os.environ.get("GITHUB_ACTOR", "local"),
        "actorId": os.environ.get("GITHUB_ACTOR_ID", "local"),
        "mode": mode,
        "result": "STARTED",
        "verified": False,
        "target": {"account": ACCOUNT_ID, "region": REGION, "cluster": CLUSTER},
        "flag": FLAG,
        "tenants": [{"tenantId": value[0], "tenantSlug": value[1]} for value in TENANTS],
        "qualifiedTaskDefinition": runtime["taskDefinition"],
        "imageDigest": runtime["imageDigest"],
        "imageSourceCommit": runtime["sourceCommit"],
        "taskArn": task_arn,
        "buildProof": dict(build_proof),
    }


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("plan", "apply", "rollback"), default="plan")
    parser.add_argument("--apply-confirmation", default="")
    parser.add_argument("--rollback-confirmation", default="")
    parser.add_argument("--source-run-id", default="")
    parser.add_argument("--source-run-attempt", default="")
    parser.add_argument("--build-run-id", default="")
    parser.add_argument("--build-run-attempt", default="")
    parser.add_argument("--artifact-selection", type=Path)
    parser.add_argument("--artifact-archive", type=Path)
    parser.add_argument("--build-artifact-selection", type=Path)
    parser.add_argument("--build-artifact-archive", type=Path)
    parser.add_argument("--select-source-artifact", action="store_true")
    parser.add_argument("--select-build-artifact", action="store_true")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--wait-timeout-seconds", type=int, default=900)
    return parser.parse_args(argv)


def load_json(path: Path | None, label: str) -> dict[str, Any]:
    if not path:
        raise FullchatError(f"{label} path is required")
    try:
        payload = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise FullchatError(f"{label} is unreadable") from exc
    value = strict_json_loads(payload, label)
    if not isinstance(value, dict):
        raise FullchatError(f"{label} has an unexpected shape")
    return value


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    receipt: dict[str, Any] | None = None
    try:
        git = GitCli()
        verify_execution_context(os.environ, git)
        if args.select_source_artifact or args.select_build_artifact:
            if args.select_source_artifact and args.select_build_artifact:
                raise FullchatError("select exactly one artifact type")
            github = GithubApi()
            if args.select_build_artifact:
                _, selected = github_artifact_selection(
                    github, args.build_run_id, args.build_run_attempt, True
                )
                output = args.build_artifact_selection
                label = "build artifact selection"
            else:
                _, selected = github_artifact_selection(
                    github, args.source_run_id, args.source_run_attempt, False
                )
                output = args.artifact_selection
                label = "source artifact selection"
            if not output:
                raise FullchatError(f"{label} output path is required")
            write_json(output, selected)
            print(f"Validated exact {label} ID {selected['artifactId']}.")
            return 0
        if not args.output_dir:
            raise FullchatError("output directory is required")
        if not 60 <= args.wait_timeout_seconds <= 1200:
            raise FullchatError("wait timeout must be between 60 and 1200 seconds")
        github = GithubApi()
        _, expected_build_selection = github_artifact_selection(
            github, args.build_run_id, args.build_run_attempt, True
        )
        build_selection = load_json(args.build_artifact_selection, "build artifact selection")
        if not args.build_artifact_archive:
            raise FullchatError("API image build record archive is required")
        build_proof = load_build_proof(
            args.build_artifact_archive, build_selection, expected_build_selection
        )
        source_selection: dict[str, Any] | None = None
        if args.mode == "plan":
            if any((args.apply_confirmation, args.rollback_confirmation, args.source_run_id, args.source_run_attempt)):
                raise FullchatError("plan accepts no mutation confirmation or source receipt")
            expected = None
        else:
            required = APPLY_CONFIRMATION if args.mode == "apply" else ROLLBACK_CONFIRMATION
            supplied = args.apply_confirmation if args.mode == "apply" else args.rollback_confirmation
            other = args.rollback_confirmation if args.mode == "apply" else args.apply_confirmation
            if supplied != required or other:
                raise FullchatError(f"{args.mode} requires only its exact fixed confirmation")
            run, validated = github_artifact_selection(
                github, args.source_run_id, args.source_run_attempt, False
            )
            source_selection = load_json(args.artifact_selection, "source artifact selection")
            if not args.artifact_archive:
                raise FullchatError("source receipt archive is required")
            source = load_source_receipt(args.artifact_archive, source_selection, validated)
            expected = validate_source_receipt(
                source, run, validated, "plan" if args.mode == "apply" else "apply"
            )
            source_proof = validate_bound_build_proof(
                source.get("buildProof"), source.get("imageDigest"), source.get("imageSourceCommit")
            )
            if args.mode == "apply" and source_proof != build_proof:
                raise FullchatError("apply current build proof differs from the receipt-bound plan")
        aws = AwsCli()
        if aws.identity().get("Account") != ACCOUNT_ID:
            raise FullchatError("OIDC credentials are not for the fixed dev account")
        runtime = capture_runtime(aws, git)
        validate_runtime_build(runtime, build_proof)
        run_id = os.environ.get("GITHUB_RUN_ID", "local")
        attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "local")
        started_by = f"meri-fullchat-{run_id}-{attempt}-{args.mode}"
        if len(started_by) > 36 or not re.fullmatch(r"[A-Za-z0-9_-]+", started_by):
            raise FullchatError("workflow run identity cannot form a bounded ECS startedBy token")
        task_arn = aws.run_task(runtime["taskDefinition"], runtime["network"], command_for(args.mode, expected), started_by)
        if not TASK_ARN_RE.fullmatch(task_arn):
            raise FullchatError("run-task returned a task outside the fixed cluster/account/region")
        receipt = base_receipt(args.mode, runtime, task_arn, build_proof)
        if args.mode != "plan":
            assert source_selection is not None
            receipt["sourceRunId"] = args.source_run_id
            receipt["sourceRunAttempt"] = args.source_run_attempt
            receipt["sourceArtifactDigest"] = source_selection["archiveDigest"]
        task = wait_for_task(aws, task_arn, args.wait_timeout_seconds)
        if (
            task.get("taskArn") != task_arn
            or task.get("clusterArn") != f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:cluster/{CLUSTER}"
            or task.get("taskDefinitionArn") != runtime["taskDefinition"]
            or task.get("startedBy") != started_by
            or task.get("launchType") != "FARGATE"
        ):
            raise FullchatError("stopped task identity/runtime does not match the exact launch")
        containers = task.get("containers")
        if (
            not isinstance(containers, list)
            or len(containers) != 1
            or not isinstance(containers[0], dict)
            or containers[0].get("name") != CONTAINER
            or containers[0].get("lastStatus") != "STOPPED"
            or containers[0].get("exitCode") != 0
            or containers[0].get("image") != runtime["image"]
            or containers[0].get("imageDigest") != runtime["imageDigest"]
            or task.get("stopCode") not in (None, "EssentialContainerExited")
        ):
            raise FullchatError("one-off task container set/status/image/exit readback is not exact")
        task_id = task_arn.rsplit("/", 1)[-1]
        stream = f"{runtime['logPrefix']}/{CONTAINER}/{task_id}"
        db_result, before_values, after_values = parse_db_result(
            wait_for_log_messages(aws, runtime["logGroup"], stream), args.mode
        )
        if args.mode == "apply" and before_values != expected:
            raise FullchatError("apply DB prior state differs from the receipt-bound plan")
        if args.mode == "rollback" and after_values != expected:
            raise FullchatError("rollback DB readback did not restore the receipt-bound prior state")
        receipt["priorStates"] = expected if args.mode == "rollback" else before_values
        receipt["readback"] = db_result
        receipt["result"] = {"plan": "PLANNED_AND_VERIFIED", "apply": "APPLIED_AND_VERIFIED", "rollback": "ROLLED_BACK_AND_VERIFIED"}[args.mode]
        receipt["verified"] = True
        write_json(args.output_dir / "receipt.json", receipt)
        print(f"Fixed foundation fullChat {args.mode} completed with exact sanitized DB readback.")
        return 0
    except BaseException as exc:
        if receipt is not None and args.output_dir:
            receipt["result"] = "FAILED"
            receipt["error"] = str(exc)[:500] if isinstance(exc, FullchatError) else "unexpected internal failure"
            write_json(args.output_dir / "receipt.json", receipt)
        message = str(exc)[:500] if isinstance(exc, FullchatError) else "unexpected internal failure"
        print(f"REFUSED: {message}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
