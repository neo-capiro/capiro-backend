"""Build-contract check against the exact archive consumed by build-base.sh.

Set MERI_HERMES_PINNED_ARCHIVE to the saved v2026.9.14 tarball, or set
MERI_HERMES_PINNED_ROOT to /opt/hermes inside the checksum-built base image.
The test reads only pinned source files and never runs a worker or provider.
"""
from __future__ import annotations

import ast
import asyncio
import hashlib
import os
import pathlib
import sys
import tarfile
import tempfile
import threading
import time
import types
import typing
import unittest
from unittest.mock import patch

from apply_overlay import PINNED, apply
from meri_tool_view_v1 import (
    APPLIED_TOOL_VIEW_DIGEST_ALGORITHM, WORKER_CATALOG_DIGEST_ALGORITHM,
    ToolViewError, _applied_tool_view_digest, _schema_digest, _worker_catalog,
    retained_durable_replay,
)


ARCHIVE_SHA256 = "47df72ebd3f9c96d806a94541163f7fe7d7ce5b84f85c1d3787e6dfeea1d7834"


class PinnedArchiveTest(unittest.TestCase):
    def test_overlay_applies_to_build_base_archive(self):
        dockerfile = pathlib.Path(__file__).parent.parent / "Dockerfile"
        docker_source = dockerfile.read_text(encoding="utf-8")
        self.assertIn("overlay/meri_recovery_receipt_v1.py", docker_source)
        self.assertIn("overlay/meri_reservation_recovery_v1.py", docker_source)
        self.assertIn("overlay/meri_recovery_runtime_v1.py", docker_source)
        self.assertIn(
            "/opt/hermes/meri_recovery_receipt_v1.py \\", docker_source)
        self.assertIn(
            "/opt/hermes/meri_reservation_recovery_v1.py \\", docker_source)
        self.assertIn(
            "/opt/hermes/meri_recovery_runtime_v1.py \\", docker_source)
        self.assertIn(
            "ai.capiro.meri.phase4_recovery_v1_overlay=", docker_source)
        entrypoint_source = (
            pathlib.Path(__file__).parent.parent / "entrypoint.sh").read_text(
                encoding="utf-8")
        self.assertIn(
            "MERI_PHASE4_RECOVERY_V1_ENABLED requires "
            "MERI_PHASE4_CLAIM_V1_ENABLED=1", entrypoint_source)
        self.assertIn('!= "16"', entrypoint_source)
        self.assertIn(
            "MERI_PHASE4_RESERVATION_RECOVERY_V1_ENABLED requires claim and recovery v1",
            entrypoint_source)
        raw = os.environ.get("MERI_HERMES_PINNED_ARCHIVE")
        pinned_root = os.environ.get("MERI_HERMES_PINNED_ROOT")
        if not raw and not pinned_root:
            self.skipTest("MERI_HERMES_PINNED_ARCHIVE or MERI_HERMES_PINNED_ROOT not set")
        archive = pathlib.Path(raw) if raw else None
        if archive is not None:
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), ARCHIVE_SHA256)
        with tempfile.TemporaryDirectory(prefix="meri-hermes-overlay-") as temp:
            root = pathlib.Path(temp)
            tar = tarfile.open(archive, "r:gz") if archive is not None else None
            try:
                for relative, expected in PINNED.items():
                    if tar is not None:
                        member = tar.getmember(f"hermes-agent-2026.9.14/{relative}")
                        self.assertTrue(member.isfile(), relative)
                        content = tar.extractfile(member).read()
                    else:
                        content = (pathlib.Path(str(pinned_root)) / relative).read_bytes()
                    self.assertEqual(hashlib.sha256(content).hexdigest(), expected, relative)
                    target = root / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(content)
            finally:
                if tar is not None:
                    tar.close()
            apply(root)
            installed_recovery_helper = root / "meri_recovery_receipt_v1.py"
            self.assertTrue(installed_recovery_helper.is_file())
            self.assertEqual(
                installed_recovery_helper.read_bytes(),
                pathlib.Path(__file__).with_name(
                    "meri_recovery_receipt_v1.py").read_bytes())
            compile(
                installed_recovery_helper.read_text(encoding="utf-8"),
                "meri_recovery_receipt_v1.py", "exec")
            pure_recovery_source = installed_recovery_helper.read_text(encoding="utf-8")
            self.assertNotIn("import os", pure_recovery_source)
            self.assertNotIn("import time", pure_recovery_source)
            installed_reservation_helper = root / "meri_reservation_recovery_v1.py"
            self.assertTrue(installed_reservation_helper.is_file())
            self.assertEqual(
                installed_reservation_helper.read_bytes(),
                pathlib.Path(__file__).with_name(
                    "meri_reservation_recovery_v1.py").read_bytes())
            compile(
                installed_reservation_helper.read_text(encoding="utf-8"),
                "meri_reservation_recovery_v1.py", "exec")
            installed_recovery_runtime = root / "meri_recovery_runtime_v1.py"
            self.assertTrue(installed_recovery_runtime.is_file())
            self.assertEqual(
                installed_recovery_runtime.read_bytes(),
                pathlib.Path(__file__).with_name(
                    "meri_recovery_runtime_v1.py").read_bytes())
            compile(
                installed_recovery_runtime.read_text(encoding="utf-8"),
                "meri_recovery_runtime_v1.py", "exec")
            for relative in PINNED:
                source = (root / relative).read_text(encoding="utf-8")
                compile(source, relative, "exec")
            patched_runs = (root / "gateway/platforms/api_server_runs.py").read_text(encoding="utf-8")
            handler = patched_runs[patched_runs.index("async def _handle_runs("):]
            reservation_recovery = patched_runs[
                patched_runs.index("async def _handle_reservation_recovery("):
                patched_runs.index("async def _handle_get_run(")]
            self.assertIn(
                'os.environ.get("MERI_PHASE4_RESERVATION_RECOVERY_V1_ENABLED") != "1"',
                reservation_recovery)
            self.assertIn(
                'request.headers.getall("Authorization", [])', reservation_recovery)
            self.assertLess(
                reservation_recovery.index("authorize_reservation_request_v1("),
                reservation_recovery.index("lookup_or_seal_absent("))
            self.assertLess(
                reservation_recovery.index("lookup_or_seal_absent("),
                reservation_recovery.index("sign_reservation_response_v1("))
            self.assertIn("reservation_response_bytes_v1(", reservation_recovery)
            get_recovery = patched_runs[
                patched_runs.index("async def _handle_get_run("):
                patched_runs.index("async def _handle_run_events(")]
            stop_recovery = patched_runs[
                patched_runs.index("async def _handle_stop_run("):
                patched_runs.index("async def _sweep_orphaned_runs(")]
            for recovery_handler in (get_recovery, stop_recovery):
                self.assertIn(
                    'os.environ.get("MERI_PHASE4_RECOVERY_V1_ENABLED") == "1"',
                    recovery_handler)
                self.assertIn(
                    'request.headers.getall("Authorization", [])',
                    recovery_handler)
                self.assertIn("query_string=request.query_string", recovery_handler)
                self.assertLess(
                    recovery_handler.index("authorize_recovery_request_v1("),
                    recovery_handler.index("_load_owned_run("))
                self.assertLess(
                    recovery_handler.index("_load_owned_run("),
                    recovery_handler.index("sign_recovery_response_v1("))
            self.assertLess(
                stop_recovery.index("authorize_recovery_request_v1("),
                stop_recovery.index('self._set_run_status(run_id, "stopping"'))
            self.assertLess(
                stop_recovery.index("stop_effect_started = True"),
                stop_recovery.index('self._set_run_status(run_id, "stopping"'))
            self.assertIn("if stop_effect_started:", stop_recovery)
            self.assertIn('status=503', stop_recovery)
            self.assertIn(
                'response.headers[RECOVERY_RECEIPT_HEADER] = '
                'sign_recovery_response_v1(', stop_recovery)
            runs_tree = ast.parse(patched_runs)
            recovery_nodes = [
                node for node in runs_tree.body
                if isinstance(node, ast.AsyncFunctionDef)
                and node.name in {
                    "_handle_reservation_recovery", "_handle_get_run",
                    "_handle_stop_run"}
            ]
            lookup_calls: list[str] = []

            def forbidden_lookup(*_args, **_kwargs):
                lookup_calls.append("lookup")
                raise AssertionError("native lookup ran before recovery verification")

            class Headers:
                def getall(self, _name, default):
                    return default

            class Request:
                method = "GET"
                path = "/v1/runs/worker-run"
                query_string = ""
                match_info = {"run_id": "worker-run"}
                headers = Headers()

                async def read(self):
                    return b""

            rejected = types.SimpleNamespace(status=401, body=b"", headers={})
            recovery_namespace = {
                "os": os,
                "web": types.SimpleNamespace(Request=object, Response=object),
                "_load_owned_run": forbidden_lookup,
                "_json_error": lambda *_args, **_kwargs: rejected,
            }
            exec(compile(
                ast.Module(body=recovery_nodes, type_ignores=[]),
                "patched_recovery_handlers", "exec"), recovery_namespace)
            fake_api = types.SimpleNamespace(_openai_error=lambda *args, **kwargs: {})
            with patch.dict(os.environ, {
                    "MERI_PHASE4_RECOVERY_V1_ENABLED": "1"}, clear=True):
                self.assertIs(
                    asyncio.run(recovery_namespace["_handle_get_run"](
                        object(), Request(), _api_server=fake_api)), rejected)
                stop_request = Request()
                stop_request.method = "POST"
                stop_request.path = "/v1/runs/worker-run/stop"
                self.assertIs(
                    asyncio.run(recovery_namespace["_handle_stop_run"](
                        object(), stop_request, _api_server=fake_api)), rejected)
                reservation_request = Request()
                reservation_request.method = "POST"
                reservation_request.path = (
                    "/v1/meri/phase4/reservations/lookup-or-seal")
                with patch.dict(os.environ, {
                        "MERI_PHASE4_RESERVATION_RECOVERY_V1_ENABLED": "1"},
                        clear=True):
                    self.assertIs(
                        asyncio.run(recovery_namespace[
                            "_handle_reservation_recovery"](
                                object(), reservation_request,
                                _api_server=fake_api)), rejected)
            self.assertEqual(lookup_calls, [])
            native_lookup_calls: list[str] = []

            def native_lookup(*_args, **kwargs):
                native_lookup_calls.append(kwargs["permission"])
                return (
                    "worker-run",
                    {"run_id": "worker-run", "status": "completed"},
                    None, None, None,
                )

            class NativeResponse:
                def __init__(self, value):
                    import json
                    self.status = 200
                    self.body = json.dumps(value).encode()
                    self.headers = {}

            recovery_namespace.update({
                "_load_owned_run": native_lookup,
                "TERMINAL_STATUSES": {"completed"},
                "web": types.SimpleNamespace(
                    Request=object, Response=object,
                    json_response=lambda value: NativeResponse(value)),
            })
            native_request = Request()
            native_request.read_count = 0

            async def counted_read():
                native_request.read_count += 1
                return b""

            native_request.read = counted_read
            with patch.dict(os.environ, {}, clear=True):
                native_get = asyncio.run(recovery_namespace["_handle_get_run"](
                    object(), native_request, _api_server=fake_api))
                native_request.method = "POST"
                native_request.path = "/v1/runs/worker-run/stop"
                native_stop = asyncio.run(recovery_namespace["_handle_stop_run"](
                    object(), native_request, _api_server=fake_api))
            self.assertEqual(native_lookup_calls, ["status", "stop"])
            self.assertEqual(native_request.read_count, 0)
            self.assertEqual(native_get.body, native_stop.body)
            self.assertNotIn(
                "X-Meri-Dispatch-Recovery-Receipt", native_get.headers)
            native_store = (root / "gateway/platforms/api_server_run_idempotency.py").read_text(encoding="utf-8")
            self.assertIn('idempotency_scope = self._run_idempotency_scope(request)', handler)
            self.assertIn('phase4_worker_idempotency_fingerprint(', handler)
            self.assertIn('raw_body=raw_request_body', handler)
            self.assertIn('request.query_string != ""', handler)
            self.assertIn('len(request.headers.getall(name, [])) != 1', handler)
            self.assertIn('request.headers.getall("Content-Encoding", [])', handler)
            self.assertIn('code="noncanonical_phase4_runtime_selection"', handler)
            self.assertIn('route = None if phase4_claim_enabled else', handler)
            self.assertIn('confirmed_runtime_lock=phase4_claim_enabled', handler)
            self.assertLess(handler.index('noncanonical_phase4_runtime_selection'),
                            handler.index('_normalize_room_dispatch(request, body)'))
            self.assertIn('{"body": body, "gateway_session_key": gateway_session_key or ""}', handler)
            self.assertIn('WHERE scope=? AND idempotency_key=?', native_store)
            self.assertIn('hmac.compare_digest(row[0], fingerprint)', native_store)
            self.assertIn('self._prune_stale_terminal_locked(now)', native_store)
            self.assertIn('raise RuntimeError("phase4_durable_idempotency_store_required")',
                          native_store)
            self.assertIn('raise RuntimeError("phase4_durable_retention_required")',
                          native_store)
            self.assertIn('CREATE TABLE IF NOT EXISTS run_idempotency_absence', native_store)
            self.assertIn('def lookup_or_seal_absent(', native_store)
            self.assertIn('dispatch_request_sha256', native_store)
            self.assertIn('code="phase4_dispatch_sealed_absent"', patched_runs)
            self.assertIn('"retention_until": float(retention_until or 0)', native_store)
            self.assertIn('WHERE (retention_until > 0 AND retention_until <= ?)', native_store)
            self.assertLess(handler.index("check_freshness=False"),
                            handler.index("# A retained hit needs no new route"))
            self.assertLess(handler.index("# A retained hit needs no new route"),
                            handler.index("_request_turn_author(body)"))
            self.assertLess(handler.index("_request_turn_author(body)"),
                            handler.index("# A key MISS must meet the current expiry"))
            self.assertLess(handler.index("# A key MISS must meet the current expiry"),
                            handler.index("_concurrency_limited_response()"))
            self.assertEqual(handler.count("retained_durable_replay(self._run_idempotency_store, record)"), 3)
            self.assertEqual(handler.count(
                "idempotency_scope, idempotency_key, idempotency_fingerprint"), 3)
            self.assertIn('phase4_native_retention_until(phase4_bearer_claims)', handler)
            self.assertLess(handler.index("raw_request_body = await request.read()"),
                            handler.index("json.loads(raw_request_body.decode"))
            self.assertLess(handler.index("capture_phase4_claim_context("),
                            handler.index("self._run_idempotency_store.reserve("))
            execute = handler[handler.index("async def _execute_run("):]
            authorize_index = execute.index("phase4_gate.authorize(")
            post_claim_stop_index = execute.index(
                "if run_id in self._stopping_run_ids:", authorize_index)
            self.assertLess(authorize_index, post_claim_stop_index)
            self.assertLess(post_claim_stop_index,
                            execute.index("self._active_run_agents[run_id] = agent"))
            self.assertLess(execute.index("self._active_run_agents[run_id] = agent"),
                            execute.index("_run_agent_sync("))
            patched_api = (
                root / "gateway/platforms/api_server.py").read_text(encoding="utf-8")
            self.assertIn("validate_recovery_runtime_v1(native_api_key=self._api_key)",
                          patched_api)
            self.assertIn('"_handle_reservation_recovery"', patched_api)
            self.assertIn("meri_phase4_reservation_recovery_invalid", patched_api)
            self.assertLess(
                patched_api.index(
                    "validate_recovery_runtime_v1(native_api_key=self._api_key)"),
                patched_api.index("self._app = web.Application("))
            self.assertIn('"meri_phase4_recovery_invalid"', patched_api)
            self.assertIn('retryable=False', patched_api)
            api_tree = ast.parse(patched_api)
            capabilities = next(node for node in ast.walk(api_tree)
                                if isinstance(node, ast.AsyncFunctionDef)
                                and node.name == "_handle_capabilities")
            enabled_branch = next(node for node in capabilities.body if isinstance(node, ast.If))
            handler_imports = {(node.module, alias.name) for node in enabled_branch.body
                               if isinstance(node, ast.ImportFrom) for alias in node.names}
            self.assertIn(("gateway.run", "_load_gateway_config"), handler_imports)
            self.assertIn(("hermes_cli.tools_config", "_get_platform_tools"), handler_imports)
            self.assertTrue(enabled_branch.orelse)
            patched = (root / "agent/chat_completion_helpers.py").read_text(encoding="utf-8")
            self.assertEqual(patched.count("assert_final_provider_tool_payload("), 4)
            self.assertIn("assert_final_provider_tool_payload(self.agent, stream_kwargs)", patched)
            self.assertTrue((root / "meri_tool_view_v1.py").is_file())
            self.assertTrue((root / "meri_claim_attestation_v1.py").is_file())
            claim_helper = (root / "meri_claim_attestation_v1.py").read_text(encoding="utf-8")
            compile(claim_helper, "meri_claim_attestation_v1.py", "exec")
            self.assertIn("make_phase4_claim_ingress_middleware", claim_helper)
            self.assertIn("path.startswith(\"/p/\")", claim_helper)
            self.assertIn('response != {"version": 2, "kind": "transitioned", "launchAuthorized": True}',
                          claim_helper)
            self.assertIn("phase4_claim_middleware", patched_api)
            self.assertIn("phase4_claim_context_required", patched_api)
            self.assertLess(patched_api.index("phase4_claim_runtime_not_locked"),
                            patched_api.index("from run_agent import AIAgent"))
            patched_executor = (root / "agent/tool_executor.py").read_text(encoding="utf-8")
            self.assertLess(patched_executor.index("assert_phase4_launch_authorized(agent)"),
                            patched_executor.index("tool_name_allowed(agent, ref.name)"))
            patched_gateway = (root / "gateway/run.py").read_text(encoding="utf-8")
            self.assertGreaterEqual(patched_gateway.count('MERI_PHASE4_CLAIM_V1_ENABLED'), 4)
            self.assertIn('cron_start_kwargs["can_dispatch"] = lambda: False', patched_gateway)
            patched_metadata = (root / "agent/model_metadata.py").read_text(encoding="utf-8")
            self.assertIn('return None  # no provider discovery is permitted before the Phase 4 claim',
                          patched_metadata)
            self.assertIn('raise RuntimeError("phase4_claim_context_length_pin_required")',
                          patched_metadata)
            metadata_tree = ast.parse(patched_metadata)
            metadata_functions = [node for node in metadata_tree.body
                                  if isinstance(node, ast.FunctionDef) and node.name in {
                                      "detect_local_server_type", "get_model_context_length"}]
            metadata_namespace = {"os": os, "Optional": typing.Optional}
            exec(compile(ast.Module(body=metadata_functions, type_ignores=[]),
                         "patched_model_metadata", "exec"), metadata_namespace)
            with patch.dict(os.environ, {
                    "MERI_PHASE4_CLAIM_V1_ENABLED": "1",
                    "MERI_HERMES_CONTEXT_LENGTH": "131072",
            }, clear=False):
                self.assertIsNone(metadata_namespace["detect_local_server_type"](
                    "http://provider.invalid/v1"))
                self.assertEqual(metadata_namespace["get_model_context_length"](
                    "phase4-model", base_url="http://provider.invalid/v1"), 131072)
            with patch.dict(os.environ, {
                    "MERI_PHASE4_CLAIM_V1_ENABLED": "1",
                    "MERI_HERMES_CONTEXT_LENGTH": "",
            }, clear=False):
                with self.assertRaisesRegex(RuntimeError,
                                            "phase4_claim_context_length_pin_required"):
                    metadata_namespace["get_model_context_length"](
                        "phase4-model", base_url="http://provider.invalid/v1")
            patched_delegate = (root / "tools/delegate_tool.py").read_text(encoding="utf-8")
            self.assertIn('child._meri_phase4_claim_gate_v1 = getattr(', patched_delegate)
            self.assertIn('apply_agent_tool_view(', patched_delegate)
            self.assertIn('assert_phase4_launch_authorized(child)', patched_delegate)

            # Execute the patched native store contract. Guarded mode must never
            # fall back to process memory, and a terminal row cannot be pruned
            # before its API-bound retain-until horizon.
            fake_cli = types.ModuleType("hermes_cli")
            fake_cli.__path__ = []
            fake_sqlite = types.ModuleType("hermes_cli.sqlite_util")
            fake_sqlite.add_column_if_missing = lambda *_args, **_kwargs: None
            fake_wal = types.ModuleType("hermes_state_wal")
            fake_wal.apply_wal_with_fallback = lambda *_args, **_kwargs: None
            native_namespace = {"__name__": "phase4_patched_native_store"}
            with patch.dict(sys.modules, {
                "hermes_cli": fake_cli,
                "hermes_cli.sqlite_util": fake_sqlite,
                "hermes_state_wal": fake_wal,
            }):
                exec(compile(native_store, "patched_native_store", "exec"), native_namespace)
                store_type = native_namespace["RunIdempotencyStore"]
                with patch.dict(os.environ, {"MERI_PHASE4_CLAIM_V1_ENABLED": "1"}, clear=False):
                    with self.assertRaisesRegex(
                            RuntimeError, "phase4_durable_idempotency_store_required"):
                        store_type(":memory:")
                    with self.assertRaisesRegex(
                            RuntimeError, "phase4_durable_idempotency_store_unavailable"):
                        store_type(str(root / "missing-parent" / "runs.db"))
                    durable_store = store_type(str(root / "runs.db"))
                    with self.assertRaisesRegex(
                            RuntimeError, "phase4_durable_retention_required"):
                        durable_store.lookup("scope", "key", "a" * 64)
                    retain_until = time.time() + 1000
                    dispatch_digest = "d" * 64
                    outcome, created = durable_store.reserve(
                        "scope", "key", "a" * 64, "run_1", {"status": "queued"},
                        retention_until=retain_until,
                        dispatch_request_sha256=dispatch_digest)
                    self.assertEqual(outcome, "created")
                    self.assertEqual(created["retention_until"], retain_until)
                    self.assertEqual(created["dispatch_request_sha256"], dispatch_digest)
                    durable_store.close()
                    durable_store = store_type(str(root / "runs.db"))
                    outcome, replay = durable_store.lookup(
                        "scope", "key", "a" * 64, retention_until=retain_until,
                        dispatch_request_sha256=dispatch_digest)
                    self.assertEqual(outcome, "reused")
                    self.assertEqual(replay["run_id"], "run_1")
                    self.assertEqual(replay["status"], {"status": "queued"})
                    self.assertEqual(replay["retention_until"], retain_until)
                    self.assertEqual(replay["dispatch_request_sha256"], dispatch_digest)
                    found, found_record = durable_store.lookup_or_seal_absent(
                        "scope", "key", dispatch_digest,
                        not_before=time.time() - 1, retention_until=retain_until)
                    self.assertEqual(found, "reused")
                    self.assertEqual(found_record["run_id"], "run_1")
                    digest_conflict, digest_conflict_record = (
                        durable_store.lookup_or_seal_absent(
                            "scope", "key", "e" * 64,
                            not_before=time.time() - 1,
                            retention_until=retain_until))
                    self.assertEqual(digest_conflict, "conflict")
                    self.assertIsNone(digest_conflict_record)
                    self.assertTrue(retained_durable_replay(
                        durable_store, replay, now=retain_until - 1))
                    self.assertFalse(retained_durable_replay(
                        durable_store, replay, now=retain_until))
                    conflict, conflict_record = durable_store.lookup(
                        "scope", "key", "b" * 64, retention_until=retain_until,
                        dispatch_request_sha256=dispatch_digest)
                    self.assertEqual(conflict, "conflict")
                    self.assertEqual(conflict_record["run_id"], "run_1")
                    durable_store.update_status("run_1", {"status": "completed"})
                    durable_store._conn.execute(
                        "UPDATE run_idempotency SET acknowledged_at=0 WHERE run_id='run_1'")
                    durable_store._conn.commit()
                    with durable_store._immediate_txn():
                        durable_store._prune_stale_terminal_locked(retain_until - 1)
                        before = durable_store._conn.execute(
                            "SELECT count(*) FROM run_idempotency").fetchone()[0]
                        durable_store._conn.commit()
                    self.assertEqual(before, 1)
                    with durable_store._immediate_txn():
                        durable_store._prune_stale_terminal_locked(retain_until)
                        after = durable_store._conn.execute(
                            "SELECT count(*) FROM run_idempotency").fetchone()[0]
                        durable_store._conn.commit()
                    self.assertEqual(after, 0)

                    absence_retain_until = time.time() + 2000
                    absence_digest = "f" * 64
                    too_early, too_early_record = durable_store.lookup_or_seal_absent(
                        "scope", "absent-key", absence_digest,
                        not_before=time.time() + 100,
                        retention_until=absence_retain_until)
                    self.assertEqual(too_early, "too_early")
                    self.assertIsNone(too_early_record)
                    sealed, seal_record = durable_store.lookup_or_seal_absent(
                        "scope", "absent-key", absence_digest,
                        not_before=time.time() - 1,
                        retention_until=absence_retain_until)
                    self.assertEqual(sealed, "sealed_absent")
                    self.assertEqual(
                        seal_record["dispatch_request_sha256"], absence_digest)
                    self.assertEqual(
                        seal_record["retention_until"], absence_retain_until)
                    sealed_replay, replayed_seal = (
                        durable_store.lookup_or_seal_absent(
                            "scope", "absent-key", absence_digest,
                            not_before=time.time() - 1,
                            retention_until=absence_retain_until))
                    self.assertEqual(sealed_replay, "sealed_absent")
                    self.assertEqual(replayed_seal, seal_record)
                    absent_conflict, absent_conflict_record = (
                        durable_store.lookup_or_seal_absent(
                            "scope", "absent-key", "1" * 64,
                            not_before=time.time() - 1,
                            retention_until=absence_retain_until))
                    self.assertEqual(absent_conflict, "conflict")
                    self.assertIsNone(absent_conflict_record)
                    delayed, delayed_record = durable_store.reserve(
                        "scope", "absent-key", "2" * 64, "run_delayed",
                        {"status": "queued"},
                        retention_until=absence_retain_until,
                        dispatch_request_sha256=absence_digest)
                    self.assertEqual(delayed, "sealed_absent")
                    self.assertEqual(delayed_record, seal_record)
                    delayed_conflict, delayed_conflict_record = durable_store.reserve(
                        "scope", "absent-key", "2" * 64,
                        "run_delayed_conflict", {"status": "queued"},
                        retention_until=absence_retain_until,
                        dispatch_request_sha256="1" * 64)
                    self.assertEqual(delayed_conflict, "conflict")
                    self.assertIsNone(delayed_conflict_record)
                    durable_store.close()
                    durable_store = store_type(str(root / "runs.db"))
                    persisted_seal, persisted_record = (
                        durable_store.lookup_or_seal_absent(
                            "scope", "absent-key", absence_digest,
                            not_before=time.time() - 1,
                            retention_until=absence_retain_until))
                    self.assertEqual(persisted_seal, "sealed_absent")
                    self.assertEqual(persisted_record, seal_record)
                    self.assertEqual(
                        durable_store._conn.execute(
                            "SELECT count(*) FROM run_idempotency "
                            "WHERE run_id LIKE 'run_delayed%'").fetchone()[0], 0)

                    race_store = store_type(str(root / "runs.db"))
                    race_barrier = threading.Barrier(2)
                    race_digest = "9" * 64
                    race_retain_until = time.time() + 3000

                    def reserve_race():
                        race_barrier.wait()
                        return durable_store.reserve(
                            "race-scope", "race-key", "8" * 64, "run_race",
                            {"status": "queued"},
                            retention_until=race_retain_until,
                            dispatch_request_sha256=race_digest)

                    def seal_race():
                        race_barrier.wait()
                        return race_store.lookup_or_seal_absent(
                            "race-scope", "race-key", race_digest,
                            not_before=time.time() - 1,
                            retention_until=race_retain_until)

                    from concurrent.futures import ThreadPoolExecutor
                    with ThreadPoolExecutor(max_workers=2) as executor:
                        reserve_future = executor.submit(reserve_race)
                        seal_future = executor.submit(seal_race)
                        reserve_result = reserve_future.result(timeout=10)
                        seal_result = seal_future.result(timeout=10)
                    self.assertIn(
                        (reserve_result[0], seal_result[0]),
                        {("created", "reused"),
                         ("sealed_absent", "sealed_absent")})
                    self.assertEqual(
                        durable_store._conn.execute(
                            "SELECT count(*) FROM run_idempotency "
                            "WHERE scope='race-scope' AND idempotency_key='race-key'"
                        ).fetchone()[0] +
                        durable_store._conn.execute(
                            "SELECT count(*) FROM run_idempotency_absence "
                            "WHERE scope='race-scope' AND idempotency_key='race-key'"
                        ).fetchone()[0], 1)
                    race_store.close()
                    with patch.dict(os.environ, {"MERI_PHASE4_CLAIM_V1_ENABLED": "0"}, clear=False):
                        legacy, _ = durable_store.reserve(
                            "scope", "legacy", "c" * 64, "run_legacy",
                            {"status": "completed"})
                        self.assertEqual(legacy, "created")
                        durable_store._conn.execute(
                            "UPDATE run_idempotency SET acknowledged_at=0 WHERE run_id='run_legacy'")
                        durable_store._conn.commit()
                        with durable_store._immediate_txn():
                            durable_store._prune_stale_terminal_locked(time.time())
                            legacy_count = durable_store._conn.execute(
                                "SELECT count(*) FROM run_idempotency WHERE run_id='run_legacy'"
                            ).fetchone()[0]
                            durable_store._conn.commit()
                        self.assertEqual(legacy_count, 0)
                    durable_store.close()

            # Execute the exact patched transport functions with a fake SDK.
            # This proves the final gate runs after a payload is changed between
            # attempts; the fake provider never sees the widened retry.
            tree = ast.parse(patched)
            nonstream = next(n for n in tree.body if isinstance(n, ast.FunctionDef)
                             and n.name == "_dispatch_nonstreaming_api_request")
            fallback = next(n for n in tree.body if isinstance(n, ast.FunctionDef)
                            and n.name == "try_activate_fallback")
            stream_entry = next(n for n in tree.body if isinstance(n, ast.FunctionDef)
                                and n.name == "interruptible_streaming_api_call")
            streaming_class = next(n for n in tree.body if isinstance(n, ast.ClassDef)
                                   and n.name == "_StreamingCall")
            stream = next(n for n in streaming_class.body if isinstance(n, ast.FunctionDef)
                          and n.name == "_open_chat_stream")
            namespace = {
                "Any": typing.Any,
                "time": time,
                "is_native_gemini_base_url": lambda _url: False,
            }
            exec(compile(ast.Module(body=[nonstream, stream, fallback, stream_entry], type_ignores=[]),
                         "patched_transport", "exec"), namespace)
            calls = []

            def create(**kwargs):
                calls.append(kwargs)
                return "provider-response"

            client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)))
            read = {"type": "function", "function": {"name": "read"}}
            write = {"type": "function", "function": {"name": "write"}}
            fake_registry = types.SimpleNamespace(get_tool_definitions=lambda **_kwargs: [read])
            registry_patch = patch.dict(sys.modules, {"model_tools": fake_registry})
            registry_patch.start()
            self.addCleanup(registry_patch.stop)
            view = {"tool_names": frozenset({"read"}), "required_tool_names": frozenset({"read"}),
                    "worker_catalog_sha256": _worker_catalog()[0],
                    "worker_catalog_digest_algorithm": WORKER_CATALOG_DIGEST_ALGORITHM,
                    "applied_tool_view_sha256": _applied_tool_view_digest([read]),
                    "applied_tool_view_digest_algorithm": APPLIED_TOOL_VIEW_DIGEST_ALGORITHM,
                    "selected_schema_sha256": {"read": _schema_digest(read)}}
            agent = types.SimpleNamespace(api_mode="chat_completions", provider="custom",
                _meri_tool_view_v1=view, base_url="https://example.invalid",
                _stream_options_unsupported=True,
                _create_request_openai_client=lambda **_kwargs: client,
                _touch_activity=lambda _message: None)
            dispatch = namespace["_dispatch_nonstreaming_api_request"]
            self.assertEqual(dispatch(agent, {"tools": [read]}, make_client=lambda _reason: client), "provider-response")
            with self.assertRaises(ToolViewError):
                dispatch(agent, {"tools": [read, write]}, make_client=lambda _reason: client)
            self.assertEqual(len(calls), 1)
            holder = types.SimpleNamespace(agent=agent,
                clients=types.SimpleNamespace(set_client=lambda item: item), last_chunk_time={})
            open_stream = namespace["_open_chat_stream"]
            self.assertEqual(open_stream(holder, {"tools": [read]}), "provider-response")
            with self.assertRaises(ToolViewError):
                open_stream(holder, {"tools": [read, write]})
            self.assertEqual(len(calls), 2)
            # Exact pinned fallback transition is refused before it can change
            # the agent to Anthropic/Bedrock/Codex or resolve a second client.
            agent._fallback_chain = [{"provider": "anthropic", "model": "fallback-model"}]
            agent._fallback_index = 0
            self.assertFalse(namespace["try_activate_fallback"](agent))
            self.assertEqual(agent.provider, "custom")
            self.assertEqual(agent.api_mode, "chat_completions")
            self.assertEqual(agent._fallback_index, 0)
            # Even an out-of-band mode mutation fails before either transport
            # dispatch branch, so a future alternate switch cannot bypass it.
            agent.provider, agent.api_mode = "anthropic", "anthropic_messages"
            with self.assertRaisesRegex(ToolViewError, "unsupported_tool_view_provider"):
                dispatch(agent, {"tools": [read]}, make_client=lambda _reason: client)
            with self.assertRaisesRegex(ToolViewError, "unsupported_tool_view_provider"):
                namespace["interruptible_streaming_api_call"](agent, {"tools": [read]})
            self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
