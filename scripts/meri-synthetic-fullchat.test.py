#!/usr/bin/env python3
"""Offline guards for the fixed synthetic fullChat workflow runner."""

from __future__ import annotations

import copy
import hashlib
import http.server
import importlib.util
import json
import os
import re
import sys
import tempfile
import threading
import unittest
import uuid
import zipfile
from pathlib import Path
from typing import Any, Sequence
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("meri-synthetic-fullchat.py")
SPEC = importlib.util.spec_from_file_location("meri_synthetic_fullchat", SCRIPT)
assert SPEC and SPEC.loader
fullchat = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = fullchat
SPEC.loader.exec_module(fullchat)



# Deliberately independent of the wrapper constants: these are the approved
# identities used by the image-owned TypeScript flag command.
CANONICAL_TENANTS = (
    ("f2d6cf8f-057c-479a-8110-62fe5086d43f", "meri-foundation-20260928-t1"),
    ("52e91176-08f0-4d89-9633-bc212f5bdbbf", "meri-foundation-20260928-t2"),
)


class FixedTenantIdentityTests(unittest.TestCase):
    def test_wrapper_matches_canonical_image_owner_identities(self) -> None:
        owner = SCRIPT.parents[1] / "apps/api/scripts/set-tenant-flag-foundation.ts"
        source = owner.read_text(encoding="utf-8")
        definition = source.split("export const FOUNDATION_FULLCHAT_TENANTS = [", 1)[1].split("] as const;", 1)[0]
        owner_pairs = tuple(re.findall(r"id: '([^']+)',\s*slug: '([^']+)'", definition))
        self.assertEqual(owner_pairs, CANONICAL_TENANTS)
        self.assertEqual(fullchat.TENANTS, CANONICAL_TENANTS)
        for tenant_id, _ in fullchat.TENANTS:
            self.assertEqual(str(uuid.UUID(tenant_id)), tenant_id)

    def test_accepts_actual_owner_receipt_with_canonical_tenant_ids(self) -> None:
        receipt = {
            "schemaVersion": 1,
            "operation": "meri-foundation-fullchat",
            "mode": "plan",
            "result": "PLAN_ONLY",
            "flag": "meriv3.fullChat",
            "tenants": [
                {
                    "tenantId": tenant_id,
                    "tenantSlug": slug,
                    "before": {"present": False},
                    "after": {"present": False},
                }
                for tenant_id, slug in CANONICAL_TENANTS
            ],
        }
        actual, before, after = fullchat.parse_db_result(
            ["MERI_FOUNDATION_FULLCHAT_RESULT=" + json.dumps(receipt)], "plan"
        )
        self.assertEqual(actual, receipt)
        self.assertEqual(before, after)
        self.assertEqual(tuple((item["tenantId"], item["tenantSlug"]) for item in before), CANONICAL_TENANTS)


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


def trusted_build_metadata(
    archive_digest: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    run = {
        "id": 777,
        "run_attempt": 2,
        "event": "push",
        "head_branch": "main",
        "head_sha": "e" * 40,
        "path": fullchat.API_IMAGE_WORKFLOW_PATH,
        "status": "completed",
        "conclusion": "success",
        "repository": {"id": 10, "full_name": fullchat.REPOSITORY},
        "head_repository": {"id": 10, "full_name": fullchat.REPOSITORY},
        "created_at": "2026-09-27T23:00:00Z",
        "run_started_at": "2026-09-27T23:00:01Z",
        "updated_at": "2026-09-27T23:10:00Z",
    }
    artifacts = {
        "total_count": 1,
        "artifacts": [{
            "id": 88,
            "name": fullchat.build_artifact_name("777", "2"),
            "digest": archive_digest or f"sha256:{'d' * 64}",
            "expired": False,
            "created_at": "2026-09-27T23:09:00Z",
            "updated_at": "2026-09-27T23:09:30Z",
            "workflow_run": {
                "id": 777,
                "head_sha": run["head_sha"],
                "head_branch": "main",
                "repository_id": 10,
                "head_repository_id": 10,
            },
        }],
    }
    digest = f"sha256:{'b' * 64}"
    record = {
        "schemaVersion": fullchat.API_IMAGE_SCHEMA_VERSION,
        "source": {
            "repository": fullchat.REPOSITORY,
            "ref": "refs/heads/main",
            "commit": run["head_sha"],
        },
        "build": {
            "context": ".",
            "dockerfile": "apps/api/Dockerfile",
            "platform": "linux/arm64",
        },
        "image": {
            "repository": fullchat.IMAGE_REPOSITORY,
            "digest": digest,
            "uri": f"{fullchat.IMAGE_REPOSITORY}@{digest}",
        },
        "environment": "dev",
        "workflow": {
            "name": fullchat.API_IMAGE_WORKFLOW_NAME,
            "path": fullchat.API_IMAGE_WORKFLOW_PATH,
            "runId": 777,
            "runAttempt": 2,
        },
    }
    return run, artifacts, record


def trusted_build_proof() -> dict[str, Any]:
    run, artifacts, record = trusted_build_metadata()
    selection = fullchat.select_build_artifact("777", "2", run, artifacts)
    return {**selection, "record": record}


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
        "buildProof": trusted_build_proof(),
        "priorStates": states(),
    }
    receipt["readback"] = json.loads(
        db_result(mode, states(), states() if mode == "plan" else states(True, True))[
            len(fullchat.RESULT_PREFIX):
        ]
    )
    if mode == "apply":
        receipt.update({
            "sourceRunId": "122",
            "sourceRunAttempt": "1",
            "sourceArtifactDigest": f"sha256:{'9' * 64}",
        })
    return run, artifacts, receipt


class GithubMetadataTransportTests(unittest.TestCase):
    def test_real_opener_refuses_all_redirects_without_forwarding_auth(self) -> None:
        source_paths: list[str] = []
        source_authenticated: list[bool] = []
        sink_headers: list[dict[str, str]] = []

        class SinkHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                sink_headers.append(dict(self.headers.items()))
                self.send_response(200)
                self.end_headers()

            def log_message(self, format: str, *args: Any) -> None:
                pass

        sink = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SinkHandler)
        sink_thread = threading.Thread(target=sink.serve_forever, daemon=True)
        sink_thread.start()
        sink_url = f"http://127.0.0.1:{sink.server_port}"

        class SourceHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                source_paths.append(self.path)
                source_authenticated.append(self.headers.get("Authorization") == "Bearer offline-test-token")
                if self.path.endswith("/metadata-ok"):
                    body = b'{"status":"ok"}'
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(302)
                if self.path.endswith("/same-host-redirect"):
                    self.send_header("Location", "/repos/neo-capiro/capirov2/metadata-ok")
                else:
                    self.send_header("Location", f"{sink_url}/cross-host-target")
                self.end_headers()

            def log_message(self, format: str, *args: Any) -> None:
                pass

        source = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SourceHandler)
        source_thread = threading.Thread(target=source.serve_forever, daemon=True)
        source_thread.start()
        source_origin = f"http://127.0.0.1:{source.server_port}"

        try:
            with patch.object(fullchat, "GITHUB_API_ORIGIN", source_origin):
                github = fullchat.GithubApi("offline-test-token")
                self.assertEqual(github._json("metadata-ok"), {"status": "ok"})
                for path in ("same-host-redirect", "cross-host-redirect"):
                    with self.subTest(path=path):
                        with self.assertRaisesRegex(fullchat.FullchatError, "redirect refused") as raised:
                            github._json(path)
                        self.assertNotIn("offline-test-token", str(raised.exception))
        finally:
            source.shutdown()
            sink.shutdown()
            source.server_close()
            sink.server_close()
            source_thread.join(timeout=5)
            sink_thread.join(timeout=5)

        self.assertEqual(
            source_paths,
            [
                "/repos/neo-capiro/capirov2/metadata-ok",
                "/repos/neo-capiro/capirov2/same-host-redirect",
                "/repos/neo-capiro/capirov2/cross-host-redirect",
            ],
        )
        self.assertEqual(source_authenticated, [True, True, True])
        self.assertEqual(sink_headers, [])


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

    def test_source_receipt_rejects_outer_root_fields_direct_and_from_archive(self) -> None:
        for root_field in ("settings_jsonb", "credentials", "arbitrary"):
            with self.subTest(root_field=root_field):
                run, artifacts, receipt = trusted_metadata()
                receipt[root_field] = {"credential": "must-not-survive"}
                selection = fullchat.select_artifact("123", "1", run, artifacts)
                with self.assertRaisesRegex(fullchat.FullchatError, "root fields"):
                    fullchat.validate_source_receipt(receipt, run, selection, "plan")

        run, artifacts, receipt = trusted_metadata()
        receipt["settings_jsonb"] = {"credential": "must-not-survive"}
        with tempfile.TemporaryDirectory() as folder:
            archive_path = Path(folder) / "source.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("receipt.json", json.dumps(receipt))
            artifacts["artifacts"][0]["digest"] = (
                f"sha256:{hashlib.sha256(archive_path.read_bytes()).hexdigest()}"
            )
            selection = fullchat.select_artifact("123", "1", run, artifacts)
            loaded = fullchat.load_source_receipt(archive_path, selection, selection)
            with self.assertRaisesRegex(fullchat.FullchatError, "root fields"):
                fullchat.validate_source_receipt(loaded, run, selection, "plan")

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


class BuildBindingTests(unittest.TestCase):
    def write_archive(self, folder: str, name: str, value: dict[str, Any]) -> Path:
        path = Path(folder) / "build.zip"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(name, json.dumps(value))
        return path

    def test_authenticated_build_metadata_rejects_wrong_run_workflow_attempt_and_repo(self) -> None:
        run, artifacts, _ = trusted_build_metadata()
        selection = fullchat.select_build_artifact("777", "2", run, artifacts)
        self.assertEqual(selection["headSha"], "e" * 40)
        cases: list[tuple[str, dict[str, Any], dict[str, Any], str, str]] = []
        wrong_run = copy.deepcopy(run)
        wrong_run["id"] = 778
        cases.append(("run", wrong_run, artifacts, "777", "2"))
        wrong_workflow = copy.deepcopy(run)
        wrong_workflow["path"] = ".github/workflows/other.yml"
        cases.append(("workflow", wrong_workflow, artifacts, "777", "2"))
        wrong_attempt = copy.deepcopy(run)
        wrong_attempt["run_attempt"] = 3
        cases.append(("attempt", wrong_attempt, artifacts, "777", "2"))
        foreign = copy.deepcopy(run)
        foreign["repository"]["full_name"] = "foreign/repository"
        cases.append(("repository", foreign, artifacts, "777", "2"))
        for label, run_value, artifact_value, run_id, attempt in cases:
            with self.subTest(label=label):
                with self.assertRaises(fullchat.FullchatError):
                    fullchat.select_build_artifact(
                        run_id, attempt, run_value, artifact_value
                    )

    def test_build_archive_rejects_wrong_zip_hash_source_digest_env_context_and_paths(self) -> None:
        run, artifacts, record = trusted_build_metadata()
        with tempfile.TemporaryDirectory() as folder:
            valid = self.write_archive(folder, "api-image-build-record.json", record)
            archive_digest = f"sha256:{hashlib.sha256(valid.read_bytes()).hexdigest()}"
            run, artifacts, record = trusted_build_metadata(archive_digest)
            selection = fullchat.select_build_artifact("777", "2", run, artifacts)
            proof = fullchat.load_build_proof(valid, selection, selection)
            self.assertEqual(proof["record"]["image"]["digest"], f"sha256:{'b' * 64}")

            wrong_hash = copy.deepcopy(selection)
            wrong_hash["archiveDigest"] = f"sha256:{'0' * 64}"
            with self.assertRaisesRegex(fullchat.FullchatError, "digest"):
                fullchat.load_build_proof(valid, wrong_hash, wrong_hash)

            wrong_zip = self.write_archive(folder, "nested/api-image-build-record.json", record)
            wrong_zip_selection = copy.deepcopy(selection)
            wrong_zip_selection["archiveDigest"] = (
                f"sha256:{hashlib.sha256(wrong_zip.read_bytes()).hexdigest()}"
            )
            with self.assertRaisesRegex(fullchat.FullchatError, "contain only"):
                fullchat.load_build_proof(wrong_zip, wrong_zip_selection, wrong_zip_selection)

        mutations = {
            "build source": lambda value: value["source"].update(commit="f" * 40),
            "image digest": lambda value: value["image"].update(digest=f"sha256:{'c' * 64}"),
            "environment": lambda value: value.update(environment="prod"),
            "context": lambda value: value["build"].update(context="apps/api"),
            "dockerfile path": lambda value: value["build"].update(dockerfile="Dockerfile"),
            "workflow path": lambda value: value["workflow"].update(path=".github/workflows/other.yml"),
            "unknown root": lambda value: value.update(untrusted=True),
        }
        selection = fullchat.select_build_artifact("777", "2", run, artifacts)
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                candidate = copy.deepcopy(record)
                mutate(candidate)
                with self.assertRaises(fullchat.FullchatError):
                    fullchat.validate_build_record(candidate, selection)
        with self.assertRaisesRegex(fullchat.FullchatError, "duplicate JSON keys"):
            fullchat.strict_json_loads('{"source":{},"source":{}}', "build record")

        proof = {**selection, "record": record}
        with self.assertRaisesRegex(fullchat.FullchatError, "does not match"):
            fullchat.validate_runtime_build(
                {
                    "imageDigest": f"sha256:{'0' * 64}",
                    "sourceCommit": "e" * 40,
                    "image": record["image"]["uri"],
                },
                proof,
            )


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

    def test_runtime_preserves_optional_empty_environment_values(self) -> None:
        class OptionalEmpty(self.Aws):
            def describe_task_definition(self, name: str) -> dict[str, Any]:
                response = super().describe_task_definition(name)
                response["taskDefinition"]["containerDefinitions"][0]["environment"].append(
                    {"name": "OPTIONAL_TEST_SETTING", "value": ""}
                )
                return response

        runtime = fullchat.capture_runtime(OptionalEmpty(), self.Git())
        self.assertEqual(runtime["sourceCommit"], self.Aws.sha)

    def test_empty_environment_opt_in_keeps_critical_identity_and_db_checks(self) -> None:
        class EmptyCritical(self.Aws):
            def __init__(self, field: str, target: str) -> None:
                super().__init__()
                self.field, self.target = field, target

            def describe_task_definition(self, name: str) -> dict[str, Any]:
                response = super().describe_task_definition(name)
                if (fullchat.TASK_FAMILY in name) == (self.target == "diag"):
                    container = response["taskDefinition"]["containerDefinitions"][0]
                    values = container["secrets" if self.field == "DB_HOST" else "environment"]
                    entry = next(item for item in values if item["name"] == self.field)
                    entry["valueFrom" if self.field == "DB_HOST" else "value"] = ""
                    container["dockerLabels"] = {"org.opencontainers.image.revision": self.sha}
                return response

        for field in ("DB_NAME", "GIT_SHA", "DB_HOST"):
            for target in ("served", "diag"):
                with self.subTest(field=field, target=target), self.assertRaises(fullchat.FullchatError):
                    fullchat.capture_runtime(EmptyCritical(field, target), self.Git())

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

    def stopped_task(
        self, extra: bool = False, exit_code: int = 0, mode: str = "plan"
    ) -> dict[str, Any]:
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
            "startedBy": f"meri-fullchat-321-1-{mode}",
            "launchType": "FARGATE",
            "lastStatus": "STOPPED",
            "stopCode": "EssentialContainerExited",
            "containers": containers,
        }

    def run_main(
        self, messages: Sequence[str], task: dict[str, Any], mode: str = "plan"
    ) -> tuple[int, dict[str, Any]]:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            build_archive = root / "build.zip"
            _, _, record = trusted_build_metadata()
            with zipfile.ZipFile(build_archive, "w") as archive:
                archive.writestr("api-image-build-record.json", json.dumps(record))
            archive_digest = f"sha256:{hashlib.sha256(build_archive.read_bytes()).hexdigest()}"
            build_run, build_artifacts, _ = trusted_build_metadata(archive_digest)
            build_selection = fullchat.select_build_artifact(
                "777", "2", build_run, build_artifacts
            )
            build_selection_path = root / "build-selection.json"
            build_selection_path.write_text(json.dumps(build_selection), encoding="utf-8")
            build_proof = {**build_selection, "record": record}
            source_run: dict[str, Any] | None = None
            source_artifacts: dict[str, Any] | None = None
            source_selection_path = root / "source-selection.json"
            source_archive = root / "source.zip"
            if mode in ("apply", "rollback"):
                source_run, source_artifacts, source_receipt = trusted_metadata(
                    "plan" if mode == "apply" else "apply"
                )
                if mode == "apply":
                    source_receipt["buildProof"] = build_proof
                else:
                    historical_proof = copy.deepcopy(build_proof)
                    historical_proof["headSha"] = "a" * 40
                    historical_proof["record"]["source"]["commit"] = "a" * 40
                    historical_proof["record"]["image"]["digest"] = f"sha256:{'c' * 64}"
                    historical_proof["record"]["image"]["uri"] = (
                        f"{fullchat.IMAGE_REPOSITORY}@sha256:{'c' * 64}"
                    )
                    source_receipt["buildProof"] = historical_proof
                    source_receipt["imageSourceCommit"] = "a" * 40
                    source_receipt["imageDigest"] = f"sha256:{'c' * 64}"
                with zipfile.ZipFile(source_archive, "w") as archive:
                    archive.writestr("receipt.json", json.dumps(source_receipt))
                source_artifacts["artifacts"][0]["digest"] = (
                    f"sha256:{hashlib.sha256(source_archive.read_bytes()).hexdigest()}"
                )
                source_selection = fullchat.select_artifact(
                    "123", "1", source_run, source_artifacts
                )
                source_selection_path.write_text(json.dumps(source_selection), encoding="utf-8")

            class Github:
                def run_attempt(self, run_id: str, attempt: str) -> dict[str, Any]:
                    if (run_id, attempt) == ("777", "2"):
                        return copy.deepcopy(build_run)
                    if (run_id, attempt) == ("123", "1") and source_run is not None:
                        return copy.deepcopy(source_run)
                    raise AssertionError((run_id, attempt))

                def artifacts(self, run_id: str) -> dict[str, Any]:
                    if run_id == "777":
                        return copy.deepcopy(build_artifacts)
                    if run_id == "123" and source_artifacts is not None:
                        return copy.deepcopy(source_artifacts)
                    raise AssertionError(run_id)

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
                patch.object(fullchat, "GithubApi", return_value=Github()),
                patch.object(fullchat, "AwsCli", self.Aws),
                patch.object(fullchat, "capture_runtime", return_value=self.runtime),
                patch.object(fullchat, "wait_for_task", return_value=task),
                patch.object(fullchat, "wait_for_log_messages", return_value=messages),
            ):
                arguments = [
                    "--mode", mode,
                    "--output-dir", folder,
                    "--build-run-id", "777",
                    "--build-run-attempt", "2",
                    "--build-artifact-selection", str(build_selection_path),
                    "--build-artifact-archive", str(build_archive),
                    "--wait-timeout-seconds", "60",
                ]
                if mode in ("apply", "rollback"):
                    arguments.extend([
                        (
                            "--apply-confirmation"
                            if mode == "apply"
                            else "--rollback-confirmation"
                        ),
                        (
                            fullchat.APPLY_CONFIRMATION
                            if mode == "apply"
                            else fullchat.ROLLBACK_CONFIRMATION
                        ),
                        "--source-run-id", "123",
                        "--source-run-attempt", "1",
                        "--artifact-selection", str(source_selection_path),
                        "--artifact-archive", str(source_archive),
                    ])
                status = fullchat.main(arguments)
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

    def test_main_accepts_authenticated_build_bound_apply_receipt(self) -> None:
        message = db_result("apply", states(), states(True, True))
        status, receipt = self.run_main(
            [message], self.stopped_task(mode="apply"), mode="apply"
        )
        self.assertEqual(status, 0)
        self.assertEqual(receipt["result"], "APPLIED_AND_VERIFIED")
        self.assertEqual(receipt["buildProof"]["record"]["environment"], "dev")
        self.assertEqual(receipt["sourceRunId"], "123")

    def test_main_rollback_accepts_a_different_current_compatible_build(self) -> None:
        message = db_result("rollback", states(True, True), states())
        status, receipt = self.run_main(
            [message], self.stopped_task(mode="rollback"), mode="rollback"
        )
        self.assertEqual(status, 0)
        self.assertEqual(receipt["result"], "ROLLED_BACK_AND_VERIFIED")
        self.assertEqual(receipt["imageDigest"], f"sha256:{'b' * 64}")
        self.assertEqual(receipt["buildProof"]["record"]["source"]["commit"], "e" * 40)

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
        self.assertIn("--select-build-artifact", text)
        self.assertIn("--max-filesize 1048576", text)
        self.assertIn("--build-run-id", text)
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
