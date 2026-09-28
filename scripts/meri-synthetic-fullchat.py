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
IMAGE_REPOSITORY = f"{ACCOUNT_ID}.dkr.ecr.{REGION}.amazonaws.com/capiro/dev/api"
FLAG = "meriv3.fullChat"
TENANTS = (
    ("f2d6cf8f-057c-479a-8110-62fe5086d43f", "meri-foundation-20260928-t1"),
    ("52e91176-08f-4d89-9633-bc212f5bdbbf", "meri-foundation-20260928-t2"),
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


class FullchatError(RuntimeError):
    pass


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


def artifact_name(run_id: str, attempt: str) -> str:
    if not INTEGER_RE.fullmatch(run_id) or not INTEGER_RE.fullmatch(attempt):
        raise FullchatError("run ID and attempt must be positive decimal integers")
    return f"{ARTIFACT_PREFIX}-{run_id}-{attempt}"


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


def load_source_receipt(
    archive: Path,
    selection: Mapping[str, Any],
    expected_selection: Mapping[str, Any],
) -> dict[str, Any]:
    if dict(selection) != dict(expected_selection):
        raise FullchatError("artifact selection changed after validation")
    if not archive.is_file() or not 0 < archive.stat().st_size <= MAX_ARCHIVE_BYTES:
        raise FullchatError("receipt archive is absent or oversized")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if f"sha256:{digest}" != selection.get("archiveDigest"):
        raise FullchatError("receipt archive digest does not match GitHub metadata")
    try:
        with zipfile.ZipFile(archive) as value:
            entries = value.infolist()
            if len(entries) != 1 or entries[0].filename != "receipt.json":
                raise FullchatError("receipt archive must contain only receipt.json")
            entry = entries[0]
            mode = (entry.external_attr >> 16) & 0o170000
            if entry.is_dir() or mode == 0o120000 or entry.flag_bits & 1 or not 0 < entry.file_size <= MAX_RECEIPT_BYTES:
                raise FullchatError("receipt archive entry is unsafe")
            receipt = json.loads(value.read(entry).decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, zipfile.BadZipFile) as exc:
        raise FullchatError("receipt archive is unreadable") from exc
    if not isinstance(receipt, dict):
        raise FullchatError("source receipt has an unexpected shape")
    return receipt


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


def validate_source_receipt(
    receipt: Mapping[str, Any],
    run: Mapping[str, Any],
    selection: Mapping[str, Any],
    expected_mode: str,
) -> list[dict[str, Any]]:
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
    environment = container.get("environment") or []
    for item in environment:
        if item.get("name") in ("GIT_SHA", "RELEASE_SHA", "SOURCE_COMMIT"):
            value = str(item.get("value", "")).lower()
            if SHA_RE.fullmatch(value):
                candidates.add(value)
    if len(candidates) != 1:
        raise FullchatError("qualified image must expose one exact 40-character source commit")
    return next(iter(candidates))


def validate_image_source(git: GitCli, sha: str) -> None:
    git.run(("cat-file", "-e", f"{sha}^{{commit}}"))
    git.run(("merge-base", "--is-ancestor", sha, "origin/main"))
    for path in REGISTER_SOURCE_FILES:
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
    digests = {
        str(container.get("imageDigest"))
        for task in tasks
        for container in task.get("containers", [])
        if container.get("name") == "api"
    }
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
    containers = [item for item in td.get("containerDefinitions") or [] if item.get("name") == CONTAINER]
    if len(containers) != 1:
        raise FullchatError("qualified one-off does not have one db-inspect container")
    container = containers[0]
    if container.get("entryPoint") not in (None, []):
        raise FullchatError("qualified one-off overrides the API image entrypoint")
    image = str(container.get("image", ""))
    if image != f"{IMAGE_REPOSITORY}@{digest}":
        raise FullchatError("qualified one-off is not pinned to the currently served API digest")
    one_off_secrets = {
        item.get("name"): item.get("valueFrom") for item in container.get("secrets") or []
    }
    served_secrets = {
        item.get("name"): item.get("valueFrom") for item in service_containers[0].get("secrets") or []
    }
    required_db_secrets = {"DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD"}
    if set(one_off_secrets) != required_db_secrets or any(
        one_off_secrets[name] != served_secrets.get(name) for name in required_db_secrets
    ):
        raise FullchatError("qualified one-off must reuse only the served API four-field DB credential mechanism")
    one_off_environment = {
        item.get("name"): item.get("value") for item in container.get("environment") or []
    }
    served_environment = {
        item.get("name"): item.get("value") for item in service_containers[0].get("environment") or []
    }
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
        "imageDigest": digest,
        "sourceCommit": commit,
        "network": network,
        "logGroup": options["awslogs-group"],
        "logPrefix": options["awslogs-stream-prefix"],
    }


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
    return value, before_values, after_values


def base_receipt(mode: str, runtime: Mapping[str, Any], task_arn: str) -> dict[str, Any]:
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
    parser.add_argument("--run-metadata", type=Path)
    parser.add_argument("--artifact-metadata", type=Path)
    parser.add_argument("--artifact-selection", type=Path)
    parser.add_argument("--artifact-archive", type=Path)
    parser.add_argument("--select-source-artifact", action="store_true")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--wait-timeout-seconds", type=int, default=900)
    return parser.parse_args(argv)


def load_json(path: Path | None, label: str) -> dict[str, Any]:
    if not path:
        raise FullchatError(f"{label} path is required")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FullchatError(f"{label} is unreadable") from exc
    if not isinstance(value, dict):
        raise FullchatError(f"{label} has an unexpected shape")
    return value


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    receipt: dict[str, Any] | None = None
    try:
        git = GitCli()
        verify_execution_context(os.environ, git)
        if args.select_source_artifact:
            run = load_json(args.run_metadata, "run metadata")
            artifacts = load_json(args.artifact_metadata, "artifact metadata")
            selected = select_artifact(args.source_run_id, args.source_run_attempt, run, artifacts)
            if not args.artifact_selection:
                raise FullchatError("artifact selection output path is required")
            write_json(args.artifact_selection, selected)
            print(f"Validated exact source artifact ID {selected['artifactId']}.")
            return 0
        if not args.output_dir:
            raise FullchatError("output directory is required")
        if not 60 <= args.wait_timeout_seconds <= 1200:
            raise FullchatError("wait timeout must be between 60 and 1200 seconds")
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
            run = load_json(args.run_metadata, "run metadata")
            artifacts = load_json(args.artifact_metadata, "artifact metadata")
            selection = load_json(args.artifact_selection, "artifact selection")
            validated = select_artifact(args.source_run_id, args.source_run_attempt, run, artifacts)
            source = load_source_receipt(args.artifact_archive, selection, validated) if args.artifact_archive else None
            if source is None:
                raise FullchatError("source receipt archive is required")
            expected = validate_source_receipt(
                source, run, validated, "plan" if args.mode == "apply" else "apply"
            )
        aws = AwsCli()
        if aws.identity().get("Account") != ACCOUNT_ID:
            raise FullchatError("OIDC credentials are not for the fixed dev account")
        runtime = capture_runtime(aws, git)
        run_id = os.environ.get("GITHUB_RUN_ID", "local")
        attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "local")
        started_by = f"meri-fullchat-{run_id}-{attempt}-{args.mode}"
        if len(started_by) > 36 or not re.fullmatch(r"[A-Za-z0-9_-]+", started_by):
            raise FullchatError("workflow run identity cannot form a bounded ECS startedBy token")
        task_arn = aws.run_task(runtime["taskDefinition"], runtime["network"], command_for(args.mode, expected), started_by)
        if not TASK_ARN_RE.fullmatch(task_arn):
            raise FullchatError("run-task returned a task outside the fixed cluster/account/region")
        receipt = base_receipt(args.mode, runtime, task_arn)
        if args.mode != "plan":
            receipt["sourceRunId"] = args.source_run_id
            receipt["sourceRunAttempt"] = args.source_run_attempt
            receipt["sourceArtifactDigest"] = selection["archiveDigest"]
        task = wait_for_task(aws, task_arn, args.wait_timeout_seconds)
        if (
            task.get("taskArn") != task_arn
            or task.get("clusterArn") != f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:cluster/{CLUSTER}"
            or task.get("taskDefinitionArn") != runtime["taskDefinition"]
            or task.get("startedBy") != started_by
            or task.get("launchType") != "FARGATE"
        ):
            raise FullchatError("stopped task identity/runtime does not match the exact launch")
        containers = [item for item in task.get("containers") or [] if item.get("name") == CONTAINER]
        if (
            len(containers) != 1
            or containers[0].get("exitCode") != 0
            or containers[0].get("imageDigest") != runtime["imageDigest"]
            or task.get("stopCode") not in (None, "EssentialContainerExited")
        ):
            raise FullchatError("one-off task did not exit zero through the expected container")
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
