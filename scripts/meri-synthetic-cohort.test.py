#!/usr/bin/env python3
"""Offline unit tests for the synthetic Meri cohort release runner."""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from typing import Any, Mapping, Sequence

SCRIPT = Path(__file__).with_name("meri-synthetic-cohort.py")
SPEC = importlib.util.spec_from_file_location("meri_synthetic_cohort", SCRIPT)
assert SPEC and SPEC.loader
cohort = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = cohort
SPEC.loader.exec_module(cohort)


def td_arn(name: str, revision: int) -> str:
    return f"arn:aws:ecs:{cohort.REGION}:{cohort.ACCOUNT_ID}:task-definition/{name}:{revision}"


def target_name(service: str) -> str:
    return "api" if service == "capiro-dev-api" else "meriv2-orchestrator"


def prior_revision(service: str) -> int:
    return int(cohort.EXPECTED[service]["taskDefinition"].rsplit(":", 1)[1])


def task_definition(service: str, *, cohort_value: str | None = None) -> dict[str, Any]:
    digest = cohort.EXPECTED[service]["digest"]
    repository = (
        f"{cohort.ACCOUNT_ID}.dkr.ecr.{cohort.REGION}.amazonaws.com/"
        + ("capiro/dev/api" if service == "capiro-dev-api" else "capiro/dev/meriv2-orchestrator")
    )
    image = f"{repository}:latest" if service == "capiro-dev-api" else f"{repository}@{digest}"
    revision = prior_revision(service)
    return {
        "taskDefinition": {
            "taskDefinitionArn": td_arn(service, revision),
            "family": service,
            "revision": revision,
            "status": "ACTIVE",
            "taskRoleArn": f"arn:aws:iam::{cohort.ACCOUNT_ID}:role/{service}-task",
            "executionRoleArn": f"arn:aws:iam::{cohort.ACCOUNT_ID}:role/{service}-execution",
            "networkMode": "awsvpc",
            "requiresCompatibilities": ["FARGATE"],
            "cpu": "512",
            "memory": "1024",
            "runtimePlatform": {"cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX"},
            "containerDefinitions": [
                {
                    "name": target_name(service),
                    "image": image,
                    "essential": True,
                    "environment": [
                        {"name": "MODEL_NAME", "value": "reviewed-model"},
                        {
                            "name": cohort.ENV_NAME,
                            "value": cohort_value or ",".join(cohort.EXISTING_COHORT),
                        },
                        {"name": "GLOBAL_DISABLE", "value": "false"},
                    ],
                    "secrets": [
                        {
                            "name": "DATABASE_URL",
                            "valueFrom": f"arn:aws:secretsmanager:{cohort.REGION}:{cohort.ACCOUNT_ID}:secret:db",
                        }
                    ],
                    "dockerLabels": {
                        "org.opencontainers.image.revision": cohort.EXPECTED[service]["sourceSha"]
                    },
                    "logConfiguration": {"logDriver": "awslogs", "options": {"awslogs-group": service}},
                },
                {
                    "name": "telemetry-sidecar",
                    "image": f"{repository.rsplit('/', 1)[0]}/telemetry@sha256:{'a' * 64}",
                    "essential": False,
                    "environment": [{"name": "UNCHANGED", "value": "yes"}],
                    "secrets": [],
                },
            ],
            "volumes": [{"name": "scratch"}],
            "registeredAt": "2026-09-28T00:00:00Z",
            "registeredBy": "fixture",
            "requiresAttributes": [{"name": "ecs.capability.task-eni"}],
            "compatibilities": ["EC2", "FARGATE"],
        },
        "tags": [{"key": "owner", "value": "meri"}],
    }


class FakeAws:
    def __init__(self) -> None:
        self.current = {name: cohort.EXPECTED[name]["taskDefinition"] for name in cohort.SERVICES}
        self.definitions = {name: task_definition(name) for name in cohort.SERVICES}
        self.registered: dict[str, dict[str, Any]] = {}
        self.next_revision = {name: prior_revision(name) + 1 for name in cohort.SERVICES}
        self.writes: list[tuple[Any, ...]] = []
        self.list_counts = {name: 0 for name in cohort.SERVICES}

    def identity(self) -> dict[str, Any]:
        return {"Account": cohort.ACCOUNT_ID}

    def describe_services(self, services: Sequence[str]) -> dict[str, Any]:
        values = []
        for name in services:
            current = self.current[name]
            values.append(
                {
                    "serviceName": name,
                    "clusterArn": f"arn:aws:ecs:{cohort.REGION}:{cohort.ACCOUNT_ID}:cluster/{cohort.CLUSTER}",
                    "serviceArn": (
                        f"arn:aws:ecs:{cohort.REGION}:{cohort.ACCOUNT_ID}:service/"
                        f"{cohort.CLUSTER}/{name}"
                    ),
                    "taskDefinition": cohort.full_td(current),
                    "desiredCount": 1,
                    "runningCount": 1,
                    "pendingCount": 0,
                    "deployments": [
                        {
                            "status": "PRIMARY",
                            "taskDefinition": cohort.full_td(current),
                            "rolloutState": "COMPLETED",
                            "desiredCount": 1,
                            "runningCount": 1,
                            "pendingCount": 0,
                        }
                    ],
                }
            )
        return {"services": values, "failures": []}

    def describe_task_definition(self, task_definition_name: str) -> dict[str, Any]:
        short = cohort.short_td(task_definition_name)
        if short in self.registered:
            return copy.deepcopy(self.registered[short])
        family = short.rsplit(":", 1)[0]
        return copy.deepcopy(self.definitions[family])

    def list_tasks(self, service: str) -> list[str]:
        self.list_counts[service] += 1
        return [f"arn:aws:ecs:{cohort.REGION}:{cohort.ACCOUNT_ID}:task/{cohort.CLUSTER}/{service}-task"]

    def describe_tasks(self, task_arns: Sequence[str]) -> dict[str, Any]:
        tasks = []
        for arn in task_arns:
            service = next(name for name in cohort.SERVICES if f"/{name}-task" in arn)
            tasks.append(
                {
                    "taskArn": arn,
                    "taskDefinitionArn": cohort.full_td(self.current[service]),
                    "lastStatus": "RUNNING",
                    "desiredStatus": "RUNNING",
                    "containers": [
                        {
                            "name": target_name(service),
                            "imageDigest": cohort.EXPECTED[service]["digest"],
                        },
                        {"name": "telemetry-sidecar", "imageDigest": f"sha256:{'a' * 64}"},
                    ],
                }
            )
        return {"tasks": tasks, "failures": []}

    def register_task_definition(self, request: Mapping[str, Any]) -> str:
        family = str(request["family"])
        revision = self.next_revision[family]
        self.next_revision[family] += 1
        arn = td_arn(family, revision)
        response = {
            "taskDefinition": {**copy.deepcopy(request), "taskDefinitionArn": arn, "revision": revision},
            "tags": copy.deepcopy(request.get("tags", [])),
        }
        response["taskDefinition"].pop("tags", None)
        self.registered[cohort.short_td(arn)] = response
        self.writes.append(("register", family, copy.deepcopy(request)))
        return arn

    def update_service(self, service: str, task_definition_name: str) -> None:
        self.writes.append(("update", service, task_definition_name))
        self.current[service] = cohort.short_td(task_definition_name)

def arguments(**overrides: Any) -> argparse.Namespace:
    values = {
        "mode": "apply",
        "tenant_slugs": ",".join(cohort.TENANTS),
        "expected_existing_cohort": ",".join(cohort.EXISTING_COHORT),
        "expected_api_task_definition": cohort.EXPECTED["capiro-dev-api"]["taskDefinition"],
        "expected_api_digest": cohort.EXPECTED["capiro-dev-api"]["digest"],
        "expected_orchestrator_task_definition": cohort.EXPECTED["capiro-dev-meriv2-orchestrator"][
            "taskDefinition"
        ],
        "expected_orchestrator_digest": cohort.EXPECTED["capiro-dev-meriv2-orchestrator"]["digest"],
        "apply_confirmation": "ENABLE_FIXED_SYNTHETIC_MERI_COHORT",
        "rollback_confirmation": "",
        "lead_preflight_confirmation": "LEAD_CONFIRMED_DB_FLAGS_AND_RESEARCH_DRAIN",
        "lead_preflight_receipt": "lead-receipt-20260928",
        "receipt_run_id": "",
        "receipt_run_attempt": "1",
    }
    values.update(overrides)
    return argparse.Namespace(**values)


def original_expectations() -> tuple[dict[str, str], dict[str, str]]:
    return (
        {name: cohort.EXPECTED[name]["taskDefinition"] for name in cohort.SERVICES},
        {name: cohort.EXPECTED[name]["digest"] for name in cohort.SERVICES},
    )


def bind_receipt(
    receipt: dict[str, Any], run_id: str = "123"
) -> tuple[dict[str, Any], dict[str, Any]]:
    receipt.update(
        {
            "runId": run_id,
            "runAttempt": "1",
            "artifactName": cohort.artifact_name(run_id, "1"),
            "workflowSha": "f" * 40,
            "actor": "release-lead",
            "actorId": "42",
        }
    )
    run = {
        "id": int(run_id),
        "run_attempt": 1,
        "event": "workflow_dispatch",
        "head_branch": "main",
        "head_sha": receipt["workflowSha"],
        "path": cohort.WORKFLOW_PATH,
        "status": "completed",
        "conclusion": "success" if receipt["result"] == "APPLIED_AND_VERIFIED" else "failure",
        "repository": {"id": 10, "full_name": cohort.REPOSITORY},
        "head_repository": {"id": 10, "full_name": cohort.REPOSITORY},
        "actor": {"id": 42, "login": "release-lead"},
        "created_at": "2026-09-28T00:00:00Z",
        "run_started_at": "2026-09-28T00:00:01Z",
        "updated_at": "2026-09-28T00:10:00Z",
    }
    artifacts = {
        "total_count": 1,
        "artifacts": [
            {
                "id": 99,
                "name": cohort.artifact_name(run_id, "1"),
                "digest": f"sha256:{'a' * 64}",
                "expired": False,
                "created_at": "2026-09-28T00:09:00Z",
                "updated_at": "2026-09-28T00:09:30Z",
                "workflow_run": {
                    "id": int(run_id),
                    "repository_id": 10,
                    "head_repository_id": 10,
                    "head_branch": "main",
                    "head_sha": receipt["workflowSha"],
                },
            }
        ],
    }
    return run, artifacts


class CohortTransformTests(unittest.TestCase):
    def test_actual_script_planning_is_sanitized_and_exact(self) -> None:
        aws = FakeAws()
        tds, digests = original_expectations()
        snapshot = cohort.capture_snapshot(aws, tds, digests)
        plan = cohort.make_plan(snapshot)
        self.assertEqual(plan["status"], "VALIDATED_PLAN_NOT_APPLIED")
        self.assertEqual(plan["tenants"], list(cohort.TENANTS))
        encoded = json.dumps(plan)
        self.assertNotIn("DATABASE_URL", encoded)
        self.assertNotIn("secret:db", encoded)
        self.assertEqual(aws.writes, [])

    def test_transform_preserves_model_env_secret_refs_tags_and_all_other_fields(self) -> None:
        before = task_definition("capiro-dev-api")
        request = cohort.transform_task_definition(before, "capiro-dev-api", "api")
        cohort.assert_only_approved_changes(before, request, "api", "capiro-dev-api")
        target = next(item for item in request["containerDefinitions"] if item["name"] == "api")
        env = {item["name"]: item["value"] for item in target["environment"]}
        self.assertEqual(env["MODEL_NAME"], "reviewed-model")
        self.assertEqual(env["GLOBAL_DISABLE"], "false")
        self.assertEqual(target["secrets"], before["taskDefinition"]["containerDefinitions"][0]["secrets"])
        self.assertEqual(request["tags"], before["tags"])
        self.assertEqual(request["volumes"], before["taskDefinition"]["volumes"])
        self.assertEqual(env[cohort.ENV_NAME], ",".join((*cohort.EXISTING_COHORT, *cohort.TENANTS)))

    def test_api_latest_is_pinned_to_same_observed_immutable_digest(self) -> None:
        request = cohort.transform_task_definition(task_definition("capiro-dev-api"), "capiro-dev-api", "api")
        image = request["containerDefinitions"][0]["image"]
        self.assertTrue(image.endswith("@" + cohort.EXPECTED["capiro-dev-api"]["digest"]))
        self.assertNotIn(":latest", image)

    def test_api_rollback_derivation_pins_digest_and_keeps_exact_nine_slugs(self) -> None:
        before = task_definition("capiro-dev-api")
        request = cohort.transform_rollback_task_definition(before, "capiro-dev-api", "api")
        cohort.assert_only_rollback_changes(before, request, "api", "capiro-dev-api")
        target = request["containerDefinitions"][0]
        self.assertEqual(cohort.read_cohort(target), cohort.EXISTING_COHORT)
        self.assertTrue(target["image"].endswith("@" + cohort.EXPECTED["capiro-dev-api"]["digest"]))
        self.assertNotIn(":latest", target["image"])

    def test_orchestrator_image_stays_already_pinned(self) -> None:
        before = task_definition("capiro-dev-meriv2-orchestrator")
        after = cohort.transform_task_definition(
            before, "capiro-dev-meriv2-orchestrator", "meriv2-orchestrator"
        )
        self.assertEqual(
            after["containerDefinitions"][0]["image"],
            before["taskDefinition"]["containerDefinitions"][0]["image"],
        )

    def test_adversarial_target_container_is_rejected(self) -> None:
        response = task_definition("capiro-dev-api")
        response["taskDefinition"]["containerDefinitions"].append(
            copy.deepcopy(response["taskDefinition"]["containerDefinitions"][0])
        )
        with self.assertRaisesRegex(cohort.ReleaseError, "ambiguous"):
            cohort.transform_task_definition(response, "capiro-dev-api", "api")

    def test_wrong_existing_cohort_is_rejected(self) -> None:
        response = task_definition("capiro-dev-api", cohort_value="capiro-internal")
        with self.assertRaisesRegex(cohort.ReleaseError, "existing cohort"):
            cohort.transform_task_definition(response, "capiro-dev-api", "api")

    def test_source_commit_label_mismatch_is_rejected(self) -> None:
        response = task_definition("capiro-dev-api")
        container = response["taskDefinition"]["containerDefinitions"][0]
        container["dockerLabels"]["org.opencontainers.image.revision"] = "0" * 40
        with self.assertRaisesRegex(cohort.ReleaseError, "source-commit"):
            cohort.relevant_source_label(container, cohort.EXPECTED["capiro-dev-api"]["sourceSha"])

    def test_fixed_inputs_reject_extra_tenant_and_task_definition(self) -> None:
        with self.assertRaises(cohort.ReleaseError):
            cohort.require_fixed_inputs(arguments(tenant_slugs=",".join((*cohort.TENANTS, "other"))))
        with self.assertRaises(cohort.ReleaseError):
            cohort.require_fixed_inputs(arguments(expected_api_task_definition="capiro-dev-api:999"))


class GitExecutionContextTests(unittest.TestCase):
    def test_real_git_gate_uses_complete_temp_repo_history_and_supported_object_check(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            origin = root / "origin.git"
            seed = root / "seed"
            checkout = root / "checkout"

            def git(*args: str, cwd: Path | None = None) -> str:
                completed = subprocess.run(
                    ["git", *args], cwd=cwd, text=True, capture_output=True, check=True
                )
                return completed.stdout.strip()

            git("init", "--bare", str(origin))
            git("init", "-b", "main", str(seed))
            git("config", "user.email", "cohort-test@example.invalid", cwd=seed)
            git("config", "user.name", "Cohort Test", cwd=seed)
            (seed / "source.txt").write_text("served source\n", encoding="utf-8")
            git("add", "source.txt", cwd=seed)
            git("commit", "-m", "served source", cwd=seed)
            source_sha = git("rev-parse", "HEAD", cwd=seed)
            workflow = seed / cohort.WORKFLOW_PATH
            workflow.parent.mkdir(parents=True)
            workflow.write_text("name: temp cohort gate\n", encoding="utf-8")
            git("add", cohort.WORKFLOW_PATH, cwd=seed)
            git("commit", "-m", "workflow", cwd=seed)
            git("remote", "add", "origin", str(origin), cwd=seed)
            git("push", "-u", "origin", "main", cwd=seed)
            git("symbolic-ref", "HEAD", "refs/heads/main", cwd=origin)
            git("clone", "--branch", "main", str(origin), str(checkout))
            head = git("rev-parse", "HEAD", cwd=checkout)
            env = {
                "GITHUB_REPOSITORY": cohort.REPOSITORY,
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_REF": "refs/heads/main",
                "GITHUB_WORKFLOW_REF": f"{cohort.REPOSITORY}/{cohort.WORKFLOW_PATH}@refs/heads/main",
                "GITHUB_SHA": head,
            }
            cohort.verify_execution_context(env, cohort.GitCli(checkout), (source_sha,))


class CohortMutationTests(unittest.TestCase):
    def capture(self, aws: FakeAws) -> dict[str, Any]:
        tds, digests = original_expectations()
        return cohort.capture_snapshot(aws, tds, digests)

    def test_valid_apply_registers_then_updates_orchestrator_before_api(self) -> None:
        aws = FakeAws()
        receipt = cohort.apply_release(aws, arguments(), self.capture(aws), 60)
        operations = [(entry[0], entry[1]) for entry in aws.writes]
        self.assertEqual(
            operations,
            [
                ("register", "capiro-dev-api"),
                ("register", "capiro-dev-meriv2-orchestrator"),
                ("register", "capiro-dev-api"),
                ("update", "capiro-dev-meriv2-orchestrator"),
                ("update", "capiro-dev-api"),
            ],
        )
        self.assertEqual(receipt["result"], "APPLIED_AND_VERIFIED")
        self.assertTrue(all(item["verified"] for item in receipt["services"].values()))
        for name, entry in receipt["services"].items():
            observation = entry["observation"]
            self.assertEqual(observation["taskDefinition"], entry["registeredTaskDefinition"])
            self.assertEqual(observation["runningImageDigests"], [cohort.EXPECTED[name]["digest"]])
            self.assertEqual(
                (
                    observation["desiredCount"],
                    observation["runningCount"],
                    observation["pendingCount"],
                ),
                (
                    observation["primaryDesiredCount"],
                    observation["primaryRunningCount"],
                    observation["primaryPendingCount"],
                ),
            )
        api = receipt["services"]["capiro-dev-api"]
        self.assertNotEqual(api["rollbackTaskDefinition"], api["priorTaskDefinition"])
        rollback = aws.describe_task_definition(api["rollbackTaskDefinition"])
        target = rollback["taskDefinition"]["containerDefinitions"][0]
        self.assertEqual(cohort.read_cohort(target), cohort.EXISTING_COHORT)
        self.assertTrue(target["image"].endswith("@" + cohort.EXPECTED["capiro-dev-api"]["digest"]))

    def test_drift_fails_before_any_mutation(self) -> None:
        aws = FakeAws()
        aws.definitions["capiro-dev-api"] = task_definition("capiro-dev-api", cohort_value="wrong")
        with self.assertRaises(cohort.ReleaseError):
            cohort.apply_release(aws, arguments(), self.capture(aws), 60)
        self.assertEqual(aws.writes, [])

    def test_primary_zero_counts_against_service_one_fail_closed(self) -> None:
        class InconsistentPrimaryAws(FakeAws):
            def describe_services(self, services: Sequence[str]) -> dict[str, Any]:
                result = super().describe_services(services)
                result["services"][0]["deployments"][0].update(
                    {"desiredCount": 0, "runningCount": 0}
                )
                return result

        aws = InconsistentPrimaryAws()
        tds, digests = original_expectations()
        with self.assertRaisesRegex(cohort.ReleaseError, "PRIMARY deployment counts"):
            cohort.capture_snapshot(aws, tds, digests)
        self.assertEqual(aws.writes, [])

    def test_running_digest_drift_fails_closed(self) -> None:
        class DigestDriftAws(FakeAws):
            def describe_tasks(self, task_arns: Sequence[str]) -> dict[str, Any]:
                result = super().describe_tasks(task_arns)
                result["tasks"][0]["containers"][0]["imageDigest"] = f"sha256:{'0' * 64}"
                return result

        aws = DigestDriftAws()
        tds, digests = original_expectations()
        with self.assertRaisesRegex(cohort.ReleaseError, "reviewed digest"):
            cohort.capture_snapshot(aws, tds, digests)
        self.assertEqual(aws.writes, [])

    def test_concurrent_service_change_fails_before_any_mutation(self) -> None:
        class ConcurrentAws(FakeAws):
            def list_tasks(self, service: str) -> list[str]:
                values = super().list_tasks(service)
                if service == "capiro-dev-api" and self.list_counts[service] >= 2:
                    return [values[0] + "-replacement"]
                return values

            def describe_tasks(self, task_arns: Sequence[str]) -> dict[str, Any]:
                result = super().describe_tasks([arn.replace("-replacement", "") for arn in task_arns])
                for task, arn in zip(result["tasks"], task_arns):
                    task["taskArn"] = arn
                return result

        aws = ConcurrentAws()
        initial = self.capture(aws)
        with self.assertRaisesRegex(cohort.ReleaseError, "changed"):
            cohort.apply_release(aws, arguments(), initial, 60)
        self.assertEqual(aws.writes, [])

    def test_rejected_api_update_separates_attempt_response_observation_and_verification(self) -> None:
        class ApiFailureAws(FakeAws):
            def update_service(self, service: str, task_definition_name: str) -> None:
                if service == "capiro-dev-api":
                    raise cohort.ReleaseError("injected API update failure")
                super().update_service(service, task_definition_name)

        aws = ApiFailureAws()
        with self.assertRaises(cohort.ReleaseError) as caught:
            cohort.apply_release(aws, arguments(), self.capture(aws), 60)
        receipt = caught.exception.release_receipt
        self.assertEqual(receipt["result"], "PARTIAL_FAILURE")
        orchestrator = receipt["services"]["capiro-dev-meriv2-orchestrator"]
        self.assertEqual(orchestrator["responseState"], "CONFIRMED")
        self.assertTrue(orchestrator["verified"])
        api = receipt["services"]["capiro-dev-api"]
        self.assertTrue(api["updateAttempted"])
        self.assertEqual(api["responseState"], "UNCONFIRMED")
        self.assertEqual(api["observedState"], "PRIOR_TASK_DEFINITION")
        self.assertFalse(api["verified"])

    def test_unapproved_service_family_cannot_be_registered(self) -> None:
        with self.assertRaises(cohort.ReleaseError):
            cohort.validate_new_td_arn(
                "capiro-dev-api",
                f"arn:aws:ecs:{cohort.REGION}:{cohort.ACCOUNT_ID}:task-definition/capiro-prod-api:484",
            )

    def test_apply_and_rollback_commit_response_loss_are_read_back_and_verified(self) -> None:
        class ResponseLossAws(FakeAws):
            lose_service: str | None = "capiro-dev-meriv2-orchestrator"

            def update_service(self, service: str, task_definition_name: str) -> None:
                super().update_service(service, task_definition_name)
                if service == self.lose_service:
                    self.lose_service = None
                    raise cohort.ReleaseError("simulated accepted update with lost response")

        aws = ResponseLossAws()
        apply_receipt = cohort.apply_release(aws, arguments(), self.capture(aws), 60)
        orchestrator = apply_receipt["services"]["capiro-dev-meriv2-orchestrator"]
        self.assertEqual(orchestrator["responseState"], "UNCONFIRMED")
        self.assertEqual(orchestrator["observedState"], "NEW_TASK_DEFINITION")
        self.assertTrue(orchestrator["verified"])
        run, artifacts = bind_receipt(apply_receipt)
        aws.lose_service = "capiro-dev-api"
        rollback_args = arguments(
            mode="rollback",
            receipt_run_id="123",
            rollback_confirmation="ROLLBACK_FIXED_SYNTHETIC_MERI_COHORT",
        )
        rollback = cohort.rollback_release(aws, rollback_args, apply_receipt, run, artifacts, 60)
        api = rollback["services"]["capiro-dev-api"]
        self.assertEqual(rollback["result"], "ROLLED_BACK_AND_VERIFIED")
        self.assertTrue(api["rollbackAttempted"])
        self.assertEqual(api["responseState"], "UNCONFIRMED")
        self.assertEqual(api["observedState"], "ROLLBACK_TASK_DEFINITION")
        self.assertTrue(api["verified"])
        self.assertNotEqual(api["toTaskDefinition"], cohort.full_td("capiro-dev-api:483"))

    def test_apply_final_authoritative_999_drift_cannot_be_verified(self) -> None:
        class FinalDriftAws(FakeAws):
            def __init__(self) -> None:
                super().__init__()
                self.armed: str | None = None
                self.post_update_reads = 0

            def update_service(self, service: str, task_definition_name: str) -> None:
                super().update_service(service, task_definition_name)
                self.armed = service
                self.post_update_reads = 0

            def describe_services(self, services: Sequence[str]) -> dict[str, Any]:
                result = super().describe_services(services)
                if self.armed in services:
                    self.post_update_reads += 1
                    if self.post_update_reads == 2:
                        value = next(
                            item for item in result["services"] if item["serviceName"] == self.armed
                        )
                        value["taskDefinition"] = cohort.full_td(f"{self.armed}:999")
                        value["deployments"][0]["taskDefinition"] = value["taskDefinition"]
                        self.armed = None
                return result

        aws = FinalDriftAws()
        with self.assertRaisesRegex(cohort.ReleaseError, "drifted") as caught:
            cohort.apply_release(aws, arguments(), self.capture(aws), 60)
        receipt = caught.exception.release_receipt
        entry = receipt["services"]["capiro-dev-meriv2-orchestrator"]
        self.assertEqual(receipt["result"], "PARTIAL_FAILURE")
        self.assertFalse(entry["verified"])

    def test_rollback_final_authoritative_999_drift_cannot_be_verified(self) -> None:
        class FinalDriftAws(FakeAws):
            drift_enabled = False

            def __init__(self) -> None:
                super().__init__()
                self.armed: str | None = None
                self.post_update_reads = 0

            def update_service(self, service: str, task_definition_name: str) -> None:
                super().update_service(service, task_definition_name)
                if self.drift_enabled:
                    self.armed = service
                    self.post_update_reads = 0

            def describe_services(self, services: Sequence[str]) -> dict[str, Any]:
                result = super().describe_services(services)
                if self.armed in services:
                    self.post_update_reads += 1
                    if self.post_update_reads == 2:
                        value = next(
                            item for item in result["services"] if item["serviceName"] == self.armed
                        )
                        value["taskDefinition"] = cohort.full_td(f"{self.armed}:999")
                        value["deployments"][0]["taskDefinition"] = value["taskDefinition"]
                        self.armed = None
                return result

        aws = FinalDriftAws()
        apply_receipt = cohort.apply_release(aws, arguments(), self.capture(aws), 60)
        run, artifacts = bind_receipt(apply_receipt)
        aws.drift_enabled = True
        rollback_args = arguments(
            mode="rollback",
            receipt_run_id="123",
            rollback_confirmation="ROLLBACK_FIXED_SYNTHETIC_MERI_COHORT",
        )
        with self.assertRaisesRegex(cohort.ReleaseError, "drifted") as caught:
            cohort.rollback_release(aws, rollback_args, apply_receipt, run, artifacts, 60)
        receipt = caught.exception.release_receipt
        self.assertEqual(receipt["result"], "PARTIAL_FAILURE")
        self.assertFalse(receipt["services"]["capiro-dev-api"]["verified"])

    def test_forged_receipt_wrong_run_and_wrong_workflow_metadata_are_refused(self) -> None:
        aws = FakeAws()
        receipt = cohort.apply_release(aws, arguments(), self.capture(aws), 60)
        run, artifacts = bind_receipt(receipt)
        cases = []
        forged = copy.deepcopy(receipt)
        forged["workflowSha"] = "e" * 40
        cases.append((forged, run, artifacts))
        wrong_run = copy.deepcopy(run)
        wrong_run["id"] = 124
        cases.append((receipt, wrong_run, artifacts))
        wrong_workflow = copy.deepcopy(run)
        wrong_workflow["path"] = ".github/workflows/other.yml"
        cases.append((receipt, wrong_workflow, artifacts))
        wrong_artifact = copy.deepcopy(artifacts)
        wrong_artifact["artifacts"][0]["workflow_run"]["id"] = 124
        cases.append((receipt, run, wrong_artifact))
        for candidate, run_value, artifact_value in cases:
            with self.subTest(candidate=candidate["workflowSha"], run=run_value["id"], path=run_value["path"]):
                with self.assertRaises(cohort.ReleaseError):
                    cohort.validate_receipt(candidate, "123", "1", run_value, artifact_value)

    def test_attempt_binding_uses_exact_attempt_metadata_and_unique_name(self) -> None:
        aws = FakeAws()
        receipt = cohort.apply_release(aws, arguments(), self.capture(aws), 60)
        run, artifacts = bind_receipt(receipt)
        self.assertNotIn("run_attempt", artifacts["artifacts"][0])
        selected = cohort.select_rollback_artifact("123", "1", run, artifacts)
        self.assertEqual(selected["artifactId"], 99)
        wrong_attempt = copy.deepcopy(run)
        wrong_attempt["run_attempt"] = 2
        with self.assertRaises(cohort.ReleaseError):
            cohort.select_rollback_artifact("123", "1", wrong_attempt, artifacts)
        wrong_receipt_attempt = copy.deepcopy(receipt)
        wrong_receipt_attempt["runAttempt"] = "2"
        wrong_receipt_attempt["artifactName"] = cohort.artifact_name("123", "2")
        with self.assertRaises(cohort.ReleaseError):
            cohort.validate_receipt(wrong_receipt_attempt, "123", "1", run, artifacts)
        previous_attempt = copy.deepcopy(artifacts)
        previous_attempt["artifacts"][0]["name"] = cohort.artifact_name("123", "2")
        with self.assertRaisesRegex(cohort.ReleaseError, "unique run-attempt"):
            cohort.select_rollback_artifact("123", "1", run, previous_attempt)

    def test_artifact_timestamp_and_duplicate_name_are_refused(self) -> None:
        aws = FakeAws()
        receipt = cohort.apply_release(aws, arguments(), self.capture(aws), 60)
        run, artifacts = bind_receipt(receipt)
        stale = copy.deepcopy(artifacts)
        stale["artifacts"][0]["created_at"] = "2026-09-27T23:59:00Z"
        with self.assertRaisesRegex(cohort.ReleaseError, "timestamps"):
            cohort.select_rollback_artifact("123", "1", run, stale)
        duplicate = copy.deepcopy(artifacts)
        duplicate["artifacts"].append(copy.deepcopy(duplicate["artifacts"][0]))
        duplicate["total_count"] = 2
        with self.assertRaisesRegex(cohort.ReleaseError, "unique run-attempt"):
            cohort.select_rollback_artifact("123", "1", run, duplicate)

    def test_rollback_refuses_receipt_bound_new_td_with_changed_config(self) -> None:
        aws = FakeAws()
        receipt = cohort.apply_release(aws, arguments(), self.capture(aws), 60)
        run, artifacts = bind_receipt(receipt)
        api_td = cohort.short_td(receipt["services"]["capiro-dev-api"]["registeredTaskDefinition"])
        target = aws.registered[api_td]["taskDefinition"]["containerDefinitions"][0]
        target["environment"][0]["value"] = "forged-model"
        writes_before = list(aws.writes)
        rollback_args = arguments(
            mode="rollback",
            receipt_run_id="123",
            rollback_confirmation="ROLLBACK_FIXED_SYNTHETIC_MERI_COHORT",
        )
        with self.assertRaisesRegex(cohort.ReleaseError, "content is not exact"):
            cohort.rollback_release(aws, rollback_args, receipt, run, artifacts, 60)
        self.assertEqual(aws.writes, writes_before)

    def test_rollback_refuses_arbitrary_current_task_definition(self) -> None:
        aws = FakeAws()
        receipt = cohort.apply_release(aws, arguments(), self.capture(aws), 60)
        run, artifacts = bind_receipt(receipt)
        aws.current["capiro-dev-api"] = "capiro-dev-api:999"
        rollback_args = arguments(
            mode="rollback",
            receipt_run_id="123",
            rollback_confirmation="ROLLBACK_FIXED_SYNTHETIC_MERI_COHORT",
        )
        with self.assertRaisesRegex(cohort.ReleaseError, "prior/new set"):
            cohort.rollback_release(aws, rollback_args, receipt, run, artifacts, 60)


class WorkflowContractTests(unittest.TestCase):
    def test_workflow_is_manual_main_fixed_repo_and_does_not_build_or_run_db(self) -> None:
        workflow = SCRIPT.parents[1] / ".github" / "workflows" / "meri-synthetic-cohort.yml"
        text = workflow.read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", text)
        self.assertIn("github.ref != 'refs/heads/main'", text)
        self.assertIn("github.repository != 'neo-capiro/capirov2'", text)
        self.assertIn("vars.AWS_DEV_GHA_ROLE_ARN", text)
        self.assertIn("GITHUB_TOKEN: ${{ github.token }}", text)
        self.assertIn("gh api --method GET", text)
        self.assertIn("--run-metadata", text)
        self.assertIn("--artifact-metadata", text)
        self.assertIn("/attempts/${INPUT_RECEIPT_RUN_ATTEMPT}", text)
        self.assertIn("actions/artifacts/${artifact_id}/zip", text)
        self.assertIn("synthetic-cohort-receipt-${{ github.run_id }}-${{ github.run_attempt }}", text)
        self.assertNotIn("actions/download-artifact", text)
        lowered = text.lower()
        for forbidden in ("docker build", "build-push-action", "cdk deploy", "prisma migrate", "ecs run-task"):
            self.assertNotIn(forbidden, lowered)


class ArtifactArchiveTests(unittest.TestCase):
    def write_archive(
        self, path: Path, receipt: Mapping[str, Any], plan: Mapping[str, Any], *, extra: bool = False
    ) -> dict[str, Any]:
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("plan.json", json.dumps(plan))
            archive.writestr("receipt.json", json.dumps(receipt))
            if extra:
                archive.writestr("../unexpected.json", "{}")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        return {
            "artifactId": 99,
            "artifactName": cohort.artifact_name("123", "1"),
            "archiveDigest": f"sha256:{digest}",
            "runId": "123",
            "runAttempt": "1",
        }

    def test_exact_archive_bytes_and_expected_files_are_accepted(self) -> None:
        aws = FakeAws()
        receipt = cohort.apply_release(
            aws, arguments(), cohort.capture_snapshot(aws, *original_expectations()), 60
        )
        bind_receipt(receipt)
        plan = cohort.make_plan(cohort.capture_snapshot(FakeAws(), *original_expectations()))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artifact.zip"
            selected = self.write_archive(path, receipt, plan)
            loaded, loaded_plan = cohort.load_rollback_archive(path, selected, selected)
        self.assertEqual(loaded, receipt)
        self.assertEqual(loaded_plan, plan)

    def test_archive_selection_tamper_digest_tamper_and_unexpected_file_fail_closed(self) -> None:
        plan = cohort.make_plan(cohort.capture_snapshot(FakeAws(), *original_expectations()))
        receipt = {"bounded": True}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artifact.zip"
            selected = self.write_archive(path, receipt, plan)
            changed_selection = dict(selected)
            changed_selection["artifactId"] = 100
            with self.assertRaisesRegex(cohort.ReleaseError, "selection"):
                cohort.load_rollback_archive(path, changed_selection, selected)
            path.write_bytes(path.read_bytes() + b"tamper")
            with self.assertRaisesRegex(cohort.ReleaseError, "SHA-256"):
                cohort.load_rollback_archive(path, selected, selected)
            selected = self.write_archive(path, receipt, plan, extra=True)
            with self.assertRaisesRegex(cohort.ReleaseError, "exact expected files"):
                cohort.load_rollback_archive(path, selected, selected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
