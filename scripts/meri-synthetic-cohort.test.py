#!/usr/bin/env python3
"""Offline unit tests for the synthetic Meri cohort release runner."""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import sys
import unittest
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
        revision = prior_revision(family) + 1
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

    def describe_ecr_tag(self, repository: str, tag: str) -> dict[str, Any]:
        return {"imageDetails": [{"imageDigest": cohort.EXPECTED["capiro-dev-api"]["digest"]}]}


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
    }
    values.update(overrides)
    return argparse.Namespace(**values)


def original_expectations() -> tuple[dict[str, str], dict[str, str]]:
    return (
        {name: cohort.EXPECTED[name]["taskDefinition"] for name in cohort.SERVICES},
        {name: cohort.EXPECTED[name]["digest"] for name in cohort.SERVICES},
    )


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
                ("register", "capiro-dev-meriv2-orchestrator"),
                ("register", "capiro-dev-api"),
                ("update", "capiro-dev-meriv2-orchestrator"),
                ("update", "capiro-dev-api"),
            ],
        )
        self.assertEqual(receipt["result"], "APPLIED_AND_VERIFIED")
        self.assertTrue(all(item["verified"] for item in receipt["services"].values()))

    def test_drift_fails_before_any_mutation(self) -> None:
        aws = FakeAws()
        aws.definitions["capiro-dev-api"] = task_definition("capiro-dev-api", cohort_value="wrong")
        with self.assertRaises(cohort.ReleaseError):
            cohort.apply_release(aws, arguments(), self.capture(aws), 60)
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

    def test_partial_outcome_records_orchestrator_and_rollback_command(self) -> None:
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
        self.assertTrue(orchestrator["updateRequested"])
        self.assertTrue(orchestrator["verified"])
        self.assertIn("capiro-dev-meriv2-orchestrator:84", orchestrator["rollbackCommand"])
        self.assertTrue(receipt["services"]["capiro-dev-api"]["updateAttempted"])
        self.assertFalse(receipt["services"]["capiro-dev-api"]["updateRequested"])

    def test_unapproved_service_family_cannot_be_registered(self) -> None:
        with self.assertRaises(cohort.ReleaseError):
            cohort.validate_new_td_arn(
                "capiro-dev-api",
                f"arn:aws:ecs:{cohort.REGION}:{cohort.ACCOUNT_ID}:task-definition/capiro-prod-api:484",
            )

    def test_rollback_receipt_cannot_supply_arbitrary_prior(self) -> None:
        receipt = {
            "schemaVersion": 1,
            "workflow": cohort.WORKFLOW_NAME,
            "repository": cohort.REPOSITORY,
            "runId": "123",
            "mode": "apply",
            "result": "APPLIED_AND_VERIFIED",
            "target": {"account": cohort.ACCOUNT_ID, "region": cohort.REGION, "cluster": cohort.CLUSTER},
            "tenants": list(cohort.TENANTS),
            "services": {},
        }
        for name in cohort.SERVICES:
            receipt["services"][name] = {
                "priorTaskDefinition": cohort.full_td(cohort.EXPECTED[name]["taskDefinition"]),
                "priorDigest": cohort.EXPECTED[name]["digest"],
                "registeredTaskDefinition": td_arn(name, prior_revision(name) + 1),
                "updateRequested": True,
            }
        receipt["services"]["capiro-dev-api"]["priorTaskDefinition"] = td_arn("capiro-dev-api", 1)
        with self.assertRaisesRegex(cohort.ReleaseError, "fixed reviewed prior"):
            cohort.validate_receipt(receipt, "123")

    def test_rollback_refuses_mutable_latest_drift_before_update(self) -> None:
        class LatestDriftAws(FakeAws):
            def describe_ecr_tag(self, repository: str, tag: str) -> dict[str, Any]:
                return {"imageDetails": [{"imageDigest": f"sha256:{'b' * 64}"}]}

        aws = LatestDriftAws()
        snapshot = self.capture(aws)
        with self.assertRaisesRegex(cohort.ReleaseError, "latest no longer resolves"):
            cohort.verify_api_latest_for_rollback(aws, snapshot)
        self.assertEqual(aws.writes, [])


class WorkflowContractTests(unittest.TestCase):
    def test_workflow_is_manual_main_fixed_repo_and_does_not_build_or_run_db(self) -> None:
        workflow = SCRIPT.parents[1] / ".github" / "workflows" / "meri-synthetic-cohort.yml"
        text = workflow.read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", text)
        self.assertIn("github.ref != 'refs/heads/main'", text)
        self.assertIn("github.repository != 'neo-capiro/capirov2'", text)
        self.assertIn("vars.AWS_DEV_GHA_ROLE_ARN", text)
        lowered = text.lower()
        for forbidden in ("docker build", "build-push-action", "cdk deploy", "prisma migrate", "ecs run-task"):
            self.assertNotIn(forbidden, lowered)


if __name__ == "__main__":
    unittest.main(verbosity=2)
