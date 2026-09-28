#!/usr/bin/env python3
"""Plan/apply a narrowly bounded ECS configuration-only Meri synthetic cohort change.

The implementation intentionally shells out only to the AWS CLI. It never builds an
image, changes a database, runs a task, deploys infrastructure, or reads secret values.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

ACCOUNT_ID = "967807252336"
REGION = "us-east-1"
CLUSTER = "capiro-dev"
REPOSITORY = "neo-capiro/capirov2"
WORKFLOW_PATH = ".github/workflows/meri-synthetic-cohort.yml"
WORKFLOW_NAME = "meri-synthetic-cohort"
ARTIFACT_NAME = "synthetic-cohort-receipt"
ENV_NAME = "MERIV3_CANARY_TENANT_SLUGS"
TENANTS = ("meri-foundation-20260928-t1", "meri-foundation-20260928-t2")
EXISTING_COHORT = (
    "c2-strategies",
    "capiro-internal",
    "dualsight",
    "maven",
    "prospering-solutions",
    "revere",
    "victory-six-advisors",
    "rubin-turnbull",
    "abramoff",
)
EXPECTED = {
    "capiro-dev-api": {
        "taskDefinition": "capiro-dev-api:483",
        "digest": "sha256:640f76d01bd6d0b7658f1229aee90cd7979c75d8b0f7ab7df76a5d5b7abc3c68",
        "sourceSha": "42942dedad59382f4b4aac6f904b9aee0e02efa6",
        "repository": "capiro/dev/api",
        "pinImage": True,
    },
    "capiro-dev-meriv2-orchestrator": {
        "taskDefinition": "capiro-dev-meriv2-orchestrator:84",
        "digest": "sha256:227550d5862037ef026b04e3a7cb8f77e3c3467f409e3ab5144ad0ce725018de",
        "sourceSha": "c2bc41a86ef087e4b163c556595507ec08b396cf",
        "repository": "capiro/dev/meriv2-orchestrator",
        "pinImage": False,
    },
}
SERVICES = tuple(EXPECTED)
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
TD_ARN_RE = re.compile(
    rf"^arn:aws:ecs:{REGION}:{ACCOUNT_ID}:task-definition/"
    r"(?P<family>capiro-dev-(?:api|meriv2-orchestrator)):(?P<revision>[1-9][0-9]*)$"
)
SOURCE_LABEL_KEYS = (
    "org.opencontainers.image.revision",
    "git.commit",
    "git.sha",
    "commit",
    "source_sha",
    "SOURCE_COMMIT",
)
REGISTERABLE_FIELDS = (
    "family",
    "taskRoleArn",
    "executionRoleArn",
    "networkMode",
    "containerDefinitions",
    "volumes",
    "placementConstraints",
    "requiresCompatibilities",
    "cpu",
    "memory",
    "pidMode",
    "ipcMode",
    "proxyConfiguration",
    "inferenceAccelerators",
    "ephemeralStorage",
    "runtimePlatform",
    "enableFaultInjection",
)


class ReleaseError(RuntimeError):
    """An expected guardrail refusal safe to show in logs and receipts."""


class AwsCli:
    def __init__(self, region: str = REGION) -> None:
        self.region = region

    def _json(self, args: Sequence[str]) -> dict[str, Any]:
        command = ["aws", *args, "--region", self.region, "--output", "json", "--no-cli-pager"]
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            operation = " ".join(args[:2])
            raise ReleaseError(f"AWS CLI operation failed: {operation}")
        try:
            value = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise ReleaseError("AWS CLI returned invalid JSON") from exc
        if not isinstance(value, dict):
            raise ReleaseError("AWS CLI returned an unexpected JSON shape")
        return value

    def identity(self) -> dict[str, Any]:
        return self._json(["sts", "get-caller-identity"])

    def describe_services(self, services: Sequence[str]) -> dict[str, Any]:
        return self._json(
            ["ecs", "describe-services", "--cluster", CLUSTER, "--services", *services]
        )

    def describe_task_definition(self, task_definition: str) -> dict[str, Any]:
        return self._json(
            ["ecs", "describe-task-definition", "--task-definition", task_definition, "--include", "TAGS"]
        )

    def list_tasks(self, service: str) -> list[str]:
        value = self._json(
            [
                "ecs",
                "list-tasks",
                "--cluster",
                CLUSTER,
                "--service-name",
                service,
                "--desired-status",
                "RUNNING",
            ]
        )
        return list(value.get("taskArns", []))

    def describe_tasks(self, task_arns: Sequence[str]) -> dict[str, Any]:
        if not task_arns:
            return {"tasks": [], "failures": []}
        return self._json(["ecs", "describe-tasks", "--cluster", CLUSTER, "--tasks", *task_arns])

    def register_task_definition(self, request: Mapping[str, Any]) -> str:
        fd, filename = tempfile.mkstemp(prefix="meri-cohort-td-", suffix=".json")
        try:
            os.chmod(filename, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(request, handle, separators=(",", ":"))
            value = self._json(
                ["ecs", "register-task-definition", "--cli-input-json", f"file://{filename}"]
            )
        finally:
            try:
                os.unlink(filename)
            except FileNotFoundError:
                pass
        arn = value.get("taskDefinition", {}).get("taskDefinitionArn")
        if not isinstance(arn, str):
            raise ReleaseError("register-task-definition did not return an ARN")
        return arn

    def update_service(self, service: str, task_definition: str) -> None:
        self._json(
            [
                "ecs",
                "update-service",
                "--cluster",
                CLUSTER,
                "--service",
                service,
                "--task-definition",
                task_definition,
            ]
        )

class GitCli:
    def __init__(self, cwd: Path | None = None) -> None:
        self.cwd = cwd

    def run(self, args: Sequence[str]) -> str:
        completed = subprocess.run(
            ["git", *args], cwd=self.cwd, capture_output=True, text=True, check=False
        )
        if completed.returncode != 0:
            raise ReleaseError(f"Git provenance check failed: {' '.join(args[:2])}")
        return completed.stdout.strip()


def short_td(task_definition: str) -> str:
    return task_definition.rsplit("/", 1)[-1]


def full_td(task_definition: str) -> str:
    if task_definition.startswith("arn:"):
        return task_definition
    return f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:task-definition/{task_definition}"


def image_repository(image: str) -> str:
    without_digest = image.split("@", 1)[0]
    leaf = without_digest.rsplit("/", 1)[-1]
    if ":" in leaf:
        return without_digest.rsplit(":", 1)[0]
    return without_digest


def ecr_repository_name(image: str) -> str:
    repository = image_repository(image)
    marker = f"{ACCOUNT_ID}.dkr.ecr.{REGION}.amazonaws.com/"
    if not repository.startswith(marker):
        raise ReleaseError("target image is not in the fixed dev account and region ECR registry")
    name = repository[len(marker) :]
    if not name or ".." in name:
        raise ReleaseError("target ECR repository name is invalid")
    return name


def pin_image(image: str, digest: str) -> str:
    if not DIGEST_RE.fullmatch(digest):
        raise ReleaseError("observed image digest has an invalid shape")
    return f"{image_repository(image)}@{digest}"


def require_fixed_inputs(args: argparse.Namespace) -> None:
    values = tuple(item.strip() for item in args.tenant_slugs.split(",") if item.strip())
    if values != TENANTS:
        raise ReleaseError("tenant slug confirmation must contain the two approved slugs in fixed order")
    cohort = tuple(item.strip() for item in args.expected_existing_cohort.split(",") if item.strip())
    if cohort != EXISTING_COHORT:
        raise ReleaseError("expected existing cohort does not exactly match the approved nine-slug baseline")
    supplied = {
        "capiro-dev-api": (args.expected_api_task_definition, args.expected_api_digest),
        "capiro-dev-meriv2-orchestrator": (
            args.expected_orchestrator_task_definition,
            args.expected_orchestrator_digest,
        ),
    }
    for service, (task_definition, digest) in supplied.items():
        expected = EXPECTED[service]
        if task_definition != expected["taskDefinition"] or digest != expected["digest"]:
            raise ReleaseError(f"{service} expected task definition or digest differs from reviewed proposal")
    if args.mode in ("apply", "rollback"):
        if args.lead_preflight_confirmation != "LEAD_CONFIRMED_DB_FLAGS_AND_RESEARCH_DRAIN":
            raise ReleaseError("apply/rollback requires the fixed lead DB and active-research preflight confirmation")
        if not args.lead_preflight_receipt.strip():
            raise ReleaseError("apply/rollback requires a non-secret lead preflight receipt reference")
    if args.mode == "apply" and args.apply_confirmation != "ENABLE_FIXED_SYNTHETIC_MERI_COHORT":
        raise ReleaseError("apply requires the fixed explicit apply confirmation")
    if args.mode == "rollback" and args.rollback_confirmation != "ROLLBACK_FIXED_SYNTHETIC_MERI_COHORT":
        raise ReleaseError("rollback requires the fixed explicit rollback confirmation")


def verify_execution_context(
    env: Mapping[str, str], git: GitCli, source_shas: Sequence[str] | None = None
) -> None:
    if env.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise ReleaseError("workflow repository is not the fixed neo-capiro/capirov2 repository")
    if env.get("GITHUB_EVENT_NAME") != "workflow_dispatch":
        raise ReleaseError("only workflow_dispatch execution is allowed")
    if env.get("GITHUB_REF") != "refs/heads/main":
        raise ReleaseError("workflow must be dispatched from main")
    workflow_ref = env.get("GITHUB_WORKFLOW_REF", "")
    if not workflow_ref.endswith(f"/{WORKFLOW_PATH}@refs/heads/main"):
        raise ReleaseError("workflow file must be the merged main copy")
    head = git.run(["rev-parse", "HEAD"])
    if head != env.get("GITHUB_SHA"):
        raise ReleaseError("checked out HEAD does not equal the workflow SHA")
    if git.run(["rev-parse", "origin/main"]) != head:
        raise ReleaseError("checked out workflow SHA is not current origin/main")
    if git.run(["rev-parse", "--is-shallow-repository"]) != "false":
        raise ReleaseError("checked out repository does not contain complete fetched history")
    git.run(["cat-file", "-e", f"HEAD:{WORKFLOW_PATH}"])
    ancestry = source_shas or tuple(str(item["sourceSha"]) for item in EXPECTED.values())
    for source_sha in ancestry:
        git.run(["merge-base", "--is-ancestor", source_sha, "origin/main"])


def relevant_source_label(container: Mapping[str, Any], expected_sha: str) -> str | None:
    labels = container.get("dockerLabels") or {}
    if not isinstance(labels, dict):
        raise ReleaseError("target container dockerLabels has an unexpected shape")
    found: list[str] = []
    for key in SOURCE_LABEL_KEYS:
        if key in labels:
            found.append(key)
            value = str(labels[key]).lower()
            if not (value == expected_sha or (len(value) >= 7 and expected_sha.startswith(value))):
                raise ReleaseError("captured image source-commit label does not match the reviewed source SHA")
    return ",".join(found) if found else None


def assert_service_shape(service: Mapping[str, Any], expected_td: str) -> None:
    service_name = service.get("serviceName")
    if service_name not in SERVICES:
        raise ReleaseError("AWS returned an unapproved ECS service")
    expected_cluster_arn = f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:cluster/{CLUSTER}"
    expected_service_arn = (
        f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:service/{CLUSTER}/{service_name}"
    )
    if service.get("clusterArn") != expected_cluster_arn:
        raise ReleaseError("AWS returned a service outside the fixed cluster")
    if service.get("serviceArn") != expected_service_arn:
        raise ReleaseError("AWS returned a service outside the fixed account/region target")
    if str(service.get("taskDefinition", "")) != full_td(expected_td):
        raise ReleaseError(f"{service.get('serviceName')} task definition drifted")
    if service.get("desiredCount", 0) <= 0:
        raise ReleaseError(f"{service.get('serviceName')} has no desired running tasks")
    if service.get("runningCount") != service.get("desiredCount") or service.get("pendingCount") != 0:
        raise ReleaseError(f"{service.get('serviceName')} is not at steady task counts")
    deployments = list(service.get("deployments") or [])
    primary = [item for item in deployments if item.get("status") == "PRIMARY"]
    if len(primary) != 1:
        raise ReleaseError(f"{service.get('serviceName')} does not have exactly one PRIMARY deployment")
    current = primary[0]
    if str(current.get("taskDefinition", "")) != full_td(expected_td):
        raise ReleaseError(f"{service.get('serviceName')} PRIMARY deployment drifted")
    if current.get("rolloutState") not in (None, "COMPLETED"):
        raise ReleaseError(f"{service.get('serviceName')} has a concurrent deployment")
    for deployment in deployments:
        if deployment is current:
            continue
        if any(int(deployment.get(key, 0)) != 0 for key in ("desiredCount", "runningCount", "pendingCount")):
            raise ReleaseError(f"{service.get('serviceName')} has a concurrent deployment")


def find_target_container(
    task_definition: Mapping[str, Any], tasks: Sequence[Mapping[str, Any]], expected_digest: str
) -> str:
    if not tasks:
        raise ReleaseError("service has no running tasks to prove the image digest")
    names: set[str] = set()
    for task in tasks:
        if task.get("lastStatus") != "RUNNING" or task.get("desiredStatus") != "RUNNING":
            raise ReleaseError("service returned a non-running task in the RUNNING set")
        matches = [
            container
            for container in task.get("containers", [])
            if container.get("imageDigest") == expected_digest
        ]
        if len(matches) != 1 or not isinstance(matches[0].get("name"), str):
            raise ReleaseError("running task does not have exactly one container at the reviewed digest")
        names.add(matches[0]["name"])
    if len(names) != 1:
        raise ReleaseError("running tasks disagree on the target container name")
    name = next(iter(names))
    definitions = [item for item in task_definition.get("containerDefinitions", []) if item.get("name") == name]
    if len(definitions) != 1:
        raise ReleaseError("task definition does not have exactly one matching target container")
    return name


def read_cohort(container: Mapping[str, Any]) -> tuple[str, ...]:
    environment = container.get("environment") or []
    matches = [item for item in environment if item.get("name") == ENV_NAME]
    if len(matches) != 1 or not isinstance(matches[0].get("value"), str):
        raise ReleaseError(f"target container must contain exactly one {ENV_NAME} value")
    return tuple(item.strip() for item in matches[0]["value"].split(",") if item.strip())


def task_registration_request(response: Mapping[str, Any]) -> dict[str, Any]:
    task_definition = response.get("taskDefinition")
    if not isinstance(task_definition, dict):
        raise ReleaseError("describe-task-definition omitted taskDefinition")
    request = {key: copy.deepcopy(task_definition[key]) for key in REGISTERABLE_FIELDS if key in task_definition}
    tags = response.get("tags")
    if tags is not None:
        if not isinstance(tags, list):
            raise ReleaseError("task definition tags have an unexpected shape")
        request["tags"] = copy.deepcopy(tags)
    return request


def transform_task_definition(
    response: Mapping[str, Any], service: str, target_container_name: str
) -> dict[str, Any]:
    request = task_registration_request(response)
    containers = request.get("containerDefinitions") or []
    targets = [container for container in containers if container.get("name") == target_container_name]
    if len(targets) != 1:
        raise ReleaseError("target container became ambiguous during transformation")
    target = targets[0]
    if read_cohort(target) != EXISTING_COHORT:
        raise ReleaseError(f"{service} existing cohort differs from the exact reviewed baseline")
    for item in target["environment"]:
        if item.get("name") == ENV_NAME:
            item["value"] = ",".join((*EXISTING_COHORT, *TENANTS))
    expected_digest = EXPECTED[service]["digest"]
    image = str(target.get("image", ""))
    if ecr_repository_name(image) != EXPECTED[service]["repository"]:
        raise ReleaseError(f"{service} image repository is not the fixed reviewed repository")
    if EXPECTED[service]["pinImage"]:
        if not image.endswith(":latest"):
            raise ReleaseError("API source task definition is not the reviewed :latest shape")
        target["image"] = pin_image(image, expected_digest)
    elif not image.endswith(f"@{expected_digest}"):
        raise ReleaseError("orchestrator source task definition is not already digest pinned")
    return request


def transform_rollback_task_definition(
    response: Mapping[str, Any], service: str, target_container_name: str
) -> dict[str, Any]:
    request = task_registration_request(response)
    containers = request.get("containerDefinitions") or []
    targets = [container for container in containers if container.get("name") == target_container_name]
    if len(targets) != 1:
        raise ReleaseError("rollback target container became ambiguous during transformation")
    target = targets[0]
    if read_cohort(target) != EXISTING_COHORT:
        raise ReleaseError(f"{service} rollback cohort differs from the exact reviewed baseline")
    image = str(target.get("image", ""))
    if ecr_repository_name(image) != EXPECTED[service]["repository"]:
        raise ReleaseError(f"{service} rollback image repository is not the fixed reviewed repository")
    digest = str(EXPECTED[service]["digest"])
    if service == "capiro-dev-api":
        if not image.endswith(":latest"):
            raise ReleaseError("API prior task definition is not the reviewed :latest shape")
        target["image"] = pin_image(image, digest)
    elif not image.endswith(f"@{digest}"):
        raise ReleaseError("orchestrator rollback image is not already digest pinned")
    return request


def find_config_target(response: Mapping[str, Any], service: str) -> str:
    task_definition = response.get("taskDefinition") or {}
    matches: list[str] = []
    for container in task_definition.get("containerDefinitions") or []:
        try:
            cohort_value = read_cohort(container)
            repository = ecr_repository_name(str(container.get("image", "")))
        except ReleaseError:
            continue
        if cohort_value == EXISTING_COHORT and repository == EXPECTED[service]["repository"]:
            name = container.get("name")
            if isinstance(name, str):
                matches.append(name)
    if len(matches) != 1:
        raise ReleaseError(f"{service} reviewed prior target container is not exact")
    return matches[0]


def assert_only_approved_changes(
    before_response: Mapping[str, Any], after_request: Mapping[str, Any], target_name: str, service: str
) -> None:
    expected = task_registration_request(before_response)
    before_containers = expected["containerDefinitions"]
    after_containers = after_request["containerDefinitions"]
    if len(before_containers) != len(after_containers):
        raise ReleaseError("task definition container count changed")
    before_target = next(item for item in before_containers if item.get("name") == target_name)
    after_target = next(item for item in after_containers if item.get("name") == target_name)
    for item in before_target["environment"]:
        if item.get("name") == ENV_NAME:
            item["value"] = ",".join((*EXISTING_COHORT, *TENANTS))
    if EXPECTED[service]["pinImage"]:
        before_target["image"] = pin_image(str(before_target["image"]), EXPECTED[service]["digest"])
    if expected != after_request:
        raise ReleaseError("derived task definition changed fields outside the approved cohort/image pin")


def assert_only_rollback_changes(
    before_response: Mapping[str, Any], after_request: Mapping[str, Any], target_name: str, service: str
) -> None:
    expected = task_registration_request(before_response)
    target = next(
        item for item in expected["containerDefinitions"] if item.get("name") == target_name
    )
    if service == "capiro-dev-api":
        target["image"] = pin_image(str(target["image"]), str(EXPECTED[service]["digest"]))
    if expected != after_request:
        raise ReleaseError("derived rollback task definition changed unapproved fields")


def capture_snapshot(aws: AwsCli, expected_tds: Mapping[str, str], expected_digests: Mapping[str, str]) -> dict[str, Any]:
    described = aws.describe_services(SERVICES)
    if described.get("failures"):
        raise ReleaseError("describe-services returned failures")
    services = described.get("services") or []
    if len(services) != len(SERVICES):
        raise ReleaseError("describe-services did not return both fixed targets")
    by_name = {item.get("serviceName"): item for item in services}
    if set(by_name) != set(SERVICES):
        raise ReleaseError("describe-services returned an unexpected target set")
    snapshot: dict[str, Any] = {}
    for name in SERVICES:
        service = by_name[name]
        assert_service_shape(service, expected_tds[name])
        td_response = aws.describe_task_definition(str(service["taskDefinition"]))
        td = td_response.get("taskDefinition") or {}
        if str(td.get("taskDefinitionArn", "")) != full_td(expected_tds[name]):
            raise ReleaseError(f"{name} described task definition does not match its service")
        if td.get("family") != name:
            raise ReleaseError(f"{name} task definition family is not exact")
        task_arns = aws.list_tasks(name)
        task_response = aws.describe_tasks(task_arns)
        if task_response.get("failures"):
            raise ReleaseError(f"{name} describe-tasks returned failures")
        tasks = task_response.get("tasks") or []
        if len(tasks) != service.get("runningCount"):
            raise ReleaseError(f"{name} running task count changed during capture")
        for task in tasks:
            expected_task_prefix = (
                f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:task/{CLUSTER}/"
            )
            if not str(task.get("taskArn", "")).startswith(expected_task_prefix):
                raise ReleaseError(f"{name} returned a task outside the fixed account/region/cluster")
            if str(task.get("taskDefinitionArn", "")) != full_td(expected_tds[name]):
                raise ReleaseError(f"{name} has a running task on an unexpected task definition")
        target_name = find_target_container(td, tasks, expected_digests[name])
        target = next(item for item in td["containerDefinitions"] if item.get("name") == target_name)
        cohort = read_cohort(target)
        label = relevant_source_label(target, EXPECTED[name]["sourceSha"])
        snapshot[name] = {
            "service": copy.deepcopy(service),
            "taskDefinitionResponse": copy.deepcopy(td_response),
            "tasks": copy.deepcopy(tasks),
            "targetContainer": target_name,
            "cohort": cohort,
            "sourceLabelKeys": label,
        }
    return snapshot


def snapshot_fingerprint(snapshot: Mapping[str, Any]) -> str:
    bounded: dict[str, Any] = {}
    for name in SERVICES:
        item = snapshot[name]
        bounded[name] = {
            "taskDefinition": short_td(item["service"]["taskDefinition"]),
            "desired": item["service"]["desiredCount"],
            "running": item["service"]["runningCount"],
            "pending": item["service"]["pendingCount"],
            "deployments": [
                {
                    "status": dep.get("status"),
                    "taskDefinition": short_td(str(dep.get("taskDefinition", ""))),
                    "rolloutState": dep.get("rolloutState"),
                    "desired": dep.get("desiredCount"),
                    "running": dep.get("runningCount"),
                    "pending": dep.get("pendingCount"),
                }
                for dep in item["service"].get("deployments", [])
            ],
            "tasks": sorted(task.get("taskArn", "") for task in item["tasks"]),
        }
    return hashlib.sha256(json.dumps(bounded, sort_keys=True).encode()).hexdigest()


def make_plan(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    services: list[dict[str, Any]] = []
    for name in SERVICES:
        item = snapshot[name]
        services.append(
            {
                "service": name,
                "taskDefinitionBefore": short_td(item["service"]["taskDefinition"]),
                "runningTaskCount": len(item["tasks"]),
                "verifiedDigest": EXPECTED[name]["digest"],
                "sourceCommit": EXPECTED[name]["sourceSha"],
                "sourceCommitLabel": item["sourceLabelKeys"] or "not-present-in-ecs-task-definition",
                "changes": [
                    {
                        "field": f"containerDefinitions[{item['targetContainer']}].environment.{ENV_NAME}",
                        "before": ",".join(EXISTING_COHORT),
                        "after": ",".join((*EXISTING_COHORT, *TENANTS)),
                    },
                    *(
                        [
                            {
                                "field": f"containerDefinitions[{item['targetContainer']}].image",
                                "before": "ECR :latest (running digest verified)",
                                "after": f"same ECR repository@{EXPECTED[name]['digest']}",
                            }
                        ]
                        if EXPECTED[name]["pinImage"]
                        else []
                    ),
                ],
            }
        )
    return {
        "schemaVersion": 1,
        "status": "VALIDATED_PLAN_NOT_APPLIED",
        "target": {"account": ACCOUNT_ID, "region": REGION, "cluster": CLUSTER},
        "tenants": list(TENANTS),
        "services": services,
        "databaseChanges": "NOT_PERFORMED_BY_THIS_WORKFLOW",
        "activeResearchJobs": "NOT_PROVEN_BY_ECS_HEALTH; LEAD PREFLIGHT REQUIRED FOR APPLY",
    }


def wait_for_exact(
    aws: AwsCli,
    expected_tds: Mapping[str, str],
    expected_digests: Mapping[str, str],
    timeout_seconds: int,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    deadline = clock() + timeout_seconds
    last_error: ReleaseError | None = None
    while clock() < deadline:
        try:
            return capture_snapshot(aws, expected_tds, expected_digests)
        except ReleaseError as exc:
            last_error = exc
            sleep(min(15, max(0, deadline - clock())))
    detail = str(last_error) if last_error else "no successful service observation"
    raise ReleaseError(f"bounded ECS verification timed out: {detail}")


def observe_service_state(aws: AwsCli, service: str) -> dict[str, Any]:
    described = aws.describe_services((service,))
    services = described.get("services") or []
    if described.get("failures") or len(services) != 1:
        raise ReleaseError(f"{service} authoritative read-back failed")
    value = services[0]
    expected_cluster = f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:cluster/{CLUSTER}"
    expected_service = f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:service/{CLUSTER}/{service}"
    if (
        value.get("serviceName") != service
        or value.get("clusterArn") != expected_cluster
        or value.get("serviceArn") != expected_service
    ):
        raise ReleaseError(f"{service} authoritative read-back escaped the fixed target")
    current_td = str(value.get("taskDefinition", ""))
    if not TD_ARN_RE.fullmatch(current_td):
        raise ReleaseError(f"{service} authoritative read-back returned an invalid task definition")
    task_arns = aws.list_tasks(service)
    task_response = aws.describe_tasks(task_arns)
    if task_response.get("failures"):
        raise ReleaseError(f"{service} authoritative task read-back returned failures")
    tasks = task_response.get("tasks") or []
    digests = sorted(
        {
            str(container.get("imageDigest"))
            for task in tasks
            for container in task.get("containers", [])
            if DIGEST_RE.fullmatch(str(container.get("imageDigest", "")))
        }
    )
    return {
        "taskDefinition": current_td,
        "runningTaskDefinitions": sorted(
            {str(task.get("taskDefinitionArn", "")) for task in tasks}
        ),
        "runningImageDigests": digests,
        "desiredCount": value.get("desiredCount"),
        "runningCount": value.get("runningCount"),
        "pendingCount": value.get("pendingCount"),
    }


def validate_new_td_arn(service: str, arn: str) -> None:
    match = TD_ARN_RE.fullmatch(arn)
    if not match or match.group("family") != service:
        raise ReleaseError("registered task definition ARN escaped the approved family/account/region")
    prior_revision = int(str(EXPECTED[service]["taskDefinition"]).rsplit(":", 1)[1])
    if int(match.group("revision")) <= prior_revision:
        raise ReleaseError("registered task definition revision is not newer than the reviewed prior")


def base_receipt(args: argparse.Namespace, mode: str) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "workflow": WORKFLOW_NAME,
        "workflowPath": WORKFLOW_PATH,
        "repository": REPOSITORY,
        "runId": os.environ.get("GITHUB_RUN_ID", "local"),
        "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT", "local"),
        "workflowSha": os.environ.get("GITHUB_SHA", "local"),
        "actor": os.environ.get("GITHUB_ACTOR", "local"),
        "actorId": os.environ.get("GITHUB_ACTOR_ID", "local"),
        "mode": mode,
        "result": "STARTED",
        "target": {"account": ACCOUNT_ID, "region": REGION, "cluster": CLUSTER},
        "tenants": list(TENANTS),
        "leadPreflightReceiptSha256": hashlib.sha256(
            args.lead_preflight_receipt.encode("utf-8")
        ).hexdigest(),
        "databaseChanges": "NOT_PERFORMED",
        "atomicity": "ECS_HAS_NO_COMPARE_AND_SWAP; EXACT_STATE_RECHECKED_IMMEDIATELY_BEFORE_EACH_UPDATE",
        "services": {},
    }


def sanitized_error(exc: BaseException) -> str:
    if isinstance(exc, ReleaseError):
        return str(exc)[:500]
    return "unexpected internal failure; inspect the bounded workflow log"


def apply_release(
    aws: AwsCli,
    args: argparse.Namespace,
    initial: Mapping[str, Any],
    timeout_seconds: int,
) -> dict[str, Any]:
    receipt = base_receipt(args, "apply")
    for name in SERVICES:
        receipt["services"][name] = {
            "priorTaskDefinition": full_td(EXPECTED[name]["taskDefinition"]),
            "priorDigest": EXPECTED[name]["digest"],
            "registeredTaskDefinition": None,
            "rollbackTaskDefinition": (
                full_td(EXPECTED[name]["taskDefinition"])
                if name != "capiro-dev-api"
                else None
            ),
            "updateAttempted": False,
            "responseState": "NOT_ATTEMPTED",
            "observedState": "NOT_OBSERVED",
            "observation": None,
            "verified": False,
        }
    requests: dict[str, dict[str, Any]] = {}
    for name in SERVICES:
        item = initial[name]
        request = transform_task_definition(
            item["taskDefinitionResponse"], name, item["targetContainer"]
        )
        assert_only_approved_changes(
            item["taskDefinitionResponse"], request, item["targetContainer"], name
        )
        requests[name] = request
    api_item = initial["capiro-dev-api"]
    api_rollback_request = transform_rollback_task_definition(
        api_item["taskDefinitionResponse"], "capiro-dev-api", api_item["targetContainer"]
    )
    assert_only_rollback_changes(
        api_item["taskDefinitionResponse"],
        api_rollback_request,
        api_item["targetContainer"],
        "capiro-dev-api",
    )
    original_tds = {name: EXPECTED[name]["taskDefinition"] for name in SERVICES}
    digests = {name: EXPECTED[name]["digest"] for name in SERVICES}
    try:
        recheck = capture_snapshot(aws, original_tds, digests)
        if snapshot_fingerprint(recheck) != snapshot_fingerprint(initial):
            raise ReleaseError("service state changed between validation and registration")
        rollback_arn = aws.register_task_definition(api_rollback_request)
        validate_new_td_arn("capiro-dev-api", rollback_arn)
        receipt["services"]["capiro-dev-api"]["rollbackTaskDefinition"] = rollback_arn
        for name in ("capiro-dev-meriv2-orchestrator", "capiro-dev-api"):
            arn = aws.register_task_definition(requests[name])
            validate_new_td_arn(name, arn)
            receipt["services"][name]["registeredTaskDefinition"] = arn
        recheck = capture_snapshot(aws, original_tds, digests)
        if snapshot_fingerprint(recheck) != snapshot_fingerprint(initial):
            raise ReleaseError("service state changed while derived task definitions were registered")
        current_tds = dict(original_tds)
        last_verified = recheck
        for name in ("capiro-dev-meriv2-orchestrator", "capiro-dev-api"):
            immediate = capture_snapshot(aws, current_tds, digests)
            if snapshot_fingerprint(immediate) != snapshot_fingerprint(last_verified):
                raise ReleaseError("service state changed immediately before an apply update")
            entry = receipt["services"][name]
            new_td = str(entry["registeredTaskDefinition"])
            entry["updateAttempted"] = True
            entry["responseState"] = "UNCONFIRMED"
            try:
                aws.update_service(name, new_td)
                entry["responseState"] = "CONFIRMED"
            except BaseException as update_error:
                observation = observe_service_state(aws, name)
                entry["observation"] = observation
                if observation["taskDefinition"] == full_td(new_td):
                    entry["observedState"] = "NEW_TASK_DEFINITION"
                elif observation["taskDefinition"] == full_td(original_tds[name]):
                    entry["observedState"] = "PRIOR_TASK_DEFINITION"
                else:
                    entry["observedState"] = "UNEXPECTED_TASK_DEFINITION"
                if entry["observedState"] != "NEW_TASK_DEFINITION":
                    raise update_error
            current_tds[name] = new_td
            last_verified = wait_for_exact(aws, current_tds, digests, timeout_seconds)
            entry["observation"] = observe_service_state(aws, name)
            entry["observedState"] = "NEW_TASK_DEFINITION"
            entry["verified"] = True
        receipt["result"] = "APPLIED_AND_VERIFIED"
        return receipt
    except BaseException as exc:
        changed = [name for name in SERVICES if receipt["services"][name]["updateAttempted"]]
        receipt["result"] = "PARTIAL_FAILURE" if changed else "FAILED_BEFORE_SERVICE_UPDATE"
        receipt["error"] = sanitized_error(exc)
        setattr(exc, "release_receipt", receipt)
        raise


def validate_receipt(
    receipt: Mapping[str, Any],
    expected_run_id: str,
    run_metadata: Mapping[str, Any],
    artifact_metadata: Mapping[str, Any],
) -> None:
    if receipt.get("schemaVersion") != 2 or receipt.get("workflow") != WORKFLOW_NAME:
        raise ReleaseError("rollback receipt is not a synthetic cohort workflow receipt")
    if (
        receipt.get("workflowPath") != WORKFLOW_PATH
        or receipt.get("repository") != REPOSITORY
        or str(receipt.get("runId")) != expected_run_id
    ):
        raise ReleaseError("rollback receipt repository/run does not match the downloaded workflow run")
    if receipt.get("mode") != "apply" or receipt.get("result") not in (
        "APPLIED_AND_VERIFIED",
        "PARTIAL_FAILURE",
    ):
        raise ReleaseError("rollback receipt does not describe an applied or partially applied release")
    if (
        str(run_metadata.get("id")) != expected_run_id
        or run_metadata.get("event") != "workflow_dispatch"
        or run_metadata.get("head_branch") != "main"
        or run_metadata.get("path") != WORKFLOW_PATH
        or (run_metadata.get("repository") or {}).get("full_name") != REPOSITORY
        or (run_metadata.get("head_repository") or {}).get("full_name") != REPOSITORY
        or run_metadata.get("status") != "completed"
    ):
        raise ReleaseError("trusted GitHub run metadata is not the exact fixed workflow identity")
    workflow_sha = str(receipt.get("workflowSha", ""))
    if not re.fullmatch(r"[0-9a-f]{40}", workflow_sha) or run_metadata.get("head_sha") != workflow_sha:
        raise ReleaseError("trusted GitHub run metadata does not bind the source workflow SHA")
    if str(run_metadata.get("run_attempt")) != str(receipt.get("runAttempt")):
        raise ReleaseError("trusted GitHub run metadata does not bind the run attempt")
    actor = run_metadata.get("actor") or {}
    if actor.get("login") != receipt.get("actor") or str(actor.get("id")) != str(receipt.get("actorId")):
        raise ReleaseError("trusted GitHub run metadata does not bind the workflow actor identity")
    expected_conclusion = "success" if receipt.get("result") == "APPLIED_AND_VERIFIED" else "failure"
    if run_metadata.get("conclusion") != expected_conclusion:
        raise ReleaseError("trusted GitHub run conclusion contradicts the apply receipt")
    artifacts = artifact_metadata.get("artifacts")
    if not isinstance(artifacts, list) or artifact_metadata.get("total_count") != len(artifacts):
        raise ReleaseError("trusted GitHub artifact metadata is incomplete")
    matches = [item for item in artifacts if item.get("name") == ARTIFACT_NAME]
    if len(matches) != 1:
        raise ReleaseError("trusted GitHub metadata does not identify one exact receipt artifact")
    artifact = matches[0]
    artifact_run = artifact.get("workflow_run") or {}
    if (
        artifact.get("expired") is not False
        or str(artifact_run.get("id")) != expected_run_id
        or artifact_run.get("head_branch") != "main"
        or artifact_run.get("head_sha") != workflow_sha
        or artifact_run.get("repository_id") != (run_metadata.get("repository") or {}).get("id")
        or artifact_run.get("head_repository_id") != (run_metadata.get("head_repository") or {}).get("id")
    ):
        raise ReleaseError("trusted GitHub artifact metadata is not bound to the exact apply run")
    if receipt.get("target") != {"account": ACCOUNT_ID, "region": REGION, "cluster": CLUSTER}:
        raise ReleaseError("rollback receipt target is not exact")
    if receipt.get("tenants") != list(TENANTS):
        raise ReleaseError("rollback receipt tenant set is not exact")
    services = receipt.get("services")
    if not isinstance(services, dict) or set(services) != set(SERVICES):
        raise ReleaseError("rollback receipt service set is not exact")
    for name in SERVICES:
        item = services[name]
        if item.get("priorTaskDefinition") != full_td(EXPECTED[name]["taskDefinition"]):
            raise ReleaseError("rollback receipt prior task definition is not the fixed reviewed prior")
        if item.get("priorDigest") != EXPECTED[name]["digest"]:
            raise ReleaseError("rollback receipt prior digest is not the fixed reviewed digest")
        new_td = item.get("registeredTaskDefinition")
        if not isinstance(new_td, str):
            raise ReleaseError("rollback receipt omitted the registered apply task definition")
        validate_new_td_arn(name, new_td)
        rollback_td = item.get("rollbackTaskDefinition")
        if name == "capiro-dev-api":
            if not isinstance(rollback_td, str):
                raise ReleaseError("rollback receipt omitted the immutable API rollback task definition")
            validate_new_td_arn(name, rollback_td)
            if rollback_td == new_td:
                raise ReleaseError("API apply and rollback task definitions are not distinct")
        elif rollback_td != full_td(EXPECTED[name]["taskDefinition"]):
            raise ReleaseError("orchestrator rollback target is not the fixed immutable prior")
        if item.get("updateAttempted") not in (True, False):
            raise ReleaseError("rollback receipt has an invalid update-attempt state")
        if item.get("responseState") not in ("NOT_ATTEMPTED", "CONFIRMED", "UNCONFIRMED"):
            raise ReleaseError("rollback receipt has an invalid response state")
        if item.get("observedState") not in (
            "NOT_OBSERVED",
            "PRIOR_TASK_DEFINITION",
            "NEW_TASK_DEFINITION",
            "UNEXPECTED_TASK_DEFINITION",
        ):
            raise ReleaseError("rollback receipt has an invalid observed state")
        if item.get("verified") not in (True, False):
            raise ReleaseError("rollback receipt has an invalid verification state")
        if item.get("verified") and item.get("observedState") != "NEW_TASK_DEFINITION":
            raise ReleaseError("rollback receipt verification is not backed by observed new state")


def validate_receipt_task_definitions(aws: AwsCli, receipt: Mapping[str, Any]) -> None:
    for name in SERVICES:
        source = aws.describe_task_definition(EXPECTED[name]["taskDefinition"])
        target_name = find_config_target(source, name)
        expected_apply = transform_task_definition(source, name, target_name)
        actual_apply = aws.describe_task_definition(receipt["services"][name]["registeredTaskDefinition"])
        if (
            (actual_apply.get("taskDefinition") or {}).get("taskDefinitionArn")
            != full_td(receipt["services"][name]["registeredTaskDefinition"])
            or task_registration_request(actual_apply) != expected_apply
        ):
            raise ReleaseError(f"{name} receipt apply task definition content is not exact")
        rollback_td = receipt["services"][name]["rollbackTaskDefinition"]
        actual_rollback = aws.describe_task_definition(rollback_td)
        expected_rollback = transform_rollback_task_definition(source, name, target_name)
        if (
            (actual_rollback.get("taskDefinition") or {}).get("taskDefinitionArn") != full_td(rollback_td)
            or task_registration_request(actual_rollback) != expected_rollback
        ):
            raise ReleaseError(f"{name} receipt rollback task definition content is not exact and immutable")


def rollback_release(
    aws: AwsCli,
    args: argparse.Namespace,
    source_receipt: Mapping[str, Any],
    run_metadata: Mapping[str, Any],
    artifact_metadata: Mapping[str, Any],
    timeout_seconds: int,
) -> dict[str, Any]:
    validate_receipt(source_receipt, args.receipt_run_id, run_metadata, artifact_metadata)
    validate_receipt_task_definitions(aws, source_receipt)
    receipt = base_receipt(args, "rollback")
    receipt["sourceApplyRunId"] = args.receipt_run_id
    source_services = source_receipt["services"]
    current_tds: dict[str, str] = {}
    for name in SERVICES:
        source = source_services[name]
        observation = observe_service_state(aws, name)
        current = str(observation["taskDefinition"])
        prior = full_td(EXPECTED[name]["taskDefinition"])
        rollback_target = full_td(source["rollbackTaskDefinition"])
        allowed = {prior, rollback_target}
        if source.get("updateAttempted"):
            allowed.add(full_td(source["registeredTaskDefinition"]))
        if current not in allowed:
            raise ReleaseError(f"{name} current task definition is outside the receipt-bound prior/new set")
        current_tds[name] = current
        needs_rollback = bool(source.get("updateAttempted")) and current != rollback_target
        receipt["services"][name] = {
            "fromTaskDefinition": current,
            "toTaskDefinition": rollback_target,
            "rollbackAttempted": False,
            "responseState": "NOT_ATTEMPTED",
            "observedState": "ROLLBACK_NOT_REQUIRED" if not needs_rollback else "OBSERVED_ALLOWED_SOURCE",
            "observation": observation,
            "verified": not needs_rollback,
        }
    digests = {name: EXPECTED[name]["digest"] for name in SERVICES}
    try:
        initial = wait_for_exact(aws, current_tds, digests, timeout_seconds)
        for name in SERVICES:
            current = full_td(current_tds[name])
            expected_cohort = (
                (*EXISTING_COHORT, *TENANTS)
                if current == full_td(source_services[name]["registeredTaskDefinition"])
                else EXISTING_COHORT
            )
            if initial[name]["cohort"] != expected_cohort:
                raise ReleaseError(f"{name} observed cohort does not match its receipt-bound task definition")
        last_verified = initial
        for name in ("capiro-dev-api", "capiro-dev-meriv2-orchestrator"):
            entry = receipt["services"][name]
            target = str(entry["toTaskDefinition"])
            if entry["verified"]:
                continue
            immediate = capture_snapshot(aws, current_tds, digests)
            if snapshot_fingerprint(immediate) != snapshot_fingerprint(last_verified):
                raise ReleaseError("service state changed immediately before a rollback update")
            entry["rollbackAttempted"] = True
            entry["responseState"] = "UNCONFIRMED"
            try:
                aws.update_service(name, target)
                entry["responseState"] = "CONFIRMED"
            except BaseException as update_error:
                observation = observe_service_state(aws, name)
                entry["observation"] = observation
                entry["observedState"] = (
                    "ROLLBACK_TASK_DEFINITION"
                    if observation["taskDefinition"] == full_td(target)
                    else "UNEXPECTED_AFTER_ROLLBACK_ATTEMPT"
                )
                if entry["observedState"] != "ROLLBACK_TASK_DEFINITION":
                    raise update_error
            current_tds[name] = target
            last_verified = wait_for_exact(aws, current_tds, digests, timeout_seconds)
            entry["observation"] = observe_service_state(aws, name)
            entry["observedState"] = "ROLLBACK_TASK_DEFINITION"
            entry["verified"] = True
        receipt["result"] = "ROLLED_BACK_AND_VERIFIED"
        return receipt
    except BaseException as exc:
        changed = [name for name in SERVICES if receipt["services"][name]["rollbackAttempted"]]
        receipt["result"] = "PARTIAL_FAILURE" if changed else "FAILED_BEFORE_SERVICE_UPDATE"
        receipt["error"] = sanitized_error(exc)
        setattr(exc, "release_receipt", receipt)
        raise


def write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("plan", "apply", "rollback"), default="plan")
    parser.add_argument("--tenant-slugs", default=",".join(TENANTS))
    parser.add_argument("--expected-existing-cohort", default=",".join(EXISTING_COHORT))
    parser.add_argument("--expected-api-task-definition", default=EXPECTED["capiro-dev-api"]["taskDefinition"])
    parser.add_argument("--expected-api-digest", default=EXPECTED["capiro-dev-api"]["digest"])
    parser.add_argument(
        "--expected-orchestrator-task-definition",
        default=EXPECTED["capiro-dev-meriv2-orchestrator"]["taskDefinition"],
    )
    parser.add_argument(
        "--expected-orchestrator-digest",
        default=EXPECTED["capiro-dev-meriv2-orchestrator"]["digest"],
    )
    parser.add_argument("--apply-confirmation", default="")
    parser.add_argument("--rollback-confirmation", default="")
    parser.add_argument("--lead-preflight-confirmation", default="")
    parser.add_argument("--lead-preflight-receipt", default="")
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--run-metadata", type=Path)
    parser.add_argument("--artifact-metadata", type=Path)
    parser.add_argument("--receipt-run-id", default="")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--wait-timeout-seconds", type=int, default=900)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    receipt: dict[str, Any] | None = None
    try:
        require_fixed_inputs(args)
        verify_execution_context(os.environ, GitCli())
        if not 60 <= args.wait_timeout_seconds <= 1200:
            raise ReleaseError("wait timeout must be between 60 and 1200 seconds")
        aws = AwsCli()
        identity = aws.identity()
        if identity.get("Account") != ACCOUNT_ID:
            raise ReleaseError("OIDC credentials are not for the fixed dev AWS account")
        original_tds = {name: EXPECTED[name]["taskDefinition"] for name in SERVICES}
        digests = {name: EXPECTED[name]["digest"] for name in SERVICES}
        if args.mode == "rollback":
            if (
                not args.receipt
                or not args.run_metadata
                or not args.artifact_metadata
                or not args.receipt_run_id
            ):
                raise ReleaseError(
                    "rollback requires a downloaded receipt and trusted GitHub run/artifact metadata"
                )
            source = json.loads(args.receipt.read_text(encoding="utf-8"))
            run_metadata = json.loads(args.run_metadata.read_text(encoding="utf-8"))
            artifact_metadata = json.loads(args.artifact_metadata.read_text(encoding="utf-8"))
            receipt = rollback_release(
                aws,
                args,
                source,
                run_metadata,
                artifact_metadata,
                args.wait_timeout_seconds,
            )
            write_json(args.output_dir / "receipt.json", receipt)
            print("Guarded rollback completed and exact task definitions/digests were verified.")
            return 0
        snapshot = capture_snapshot(aws, original_tds, digests)
        for name in SERVICES:
            if snapshot[name]["cohort"] != EXISTING_COHORT:
                raise ReleaseError(f"{name} existing cohort differs from the exact reviewed baseline")
        plan = make_plan(snapshot)
        write_json(args.output_dir / "plan.json", plan)
        if args.mode == "plan":
            print("Validated plan only; no AWS mutation was requested.")
            return 0
        receipt = apply_release(aws, args, snapshot, args.wait_timeout_seconds)
        write_json(args.output_dir / "receipt.json", receipt)
        print("Configuration-only cohort apply completed and both services were verified.")
        return 0
    except BaseException as exc:
        attached = getattr(exc, "release_receipt", None)
        if isinstance(attached, dict):
            receipt = attached
        if receipt is not None:
            write_json(args.output_dir / "receipt.json", receipt)
        message = sanitized_error(exc)
        print(f"REFUSED: {message}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
