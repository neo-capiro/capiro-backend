"""Standard-library contract tests; no provider or running worker required."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import pathlib
import sys
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

from meri_tool_view_v1 import (
    APPLIED_TOOL_VIEW_DIGEST_ALGORITHM, WORKER_CATALOG_DIGEST_ALGORITHM,
    ToolViewError, _applied_tool_view_digest, _versioned_digest, _worker_catalog,
    apply_agent_tool_view,
    assert_final_provider_tool_payload, assert_provider_tool_payload, filter_agent_tool_view,
    retained_durable_replay, tool_name_allowed, verify_tool_view, worker_catalog_capability,
)


KEY = "phase4-local-test-api-key-0123456789abcdef"


def schema(name):
    return {"type": "function", "function": {"name": name, "parameters": {"type": "object"}}}


def catalog_version(raw):
    ordered = sorted(raw, key=lambda item: item["function"]["name"])
    return _versioned_digest(WORKER_CATALOG_DIGEST_ALGORITHM, ordered)


def view(raw, names, required):
    selected = [tool for tool in raw if tool["function"]["name"] in names]
    return {"tool_names": frozenset(names), "required_tool_names": frozenset(required),
            "worker_catalog_sha256": catalog_version(raw),
            "worker_catalog_digest_algorithm": WORKER_CATALOG_DIGEST_ALGORITHM,
            "applied_tool_view_sha256": _applied_tool_view_digest(selected),
            "applied_tool_view_digest_algorithm": APPLIED_TOOL_VIEW_DIGEST_ALGORITHM}


def signed(message="hello", names=("read", "clarify"), required=("read",), expiry=1060,
           worker_version="a" * 64, applied_version="b" * 64):
    payload = {
        "version": 1, "catalog_version": "catalog-7",
        "worker_catalog_sha256": worker_version,
        "worker_catalog_digest_algorithm": WORKER_CATALOG_DIGEST_ALGORITHM,
        "applied_tool_view_sha256": applied_version,
        "applied_tool_view_digest_algorithm": APPLIED_TOOL_VIEW_DIGEST_ALGORITHM,
        "tool_names": list(names), "required_tool_names": list(required),
        "expires_at": expiry, "input_sha256": hashlib.sha256(message.encode()).hexdigest(),
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return {"payload": encoded, "signature": hmac.new(KEY.encode(), encoded.encode(), hashlib.sha256).hexdigest()}


class ToolViewContractTest(unittest.TestCase):
    def test_shared_typescript_python_digest_vector(self):
        vector = json.loads(pathlib.Path(__file__).with_name(
            "tool-view-digest-vectors.json").read_text(encoding="utf-8"))
        self.assertEqual(catalog_version(vector["catalog"]), vector["catalogDigest"])
        self.assertEqual(_applied_tool_view_digest(vector["applied"]), vector["toolViewDigest"])

    def test_catalog_rejects_ambiguous_names_types_floats_and_unsafe_integers(self):
        raw = [schema("read")]
        cases = [
            [{**raw[0], "name": "different"}],
            [{**raw[0], "type": "not-a-function"}],
            [{"type": "function", "function": {"name": "read", "minimum": 0.5}}],
            [{"type": "function", "function": {"name": "read", "maximum": 9_007_199_254_740_992}}],
        ]
        for invalid in cases:
            with self.subTest(invalid=invalid):
                with patch.dict(sys.modules, {"model_tools": types.SimpleNamespace(
                    get_tool_definitions=lambda **_kwargs: invalid,
                )}):
                    with self.assertRaises(ToolViewError):
                        _worker_catalog(enabled_toolsets=[])

    def test_catalog_rejects_more_than_4096_tools(self):
        raw = [schema(f"tool_{index}") for index in range(4_097)]
        with patch.dict(sys.modules, {"model_tools": types.SimpleNamespace(
                get_tool_definitions=lambda **_kwargs: raw,
        )}):
            with self.assertRaisesRegex(ToolViewError, "invalid_worker_tool_schema"):
                _worker_catalog(enabled_toolsets=[])

    def test_catalog_rejects_invalid_unicode_oversize_and_depth(self):
        nested = "leaf"
        for _depth in range(66):
            nested = [nested]
        for invalid in ["\ud800", "x" * 1_048_577, nested]:
            raw = [{"type": "function", "function": {
                "name": "read", "description": invalid,
            }}]
            with self.subTest(kind=type(invalid).__name__):
                with patch.dict(sys.modules, {"model_tools": types.SimpleNamespace(
                        get_tool_definitions=lambda **_kwargs: raw,
                )}):
                    with self.assertRaisesRegex(ToolViewError, "invalid_worker_tool_schema"):
                        _worker_catalog(enabled_toolsets=[])

    def test_signed_input_bound_policy(self):
        with patch.dict(os.environ, {"MERI_HERMES_TOOL_VIEW_V1_ENABLED": "1",
                                     "MERI_HERMES_TOOL_VIEW_SIGNING_KEY": KEY}):
            view = verify_tool_view(signed(), user_message="hello", now=1000)
            self.assertEqual(view["tool_names"], frozenset({"read", "clarify"}))
            with self.assertRaisesRegex(ToolViewError, "tool_view_input_mismatch"):
                verify_tool_view(signed(), user_message="different", now=1000)
            tampered = signed()
            tampered["signature"] = "0" * 64
            with self.assertRaisesRegex(ToolViewError, "invalid_tool_view_signature"):
                verify_tool_view(tampered, user_message="hello", now=1000)

    def test_disabled_or_expired_fails_closed(self):
        with patch.dict(os.environ, {"MERI_HERMES_TOOL_VIEW_V1_ENABLED": "0",
                                     "MERI_HERMES_TOOL_VIEW_SIGNING_KEY": KEY}):
            with self.assertRaises(ToolViewError):
                verify_tool_view(signed(), user_message="hello", now=1000)
        with patch.dict(os.environ, {"MERI_HERMES_TOOL_VIEW_V1_ENABLED": "1",
                                     "MERI_HERMES_TOOL_VIEW_SIGNING_KEY": KEY}):
            with self.assertRaisesRegex(ToolViewError, "expired_tool_view"):
                verify_tool_view(signed(expiry=999), user_message="hello", now=1000)
            with self.assertRaisesRegex(ToolViewError, "invalid_tool_view_payload"):
                verify_tool_view(signed(names=("read", "delegate_task")), user_message="hello", now=1000)
            with self.assertRaisesRegex(ToolViewError, "invalid_tool_view_payload"):
                verify_tool_view(signed(worker_version="unversioned"), user_message="hello", now=1000)

    def test_exact_replay_still_requires_signed_body_integrity_and_input_binding(self):
        with patch.dict(os.environ, {"MERI_HERMES_TOOL_VIEW_V1_ENABLED": "1",
                                     "MERI_HERMES_TOOL_VIEW_SIGNING_KEY": KEY}):
            expired = signed(expiry=999)
            self.assertEqual(verify_tool_view(expired, user_message="hello", now=1000,
                                              check_freshness=False)["tool_names"],
                             frozenset({"read", "clarify"}))
            with self.assertRaisesRegex(ToolViewError, "expired_tool_view"):
                verify_tool_view(expired, user_message="hello", now=1000)
            with self.assertRaisesRegex(ToolViewError, "tool_view_input_mismatch"):
                verify_tool_view(expired, user_message="changed", now=1000,
                                 check_freshness=False)
            altered = {**expired, "signature": "0" * 64}
            with self.assertRaisesRegex(ToolViewError, "invalid_tool_view_signature"):
                verify_tool_view(altered, user_message="hello", now=1000,
                                 check_freshness=False)
            with self.assertRaisesRegex(ToolViewError, "expired_tool_view"):
                verify_tool_view(signed(expiry=True), user_message="hello", now=1000,
                                 check_freshness=False)

    def test_signed_replay_requires_durable_retained_native_record(self):
        durable = types.SimpleNamespace(durable=True, RETENTION_SECONDS=86400)
        memory = types.SimpleNamespace(durable=False, RETENTION_SECONDS=86400)
        record = {"updated_at": 1000.0, "retention_until": 87400.0,
                  "run_id": "run_original"}
        self.assertTrue(retained_durable_replay(durable, record, now=1001))
        self.assertFalse(retained_durable_replay(memory, record, now=1001))
        self.assertFalse(retained_durable_replay(durable, record, now=87400))
        self.assertFalse(retained_durable_replay(durable, record, now=999))
        self.assertFalse(retained_durable_replay(durable, {"run_id": "run_original"}, now=1001))

    def test_worker_catalog_handshake_and_refresh_drift_fail_closed(self):
        raw = [schema("read"), schema("clarify")]
        registry = list(raw)
        calls = []
        def definitions(**kwargs):
            calls.append(kwargs)
            return list(registry)
        fake_model_tools = types.SimpleNamespace(get_tool_definitions=definitions)
        agent = types.SimpleNamespace(api_mode="chat_completions", provider="custom",
                                      tools=list(raw), valid_tool_names={"read", "clarify"},
                                      enabled_toolsets=["meri"], disabled_toolsets=None)
        with patch.dict(sys.modules, {"model_tools": fake_model_tools}):
            with patch.dict(os.environ, {"MERI_HERMES_TOOL_VIEW_V1_ENABLED": "1"}):
                advertised = worker_catalog_capability(enabled_toolsets=["meri"])
            self.assertEqual(advertised["worker_catalog_sha256"], catalog_version(raw))
            self.assertEqual(advertised["worker_catalog_schemas"], sorted(
                raw, key=lambda schema: schema["function"]["name"]))
            self.assertNotIn("registered_tool_names", advertised)
            self.assertEqual(calls[0]["enabled_toolsets"], ["meri"])
            apply_agent_tool_view(agent, view(raw, ("read",), ("read",)))
            self.assertEqual(calls[1]["enabled_toolsets"], ["meri"])
            registry[0] = {"type": "function", "function": {
                "name": "read", "parameters": {"type": "object", "properties": {"new": {"type": "string"}}}}}
            with self.assertRaisesRegex(ToolViewError, "stale_worker_catalog"):
                filter_agent_tool_view(agent, [schema("read")])
            with self.assertRaisesRegex(ToolViewError, "stale_worker_catalog"):
                tool_name_allowed(agent, "read")
            with self.assertRaisesRegex(ToolViewError, "stale_worker_catalog"):
                assert_final_provider_tool_payload(agent, {"tools": [schema("read")]})

    def test_worker_catalog_missing_optional_and_changed_provider_schema_fail_closed(self):
        raw = [schema("read"), schema("clarify")]
        agent = types.SimpleNamespace(api_mode="chat_completions", provider="custom",
                                      tools=list(raw), valid_tool_names={"read", "clarify"})
        with patch.dict(sys.modules, {"model_tools": types.SimpleNamespace(
            get_tool_definitions=lambda **_kwargs: list(raw),
        )}):
            with self.assertRaisesRegex(ToolViewError, "tool_unavailable_in_worker_catalog"):
                apply_agent_tool_view(agent, view(raw, ("read", "missing"), ("read",)))
            apply_agent_tool_view(agent, view(raw, ("read",), ("read",)))
            changed = {"type": "function", "function": {"name": "read", "description": "changed"}}
            with self.assertRaisesRegex(ToolViewError, "changed_worker_tool_schema"):
                assert_final_provider_tool_payload(agent, {"tools": [changed]})

    def test_per_agent_filter_refresh_and_invocation(self):
        original = [schema("read"), schema("write"), schema("clarify")]
        a = types.SimpleNamespace(tools=list(original), valid_tool_names={"read", "write", "clarify"})
        b = types.SimpleNamespace(tools=list(original), valid_tool_names={"read", "write", "clarify"})
        view_a = view(original, ("read", "clarify"), ("read",))
        view_b = view(original, ("write",), ("write",))
        with patch.dict(sys.modules, {"model_tools": types.SimpleNamespace(
            get_tool_definitions=lambda **_kwargs: list(original),
        )}):
            apply_agent_tool_view(a, view_a)
            apply_agent_tool_view(b, view_b)
            self.assertEqual(a.valid_tool_names, {"read", "clarify"})
            self.assertEqual(b.valid_tool_names, {"write"})
            self.assertEqual(len(original), 3)
            self.assertFalse(tool_name_allowed(a, "write"))
            self.assertTrue(tool_name_allowed(b, "write"))
            a.tools.append(schema("write"))  # simulate a same-run MCP refresh
            filtered = filter_agent_tool_view(a, [schema("read"), schema("write")])
            self.assertEqual([s["function"]["name"] for s in filtered], ["read"])
            self.assertEqual(a.valid_tool_names, {"read", "clarify"})
            self.assertEqual(b.valid_tool_names, {"write"})

    def test_required_missing_and_provider_middleware_widening_fail(self):
        agent = types.SimpleNamespace(tools=[schema("read")], valid_tool_names={"read"})
        with patch.dict(sys.modules, {"model_tools": types.SimpleNamespace(
            get_tool_definitions=lambda **_kwargs: [schema("read")],
        )}):
            with self.assertRaisesRegex(ToolViewError, "required_tool_unavailable_in_worker"):
                apply_agent_tool_view(agent, view([schema("read")], ("write",), ("write",)))
        assert_provider_tool_payload({"tools": [schema("read")]}, frozenset({"read"}))
        with self.assertRaisesRegex(ToolViewError, "provider_tool_outside_view"):
            assert_provider_tool_payload({"tools": [schema("write")]}, frozenset({"read"}))
        raw = [schema("read")]
        narrowed = types.SimpleNamespace(api_mode="chat_completions", provider="custom",
            tools=list(raw), valid_tool_names={"read"})
        with patch.dict(sys.modules, {"model_tools": types.SimpleNamespace(
            get_tool_definitions=lambda **_kwargs: list(raw),
        )}):
            apply_agent_tool_view(narrowed, view(raw, ("read",), ("read",)))
            with self.assertRaisesRegex(ToolViewError, "required_tool_missing_from_provider_request"):
                assert_final_provider_tool_payload(narrowed, {"tools": []})

    def test_overlapping_agents_keep_distinct_views(self):
        registry_snapshot = [schema("read"), schema("write")]
        barrier = Barrier(2)

        def run(names):
            agent = types.SimpleNamespace(tools=list(registry_snapshot), valid_tool_names={"read", "write"})
            apply_agent_tool_view(agent, view(registry_snapshot, names, names))
            barrier.wait()
            return tuple(sorted(agent.valid_tool_names)), tool_name_allowed(agent, "write")

        with patch.dict(sys.modules, {"model_tools": types.SimpleNamespace(
            get_tool_definitions=lambda **_kwargs: list(registry_snapshot),
        )}):
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(run, ("read",))
                second = pool.submit(run, ("write",))
                self.assertEqual(first.result(), (("read",), False))
                self.assertEqual(second.result(), (("write",), True))
        self.assertEqual([s["function"]["name"] for s in registry_snapshot], ["read", "write"])

    def test_signed_view_rehydrates_plugin_schema_deferred_behind_tool_search(self):
        agent = types.SimpleNamespace(
            tools=[schema("tool_search")], valid_tool_names={"tool_search"},
            enabled_toolsets=["meri"], disabled_toolsets=[],
        )
        raw = [schema("meri_fetch_attachment"), schema("meri_request_clarification")]
        with patch.dict(sys.modules, {"model_tools": types.SimpleNamespace(
            get_tool_definitions=lambda **_kwargs: list(raw),
        )}):
            apply_agent_tool_view(agent, view(raw, ("meri_fetch_attachment",),
                                              ("meri_fetch_attachment",)))
        self.assertEqual(agent.valid_tool_names, {"meri_fetch_attachment"})
        self.assertEqual([tool["function"]["name"] for tool in agent.tools], ["meri_fetch_attachment"])


if __name__ == "__main__":
    unittest.main()
