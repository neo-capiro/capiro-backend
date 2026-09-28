#!/usr/bin/env python3
"""Offline guards for the fixed synthetic fullChat workflow runner."""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Sequence
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("meri-synthetic-fullchat.py")
SPEC = importlib.util.spec_from_file_location("meri_synthetic_fullchat", SCRIPT)
assert SPEC and SPEC.loader
fullchat = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = fullchat
SPEC.loader.exec_module(fullchat)


def states(first: Any = None, second: Any = False) -> list[dict[str, Any]]:
    values = []
    for (tenant_id, slug), value in zip(fullchat.TENANTS, (first, second)):
        state = {"present": False} if value is None else {"present": True, "value": value}
        values.append({"tenantId": tenant_id, "tenantSlug": slug, "flag": fullchat.FLAG, "state": state})
    return values


def db_result(mode: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> str:
    result = {
        "plan": "PLAN_ONLY",
        "apply": "APPLIED_AND_VERIFIED",
        "rollback": "ROLLED_BACK_AND_VERIFIED",
    }[mode]
    value = {
        "schemaVersion": 1,
        "operation": "meri-foundation-fullchat",
        "mode": mode,
        "result": result,
        "flag": fullchat.FLAG,
        "tenants": [
            {
                "tenantId": tenant_id,
                "tenantSlug": slug,
                "before": before[index]["state"],
                "after": after[index]["state"],
            }
            for index, (tenant_id, slug) in enumerate(fullchat.TENANTS)
        ],
    }
    return fullchat.RESULT_PREFIX + json.dumps(value, separators=(",", ":"))


def trusted_metadata(mode: str = "plan") -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    run = {
        "id": 123,
        "run_attempt": 1,
        "event": "workflow_dispatch",
        "head_branch": "main",
        "head_sha": "f" * 40,
        "path": fullchat.WORKFLOW_PATH,
        "status": "completed",
        "conclusion": "success",
        "repository": {"id": 10, "full_name": fullchat.REPOSITORY},
        "head_repository": {"id": 10, "full_name": fullchat.REPOSITORY},
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
                "name": fullchat.artifact_name("123", "1"),
                "digest": f"sha256:{'a' * 64}",
                "expired": False,
                "created_at": "2026-09-28T00:09:00Z",
                "updated_at": "2026-09-28T00:09:30Z",
                "workflow_run": {
                    "id": 123,
                    "head_sha": run["head_sha"],
                    "head_branch": "main",
                    "repository_id": 10,
                    "head_repository_id": 10,
                },
            }
        ],
    }
    receipt = {
        "schemaVersion": 1,
        "workflow": fullchat.WORKFLOW_NAME,
        "workflowPath": fullchat.WORKFLOW_PATH,
        "repository": fullchat.REPOSITORY,
        "runId": "123",
        "runAttempt": "1",
        "artifactName": fullchat.artifact_name("123", "1"),
        "workflowSha": run["head_sha"],
        "actor": "release-lead",
        "actorId": "42",
        "mode": mode,
        "result": "PLANNED_AND_VERIFIED" if mode == "plan" else "APPLIED_AND_VERIFIED",
        "verified": True,
        "target": {"account": fullchat.ACCOUNT_ID, "region": fullchat.REGION, "cluster": fullchat.CLUSTER},
        "flag": fullchat.FLAG,
        "tenants": [
            {"tenantId": tenant_id, "tenantSlug": slug} for tenant_id, slug in fullchat.TENANTS
        ],
        "qualifiedTaskDefinition": (
            f"arn:aws:ecs:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:task-definition/"
            f"{fullchat.TASK_FAMILY}:50"
        ),
        "imageDigest": f"sha256:{'b' * 64}",
        "imageSourceCommit": "e" * 40,
        "taskArn": (
            f"arn:aws:ecs:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:task/"
            f"{fullchat.CLUSTER}/{'c' * 32}"
        ),
        "priorStates": states(),
    }
    receipt["readback"] = json.loads(
        db_result(mode, states(), states() if mode == "plan" else states(True, True))[
            len(fullchat.RESULT_PREFIX):
        ]
    )
    return run, artifacts, receipt


class FixedCommandTests(unittest.TestCase):
    def test_plan_apply_and_rollback_commands_are_fixed(self) -> None:
        expected = states()
        self.assertEqual(
            fullchat.command_for("plan", None),
            ["set-tenant-flag", "--foundation-fullchat"],
        )
        apply = fullchat.command_for("apply", expected)
        rollback = fullchat.command_for("rollback", expected)
        self.assertEqual(apply[:5], ["set-tenant-flag", "--foundation-fullchat", "--mode", "apply", "--confirmation"])
        self.assertEqual(apply[5], fullchat.APPLY_CONFIRMATION)
        self.assertEqual(rollback[5], fullchat.ROLLBACK_CONFIRMATION)
        for command in (apply, rollback):
            text = " ".join(command)
            self.assertNotIn("--slug", text)
            self.assertNotIn("--flag", text)
            self.assertNotIn("http", text)
            self.assertNotIn("sh -c", text)
            self.assertEqual(command[-2], "--expected-state")
            self.assertNotIn("=", command[-1])

    def test_sanitized_readback_rejects_wrong_tenant_extra_fields_and_non_true_apply(self) -> None:
        prior = states()
        applied = states(True, True)
        value, before, after = fullchat.parse_db_result([db_result("apply", prior, applied)], "apply")
        self.assertEqual(value["flag"], fullchat.FLAG)
        self.assertEqual(before, prior)
        self.assertEqual(after, applied)
        wrong = json.loads(db_result("apply", prior, applied)[len(fullchat.RESULT_PREFIX):])
        wrong["tenants"][0]["tenantSlug"] = "other"
        with self.assertRaises(fullchat.FullchatError):
            fullchat.parse_db_result([fullchat.RESULT_PREFIX + json.dumps(wrong)], "apply")
        extra = copy.deepcopy(wrong)
        extra["tenants"][0]["tenantSlug"] = fullchat.TENANTS[0][1]
        extra["tenants"][0]["wholeSettings"] = {"secret": True}
        with self.assertRaises(fullchat.FullchatError):
            fullchat.parse_db_result([fullchat.RESULT_PREFIX + json.dumps(extra)], "apply")
        for root_field in ("settings_jsonb", "credentials", "arbitrary"):
            with self.subTest(root_field=root_field):
                root_extra = json.loads(db_result("apply", prior, applied)[len(fullchat.RESULT_PREFIX):])
                root_extra[root_field] = {"secret": "must-not-survive"}
                with self.assertRaises(fullchat.FullchatError):
                    fullchat.parse_db_result(
                        [fullchat.RESULT_PREFIX + json.dumps(root_extra)], "apply"
                    )
        false_after = states(False, True)
        with self.assertRaisesRegex(fullchat.FullchatError, "literal boolean true"):
            fullchat.parse_db_result([db_result("apply", prior, false_after)], "apply")

    def test_rollback_readback_distinguishes_absent_false_and_prior_json(self) -> None:
        prior = states(None, {"legacy": "value"})
        applied = states(True, True)
        _, before, after = fullchat.parse_db_result([db_result("rollback", applied, prior)], "rollback")
        self.assertEqual(before, applied)
        self.assertEqual(after, prior)
        self.assertEqual(after[0]["state"], {"present": False})
        self.assertEqual(after[1]["state"], {"present": True, "value": {"legacy": "value"}})


class ArtifactBindingTests(unittest.TestCase):
    def test_exact_attempt_artifact_and_receipt_are_bound(self) -> None:
        run, artifacts, receipt = trusted_metadata()
        selection = fullchat.select_artifact("123", "1", run, artifacts)
        expected = fullchat.validate_source_receipt(receipt, run, selection, "plan")
        self.assertEqual(expected, states())
        run, artifacts, receipt = trusted_metadata("apply")
        selection = fullchat.select_artifact("123", "1", run, artifacts)
        self.assertEqual(fullchat.validate_source_receipt(receipt, run, selection, "apply"), states())

    def test_source_receipt_rejects_untrusted_readback_root_fields(self) -> None:
        run, artifacts, receipt = trusted_metadata()
        selection = fullchat.select_artifact("123", "1", run, artifacts)
        receipt["readback"]["settings_jsonb"] = {"credential": "must-not-survive"}
        with self.assertRaises(fullchat.FullchatError):
            fullchat.validate_source_receipt(receipt, run, selection, "plan")

    def test_wrong_attempt_workflow_digest_and_actor_are_refused(self) -> None:
        run, artifacts, receipt = trusted_metadata()
        cases = []
        wrong_attempt = copy.deepcopy(run)
        wrong_attempt["run_attempt"] = 2
        cases.append((wrong_attempt, artifacts, receipt))
        wrong_path = copy.deepcopy(run)
        wrong_path["path"] = ".github/workflows/other.yml"
        cases.append((wrong_path, artifacts, receipt))
        wrong_artifact = copy.deepcopy(artifacts)
        wrong_artifact["artifacts"][0]["workflow_run"]["head_sha"] = "e" * 40
        cases.append((run, wrong_artifact, receipt))
        for run_value, artifact_value, _ in cases:
            with self.subTest(run=run_value["run_attempt"], path=run_value["path"]):
                with self.assertRaises(fullchat.FullchatError):
                    fullchat.select_artifact("123", "1", run_value, artifact_value)
        selection = fullchat.select_artifact("123", "1", run, artifacts)
        forged = copy.deepcopy(receipt)
        forged["actorId"] = "99"
        with self.assertRaises(fullchat.FullchatError):
            fullchat.validate_source_receipt(forged, run, selection, "plan")


class AckLossTests(unittest.TestCase):
    def test_run_task_ack_loss_reconciles_once_without_blind_repeat(self) -> None:
        class AckLostAws(fullchat.AwsCli):
            def __init__(self) -> None:
                self.run_calls = 0
                self.list_calls = 0

            def _json(self, args: Sequence[str]) -> dict[str, Any]:
                if args[:2] == ("ecs", "run-task"):
                    self.run_calls += 1
                    raise fullchat.FullchatError("simulated response loss")
                if args[:2] == ("ecs", "list-tasks"):
                    self.list_calls += 1
                    return {
                        "taskArns": [
                            f"arn:aws:ecs:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:task/{fullchat.CLUSTER}/{'a' * 32}"
                        ]
                    }
                raise AssertionError(args)

        aws = AckLostAws()
        task = aws.run_task(
            f"arn:aws:ecs:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:task-definition/{fullchat.TASK_FAMILY}:1",
            {"awsvpcConfiguration": {"subnets": ["subnet-fixed"], "securityGroups": ["sg-fixed"], "assignPublicIp": "DISABLED"}},
            fullchat.command_for("plan", None),
            "meri-fullchat-123-1-plan",
        )
        self.assertTrue(task.endswith("a" * 32))
        self.assertEqual(aws.run_calls, 1)
        self.assertEqual(aws.list_calls, 1)

    def test_ambiguous_ack_never_retries(self) -> None:
        class AmbiguousAws(fullchat.AwsCli):
            def __init__(self) -> None:
                self.run_calls = 0

            def _json(self, args: Sequence[str]) -> dict[str, Any]:
                if args[:2] == ("ecs", "run-task"):
                    self.run_calls += 1
                    raise fullchat.FullchatError("simulated response loss")
                return {"taskArns": []}

        aws = AmbiguousAws()
        with self.assertRaisesRegex(fullchat.FullchatError, "no retry"):
            aws.run_task("fixed", {"awsvpcConfiguration": {}}, fullchat.command_for("plan", None), "fixed-token")
        self.assertEqual(aws.run_calls, 1)


class RuntimeQualificationTests(unittest.TestCase):
    class Git:
        def run(self, args: Sequence[str]) -> str:
            if args[:1] == ("show",):
                path = args[1].split(":", 1)[1]
                if path.endswith("set-tenant-flag.ts"):
                    return "if (process.argv.includes('--foundation-fullchat')) {}"
                if path.endswith("set-tenant-flag-foundation.ts"):
                    return fullchat.FLAG
                return "set-tenant-flag)"
            return ""

    class Aws:
        digest = f"sha256:{'a' * 64}"
        sha = "f" * 40
        role = f"arn:aws:iam::{fullchat.ACCOUNT_ID}:role/api-task"
        execution = f"arn:aws:iam::{fullchat.ACCOUNT_ID}:role/api-execution"

        def __init__(self) -> None:
            self.entrypoint: list[str] | None = None

        def describe_service(self) -> dict[str, Any]:
            return {
                "services": [{
                    "serviceArn": f"arn:aws:ecs:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:service/{fullchat.CLUSTER}/{fullchat.SERVICE}",
                    "clusterArn": f"arn:aws:ecs:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:cluster/{fullchat.CLUSTER}",
                    "taskDefinition": f"arn:aws:ecs:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:task-definition/{fullchat.SERVICE}:500",
                    "desiredCount": 1,
                    "runningCount": 1,
                    "pendingCount": 0,
                    "deployments": [{
                        "status": "PRIMARY",
                        "taskDefinition": f"arn:aws:ecs:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:task-definition/{fullchat.SERVICE}:500",
                        "rolloutState": "COMPLETED",
                        "desiredCount": 1,
                        "runningCount": 1,
                        "pendingCount": 0,
                    }],
                    "networkConfiguration": {"awsvpcConfiguration": {
                        "subnets": ["subnet-fixed"], "securityGroups": ["sg-fixed"], "assignPublicIp": "DISABLED"
                    }},
                }],
                "failures": [],
            }

        def list_tasks(self, *args: str) -> list[str]:
            return [f"arn:aws:ecs:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:task/{fullchat.CLUSTER}/{'b' * 32}"]

        def describe_tasks(self, tasks: Sequence[str]) -> dict[str, Any]:
            return {"tasks": [{
                "taskArn": tasks[0],
                "taskDefinitionArn": f"arn:aws:ecs:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:task-definition/{fullchat.SERVICE}:500",
                "lastStatus": "RUNNING",
                "desiredStatus": "RUNNING",
                "containers": [{"name": "api", "imageDigest": self.digest}],
            }], "failures": []}

        def db_secrets(self, include_vendor: bool = False) -> list[dict[str, str]]:
            values = [
                {"name": name, "valueFrom": f"arn:aws:secretsmanager:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:secret:db:{name}::"}
                for name in ("DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD")
            ]
            if include_vendor:
                values.append({"name": "VENDOR_KEY", "valueFrom": "vendor"})
            return values

        def describe_task_definition(self, name: str) -> dict[str, Any]:
            if fullchat.TASK_FAMILY not in name:
                return {"taskDefinition": {
                    "taskDefinitionArn": f"arn:aws:ecs:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:task-definition/{fullchat.SERVICE}:500",
                    "taskRoleArn": self.role,
                    "executionRoleArn": self.execution,
                    "containerDefinitions": [{
                        "name": "api",
                        "image": f"{fullchat.IMAGE_REPOSITORY}:latest",
                        "environment": [{"name": "DB_NAME", "value": "capiro"}, {"name": "GIT_SHA", "value": self.sha}],
                        "secrets": self.db_secrets(include_vendor=True),
                    }],
                }}
            container = {
                "name": fullchat.CONTAINER,
                "image": f"{fullchat.IMAGE_REPOSITORY}@{self.digest}",
                "environment": [{"name": "DB_NAME", "value": "capiro"}, {"name": "GIT_SHA", "value": self.sha}],
                "secrets": self.db_secrets(),
                "logConfiguration": {"logDriver": "awslogs", "options": {
                    "awslogs-group": "/capiro/dev/api", "awslogs-stream-prefix": "diag"
                }},
            }
            if self.entrypoint is not None:
                container["entryPoint"] = self.entrypoint
            return {"taskDefinition": {
                "taskDefinitionArn": f"arn:aws:ecs:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:task-definition/{fullchat.TASK_FAMILY}:50",
                "status": "ACTIVE",
                "networkMode": "awsvpc",
                "requiresCompatibilities": ["FARGATE"],
                "taskRoleArn": self.role,
                "executionRoleArn": self.execution,
                "containerDefinitions": [container],
            }}

    def test_runtime_requires_same_digest_source_roles_credentials_and_default_entrypoint(self) -> None:
        aws = self.Aws()
        runtime = fullchat.capture_runtime(aws, self.Git())
        self.assertEqual(runtime["imageDigest"], aws.digest)
        self.assertEqual(runtime["sourceCommit"], aws.sha)
        aws.entrypoint = ["node", "-e"]
        with self.assertRaisesRegex(fullchat.FullchatError, "entrypoint"):
            fullchat.capture_runtime(aws, self.Git())

    def test_runtime_rejects_extra_containers_duplicate_names_and_plaintext_db_shadows(self) -> None:
        class Mutant(self.Aws):
            def __init__(self, mutation: Any) -> None:
                super().__init__()
                self.mutation = mutation

            def describe_task_definition(self, name: str) -> dict[str, Any]:
                response = super().describe_task_definition(name)
                if fullchat.TASK_FAMILY in name:
                    self.mutation(response["taskDefinition"])
                return response

        mutations = {
            "extra executable container": lambda td: td["containerDefinitions"].append(
                {"name": "rogue", "image": f"evil@sha256:{'d' * 64}", "command": ["arbitrary"]}
            ),
            "plaintext DB_HOST shadow": lambda td: td["containerDefinitions"][0]["environment"].append(
                {"name": "DB_HOST", "value": "attacker-db"}
            ),
            "duplicate DB_NAME": lambda td: td["containerDefinitions"][0]["environment"].extend(
                [{"name": "DB_NAME", "value": "wrong"}, {"name": "DB_NAME", "value": "capiro"}]
            ),
            "duplicate DB_HOST secret": lambda td: td["containerDefinitions"][0]["secrets"].insert(
                0, {"name": "DB_HOST", "valueFrom": "wrong-secret"}
            ),
            "wrong image repository": lambda td: td["containerDefinitions"][0].update(
                image=f"evil@sha256:{'a' * 64}"
            ),
            "single wrong DB credential reference": lambda td: td["containerDefinitions"][0][
                "secrets"
            ].__setitem__(0, {"name": "DB_HOST", "valueFrom": "wrong-secret"}),
            "single wrong DB_NAME": lambda td: td["containerDefinitions"][0][
                "environment"
            ].__setitem__(0, {"name": "DB_NAME", "value": "wrong"}),
            "entrypoint override": lambda td: td["containerDefinitions"][0].update(
                entryPoint=["/bin/sh", "-c"]
            ),
        }
        for label, mutation in mutations.items():
            with self.subTest(label=label):
                with self.assertRaises(fullchat.FullchatError):
                    fullchat.capture_runtime(Mutant(mutation), self.Git())


class MainReceiptTests(unittest.TestCase):
    task_arn = (
        f"arn:aws:ecs:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:task/"
        f"{fullchat.CLUSTER}/{'a' * 32}"
    )
    task_definition = (
        f"arn:aws:ecs:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:task-definition/"
        f"{fullchat.TASK_FAMILY}:50"
    )
    image = f"{fullchat.IMAGE_REPOSITORY}@sha256:{'b' * 64}"
    runtime = {
        "taskDefinition": task_definition,
        "image": image,
        "imageDigest": f"sha256:{'b' * 64}",
        "sourceCommit": "e" * 40,
        "network": {"awsvpcConfiguration": {
            "subnets": ["subnet-fixed"],
            "securityGroups": ["sg-fixed"],
            "assignPublicIp": "DISABLED",
        }},
        "logGroup": "/capiro/dev/api",
        "logPrefix": "diag",
    }

    class Aws:
        def identity(self) -> dict[str, str]:
            return {"Account": fullchat.ACCOUNT_ID}

        def run_task(self, *args: Any) -> str:
            return MainReceiptTests.task_arn

    def stopped_task(self, extra: bool = False, exit_code: int = 0) -> dict[str, Any]:
        containers = [{
            "name": fullchat.CONTAINER,
            "lastStatus": "STOPPED",
            "exitCode": exit_code,
            "image": self.image,
            "imageDigest": self.runtime["imageDigest"],
        }]
        if extra:
            containers.append({
                "name": "rogue",
                "lastStatus": "STOPPED",
                "exitCode": 0,
                "image": f"evil@sha256:{'c' * 64}",
                "imageDigest": f"sha256:{'c' * 64}",
            })
        return {
            "taskArn": self.task_arn,
            "clusterArn": f"arn:aws:ecs:{fullchat.REGION}:{fullchat.ACCOUNT_ID}:cluster/{fullchat.CLUSTER}",
            "taskDefinitionArn": self.task_definition,
            "startedBy": "meri-fullchat-321-1-plan",
            "launchType": "FARGATE",
            "lastStatus": "STOPPED",
            "stopCode": "EssentialContainerExited",
            "containers": containers,
        }

    def run_main(self, messages: Sequence[str], task: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        with tempfile.TemporaryDirectory() as folder:
            with (
                patch.dict(os.environ, {
                    "GITHUB_RUN_ID": "321",
                    "GITHUB_RUN_ATTEMPT": "1",
                    "GITHUB_SHA": "f" * 40,
                    "GITHUB_ACTOR": "review",
                    "GITHUB_ACTOR_ID": "42",
                }),
                patch.object(fullchat, "GitCli", return_value=object()),
                patch.object(fullchat, "verify_execution_context", return_value="f" * 40),
                patch.object(fullchat, "AwsCli", self.Aws),
                patch.object(fullchat, "capture_runtime", return_value=self.runtime),
                patch.object(fullchat, "wait_for_task", return_value=task),
                patch.object(fullchat, "wait_for_log_messages", return_value=messages),
            ):
                status = fullchat.main([
                    "--mode", "plan",
                    "--output-dir", folder,
                    "--wait-timeout-seconds", "60",
                ])
            receipt = json.loads((Path(folder) / "receipt.json").read_text(encoding="utf-8"))
        return status, receipt

    def test_main_requires_exact_stopped_container_set(self) -> None:
        message = db_result("plan", states(), states())
        status, receipt = self.run_main([message], self.stopped_task(extra=True))
        self.assertEqual(status, 2)
        self.assertEqual(receipt["result"], "FAILED")
        self.assertIs(receipt["verified"], False)

    def test_main_reconstructs_sanitized_receipt_and_rejects_hostile_root(self) -> None:
        message = db_result("plan", states(), states())
        status, receipt = self.run_main([message], self.stopped_task())
        self.assertEqual(status, 0)
        self.assertIs(receipt["verified"], True)
        self.assertEqual(set(receipt["readback"]), set(fullchat.DB_RESULT_KEYS))

        hostile = json.loads(message[len(fullchat.RESULT_PREFIX):])
        hostile["settings_jsonb"] = {"credential": "must-not-survive"}
        status, receipt = self.run_main(
            [fullchat.RESULT_PREFIX + json.dumps(hostile)], self.stopped_task()
        )
        self.assertEqual(status, 2)
        self.assertEqual(receipt["result"], "FAILED")
        self.assertIs(receipt["verified"], False)

    def test_main_fails_closed_on_duplicate_absent_result_and_nonzero_exit(self) -> None:
        message = db_result("plan", states(), states())
        cases = {
            "duplicate result": ([message, message], self.stopped_task()),
            "absent result": (["no result"], self.stopped_task()),
            "nonzero exit": ([message], self.stopped_task(exit_code=1)),
        }
        for label, (messages, task) in cases.items():
            with self.subTest(label=label):
                status, receipt = self.run_main(messages, task)
                self.assertEqual(status, 2)
                self.assertEqual(receipt["result"], "FAILED")
                self.assertIs(receipt["verified"], False)


class WorkflowContractTests(unittest.TestCase):
    def test_workflow_has_only_fixed_inputs_and_no_build_migration_or_registration(self) -> None:
        workflow = SCRIPT.parents[1] / ".github" / "workflows" / "meri-synthetic-fullchat.yml"
        text = workflow.read_text(encoding="utf-8")
        self.assertIn("github.repository != 'neo-capiro/capirov2'", text)
        self.assertIn("github.ref != 'refs/heads/main'", text)
        self.assertIn('test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"', text)
        self.assertIn("--select-source-artifact", text)
        self.assertIn("actions/artifacts/${artifact_id}/zip", text)
        self.assertIn("synthetic-fullchat-receipt-${{ github.run_id }}-${{ github.run_attempt }}", text)
        for forbidden_input in ("tenant_slug", "tenant_id", "flag:", "script:", "shell:", "url:", "task_definition:", "image_digest:"):
            self.assertNotIn(forbidden_input, text.lower())
        for forbidden_operation in ("docker build", "build-push-action", "prisma migrate", "register-task-definition", "update-service", "cdk deploy"):
            self.assertNotIn(forbidden_operation, text.lower())

    def test_existing_cohort_workflow_stays_independent(self) -> None:
        workflow = SCRIPT.parents[1] / ".github" / "workflows" / "meri-synthetic-cohort.yml"
        text = workflow.read_text(encoding="utf-8")
        self.assertNotIn("meri-synthetic-fullchat", text)
        self.assertNotIn("set-tenant-flag", text)
        self.assertIn("lead_preflight_confirmation", text)
        self.assertIn("lead_preflight_receipt", text)

    def test_existing_generic_owner_and_entrypoint_contract_remain(self) -> None:
        root = SCRIPT.parents[1]
        owner = (root / "apps/api/scripts/set-tenant-flag.ts").read_text(encoding="utf-8")
        fixed = (root / "apps/api/scripts/set-tenant-flag-foundation.ts").read_text(encoding="utf-8")
        dispatcher = (root / "apps/api/scripts/entrypoint-dispatcher.inc").read_text(encoding="utf-8")
        dockerfile = (root / "apps/api/Dockerfile").read_text(encoding="utf-8")
        self.assertIn("--slug <tenant-slug> --flag <flag.key> --value <true|false> [--commit]", owner)
        self.assertIn("set_config('app.bypass_rls', 'on', true)", owner)
        self.assertIn("if (process.argv.includes('--foundation-fullchat'))", owner)
        self.assertIn("set_config('app.current_tenant', $1, true)", fixed)
        self.assertIn("set_config('app.bypass_rls', 'off', true)", fixed)
        self.assertIn("FOR UPDATE", fixed)
        self.assertIn("Prisma.TransactionIsolationLevel.Serializable", fixed)
        self.assertIn("settings_jsonb #- ARRAY['clioFeatureFlags', $3]", fixed)
        self.assertIn("set-tenant-flag)\n    shift", dispatcher)
        self.assertIn("exec ./node_modules/.bin/tsx scripts/set-tenant-flag.ts \"$@\"", dispatcher)
        self.assertIn("COPY --chown=capiro:capiro --from=build /workspace/apps/api/scripts", dockerfile)
        self.assertIn('CMD ["serve"]', dockerfile)


if __name__ == "__main__":
    unittest.main(verbosity=2)
