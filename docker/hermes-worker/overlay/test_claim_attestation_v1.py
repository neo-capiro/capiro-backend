"""Hermetic worker claim/attestation contract tests; no network or provider."""
from __future__ import annotations

import base64
import json
import os
import pathlib
import sys
import types
import unittest
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from meri_claim_attestation_v1 import (
    ClaimAttestationKey, Phase4ClaimError, Phase4ClaimGate,
    _NoRedirect, _load_attestation_key, _post_claim,
    capture_phase4_claim_context, mint_claim_tool_view_attestation_v1,
    phase4_claim_ingress_allowed, phase4_native_retention_until,
    phase4_worker_idempotency_fingerprint,
)


ROOT = pathlib.Path(__file__).parent
VECTOR = json.loads((ROOT / "claim-tool-view-attestation-vectors.json").read_text(encoding="utf-8"))
RAW_BODY = base64.urlsafe_b64decode(VECTOR["requestBodyBase64url"] + "==")


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _bearer() -> str:
    identity = VECTOR["identity"]
    claims = {
        "version": 1,
        "purpose": "meri-hermes-dispatch-gate",
        "keyId": "dispatch-key-vector",
        "tenantId": identity["tenantId"],
        "actorType": "user",
        "actorId": identity["actorId"],
        "scopeId": identity["scopeId"],
        "runId": identity["runId"],
        "requestSha256": identity["requestSha256"],
        "workerAudience": identity["workerAudience"],
        "workerIngressId": identity["workerIngressId"],
        "workerGeneration": identity["workerGeneration"],
        "workerCredentialId": identity["workerCredentialId"],
        "authorizationVersion": identity["authorizationVersion"],
        "reconciliationNotAfterEpochMicros": identity["reconciliationNotAfterEpochMicros"],
        "retainUntilEpochMicros": identity["retainUntilEpochMicros"],
        "notBeforeEpochMicros": VECTOR["notBeforeEpochMicros"],
        "notAfterEpochMicros": VECTOR["notAfterEpochMicros"],
    }
    return f"mdgb1.{_b64(json.dumps(claims, separators=(',', ':')).encode())}.{_b64(bytes([19]) * 32)}"


def _env() -> dict[str, str]:
    key = VECTOR["key"]
    return {
        "MERI_PHASE4_CLAIM_V1_ENABLED": "1",
        "MERI_PHASE4_TENANT_ID": key["tenantId"],
        "MERI_PHASE4_SCOPE_ID": key["scopeId"],
        "MERI_PHASE4_WORKER_AUDIENCE": key["workerAudience"],
        "MERI_PHASE4_WORKER_INGRESS_ID": key["workerIngressId"],
        "MERI_PHASE4_WORKER_GENERATION": key["workerGeneration"],
        "MERI_PHASE4_WORKER_CREDENTIAL_ID": key["workerCredentialId"],
        "MERI_PHASE4_CLAIM_ATTESTATION_KEY_B64URL": key["secretBase64url"],
        "MERI_PHASE4_CLAIM_ATTESTATION_KEY_NOT_BEFORE_EPOCH_MICROS": key["notBeforeEpochMicros"],
        "MERI_PHASE4_CLAIM_ATTESTATION_KEY_NOT_AFTER_EPOCH_MICROS": key["notAfterEpochMicros"],
    }


def _context():
    return capture_phase4_claim_context(
        bearer=_bearer(), raw_body=RAW_BODY, received_method="POST",
        received_path="/v1/runs", received_content_type="application/json",
        session_header_value=VECTOR["sessionHeaderValue"],
        idempotency_key_header_value="phase4-claim-vector",
        worker_run_id=VECTOR["workerRunId"],
    )


def _view():
    return {
        "worker_catalog_sha256": VECTOR["identity"]["catalogDigest"],
        "applied_tool_view_sha256": VECTOR["identity"]["toolViewDigest"],
        "tool_names": frozenset({"read"}),
        "required_tool_names": frozenset({"read"}),
        "selected_schema_sha256": {
            "read": "664b3b55e76d08862df51cd21d40d5d4444fb85e2f07ec627ff2f52615fa1833",
        },
    }


class WorkerClaimAttestationTest(unittest.TestCase):
    def test_guarded_main_aiohttp_surface_uses_an_exact_route_allowlist(self):
        allowed = {
            ("POST", "/v1/runs"),
            ("GET", "/v1/runs/run_1"),
            ("GET", "/v1/runs/run_1/events"),
            ("POST", "/v1/runs/run_1/approval"),
            ("POST", "/v1/runs/run_1/steer"),
            ("POST", "/v1/runs/run_1/stop"),
            ("POST", "/v1/meri/phase4/reservations/lookup-or-seal"),
            ("GET", "/health"),
            ("GET", "/health/detailed"),
            ("GET", "/v1/capabilities"),
            ("GET", "/v1/models"),
        }
        for method, path in allowed:
            with self.subTest(method=method, path=path):
                self.assertTrue(phase4_claim_ingress_allowed(method, path))
        denied = {
            ("POST", "/v1/chat/completions"),
            ("POST", "/v1/responses"),
            ("POST", "/api/sessions/s/chat"),
            ("POST", "/api/sessions/s/chat/stream"),
            ("POST", "/chat/stream"),
            ("POST", "/p/default/v1/runs"),
            ("GET", "/v1/browser-control/ws"),
            ("POST", "/api/cron/fire"),
            ("DELETE", "/v1/runs/run_1"),
            ("OPTIONS", "/v1/runs"),
        }
        for method, path in denied:
            with self.subTest(method=method, path=path):
                self.assertFalse(phase4_claim_ingress_allowed(method, path))
        self.assertFalse(phase4_claim_ingress_allowed("POST", "/v1/runs", "x=1"))

    def test_guarded_native_idempotency_binds_exact_wire_bytes_and_headers(self):
        material = dict(
            raw_body=RAW_BODY, received_method="POST", received_path="/v1/runs",
            received_content_type="application/json",
            session_header_value=VECTOR["sessionHeaderValue"],
            idempotency_key_header_value="phase4-claim-vector",
            dispatch_gate_bearer_header_value=_bearer(),
        )
        baseline = phase4_worker_idempotency_fingerprint(**material)
        for field, value in (
            ("raw_body", RAW_BODY + b" "),
            ("session_header_value", VECTOR["sessionHeaderValue"] + "x"),
            ("idempotency_key_header_value", "phase4-claim-vector-x"),
            ("dispatch_gate_bearer_header_value", _bearer() + "x"),
        ):
            with self.subTest(field=field):
                changed = dict(material)
                changed[field] = value
                self.assertNotEqual(
                    baseline, phase4_worker_idempotency_fingerprint(**changed))
        for field, value in (
            ("received_method", "PUT"), ("received_path", "/v1/runs/"),
            ("received_content_type", "application/json; charset=utf-8"),
        ):
            with self.subTest(field=field), self.assertRaises(Phase4ClaimError):
                changed = dict(material)
                changed[field] = value
                phase4_worker_idempotency_fingerprint(**changed)

    def test_native_retention_is_exactly_bearer_bound_and_rounded_up(self):
        encoded = _bearer().split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        retain_micros = int(claims["retainUntilEpochMicros"])
        self.assertEqual(phase4_native_retention_until(claims),
                         (retain_micros + 999_999) // 1_000_000)
        invalid = [
            {**claims, "reconciliationNotAfterEpochMicros": claims["notAfterEpochMicros"]},
            {**claims, "retainUntilEpochMicros": claims["reconciliationNotAfterEpochMicros"]},
            {**claims, "retainUntilEpochMicros": str(
                int(claims["notBeforeEpochMicros"]) + 8 * 86_400_000_000)},
        ]
        for changed in invalid:
            with self.subTest(changed=changed), self.assertRaises(Phase4ClaimError):
                phase4_native_retention_until(changed)

    def test_python_mint_matches_typescript_golden_vector(self):
        key = VECTOR["key"]
        identity = VECTOR["identity"]
        material = ClaimAttestationKey(
            secret=base64.urlsafe_b64decode(key["secretBase64url"] + "="),
            tenant_id=key["tenantId"], scope_id=key["scopeId"],
            worker_audience=key["workerAudience"], worker_ingress_id=key["workerIngressId"],
            worker_generation=key["workerGeneration"],
            worker_credential_id=key["workerCredentialId"],
            not_before_epoch_micros=key["notBeforeEpochMicros"],
            not_after_epoch_micros=key["notAfterEpochMicros"],
        )
        token = mint_claim_tool_view_attestation_v1(
            tenant_id=identity["tenantId"], run_id=identity["runId"],
            request_sha256=identity["requestSha256"], worker_run_id=VECTOR["workerRunId"],
            worker_audience=identity["workerAudience"],
            worker_ingress_id=identity["workerIngressId"],
            worker_generation=identity["workerGeneration"],
            worker_credential_id=identity["workerCredentialId"],
            catalog_digest=identity["catalogDigest"], tool_view_digest=identity["toolViewDigest"],
            not_before_epoch_micros=VECTOR["notBeforeEpochMicros"],
            not_after_epoch_micros=VECTOR["notAfterEpochMicros"], key=material,
        )
        self.assertEqual(token, VECTOR["token"])
        encoded, signature = token.split(".")
        self.assertEqual(encoded, VECTOR["encoded"])
        self.assertEqual(signature, VECTOR["signatureHex"])
        self.assertEqual(json.loads(base64.urlsafe_b64decode(
            encoded + "=" * (-len(encoded) % 4))), VECTOR["claims"])

    def test_exact_bytes_headers_and_one_transition_open_the_gate(self):
        calls = []

        def transport(payload):
            wire = json.loads(payload)
            calls.append(wire)
            return {"version": 2, "kind": "transitioned", "launchAuthorized": True}

        registry = VECTOR["observedCatalogTools"]
        agent = types.SimpleNamespace(enabled_toolsets=["meri"], disabled_toolsets=[],
                                      tools=VECTOR["observedAppliedToolSchemas"])
        with patch.dict(os.environ, _env(), clear=True), patch.dict(
            sys.modules, {"model_tools": types.SimpleNamespace(
                get_tool_definitions=lambda **_kwargs: registry)},
        ):
            gate = Phase4ClaimGate(_context(), transport=transport)
            gate.authorize(agent, _view())
            gate.authorize(agent, _view())
        self.assertTrue(gate.authorized)
        self.assertEqual(len(calls), 1)
        wire = calls[0]
        self.assertEqual(base64.urlsafe_b64decode(wire["bodyBase64url"] + "=="), RAW_BODY)
        self.assertEqual(wire["sessionHeaderValue"], VECTOR["sessionHeaderValue"])
        self.assertEqual(wire["idempotencyKeyHeaderValue"], "phase4-claim-vector")
        self.assertEqual(wire["receivedMethod"], "POST")
        self.assertEqual(wire["receivedPath"], "/v1/runs")
        self.assertNotIn("claimUrl", wire)
        self.assertNotIn("attestationKeyId", wire)

    def test_only_transitioned_authorizes_and_ambiguous_results_never_retry(self):
        registry = VECTOR["observedCatalogTools"]
        agent = types.SimpleNamespace(enabled_toolsets=["meri"], disabled_toolsets=[],
                                      tools=VECTOR["observedAppliedToolSchemas"])
        responses = [
            {"version": 2, "kind": "status_only", "launchAuthorized": False},
            {"version": 2, "kind": "rejected", "launchAuthorized": False},
            {"version": 2, "kind": "UNKNOWN", "reason": "commit_unconfirmed",
             "launchAuthorized": False},
            {"version": 2, "kind": "transitioned", "launchAuthorized": False},
            {"version": 2, "kind": "transitioned", "launchAuthorized": True, "extra": True},
        ]
        with patch.dict(os.environ, _env(), clear=True), patch.dict(
            sys.modules, {"model_tools": types.SimpleNamespace(
                get_tool_definitions=lambda **_kwargs: registry)},
        ):
            for response in responses:
                with self.subTest(response=response):
                    count = [0]
                    def transport(_payload):
                        count[0] += 1
                        return response
                    gate = Phase4ClaimGate(_context(), transport=transport)
                    with self.assertRaises(Phase4ClaimError):
                        gate.authorize(agent, _view())
                    with self.assertRaises(Phase4ClaimError):
                        gate.authorize(agent, _view())
                    self.assertEqual(count[0], 1)
                    self.assertFalse(gate.authorized)
            count = [0]
            def failed_transport(_payload):
                count[0] += 1
                raise OSError("synthetic ambiguous transport failure")
            gate = Phase4ClaimGate(_context(), transport=failed_transport)
            with self.assertRaises(OSError):
                gate.authorize(agent, _view())
            with self.assertRaises(Phase4ClaimError):
                gate.authorize(agent, _view())
            self.assertEqual(count[0], 1)
            self.assertFalse(gate.authorized)

    def test_concurrent_first_use_shares_one_claim_decision(self):
        registry = VECTOR["observedCatalogTools"]
        agent = types.SimpleNamespace(enabled_toolsets=["meri"], disabled_toolsets=[],
                                      tools=VECTOR["observedAppliedToolSchemas"])
        count = [0]
        def transport(_payload):
            count[0] += 1
            return {"version": 2, "kind": "transitioned", "launchAuthorized": True}
        with patch.dict(os.environ, _env(), clear=True), patch.dict(
            sys.modules, {"model_tools": types.SimpleNamespace(
                get_tool_definitions=lambda **_kwargs: registry)},
        ):
            gate = Phase4ClaimGate(_context(), transport=transport)
            with ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(lambda _item: gate.authorize(agent, _view()), range(2)))
        self.assertEqual(count[0], 1)
        self.assertTrue(gate.authorized)

    def test_concurrent_ambiguous_claim_is_one_permanent_denial(self):
        registry = VECTOR["observedCatalogTools"]
        agent = types.SimpleNamespace(enabled_toolsets=["meri"], disabled_toolsets=[],
                                      tools=VECTOR["observedAppliedToolSchemas"])
        count = [0]
        def transport(_payload):
            count[0] += 1
            return {"version": 2, "kind": "UNKNOWN", "launchAuthorized": False}
        with patch.dict(os.environ, _env(), clear=True), patch.dict(
            sys.modules, {"model_tools": types.SimpleNamespace(
                get_tool_definitions=lambda **_kwargs: registry)},
        ):
            gate = Phase4ClaimGate(_context(), transport=transport)
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(gate.authorize, agent, _view()) for _ in range(2)]
                for future in futures:
                    with self.assertRaises(Phase4ClaimError):
                        future.result()
        self.assertEqual(count[0], 1)
        self.assertFalse(gate.authorized)

    def test_real_transport_is_https_no_proxy_no_redirect_and_bounded(self):
        opened = []
        payload = b'{"version":2}'
        response_value = {"version": 2, "kind": "transitioned", "launchAuthorized": True}

        class Response:
            status = 200
            headers = types.SimpleNamespace(get_content_type=lambda: "application/json")
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def read(self, maximum):
                self.maximum = maximum
                return json.dumps(response_value, separators=(",", ":")).encode()

        response = Response()
        opener = types.SimpleNamespace(open=lambda request, timeout: (
            opened.append((request, timeout)) or response))
        env = {
            "MERI_PHASE4_CLAIM_ORIGIN": "https://claim.internal:8443",
            "MERI_PHASE4_CLAIM_SERVICE_SECRET": "s" * 32,
        }
        with patch.dict(os.environ, env, clear=False), patch(
            "meri_claim_attestation_v1.urllib.request.build_opener", return_value=opener,
        ) as build:
            self.assertEqual(_post_claim(payload), response_value)
        handlers = build.call_args.args
        self.assertTrue(any(isinstance(item, urllib.request.ProxyHandler) for item in handlers))
        self.assertTrue(any(isinstance(item, urllib.request.HTTPSHandler) for item in handlers))
        self.assertTrue(any(isinstance(item, _NoRedirect) for item in handlers))
        request, timeout = opened[0]
        self.assertEqual(request.full_url,
                         "https://claim.internal:8443/api/internal/meri/hermes/phase4/claim")
        self.assertEqual(request.data, payload)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("X-meri-dispatch-claim-service-secret"), "s" * 32)
        self.assertEqual(timeout, 2.0)
        self.assertEqual(response.maximum, 4097)

    def test_route_drift_and_secret_fallbacks_fail_closed(self):
        fallback_only = {
            "MERI_PHASE4_CLAIM_V1_ENABLED": "1",
            "API_SERVER_KEY": "a" * 64,
            "MERI_WORKER_TOKEN": "b" * 64,
            "MERI_HERMES_TOOL_VIEW_SIGNING_KEY": "c" * 64,
        }
        with patch.dict(os.environ, fallback_only, clear=True):
            with self.assertRaises(Phase4ClaimError):
                capture_phase4_claim_context(
                    bearer=_bearer(), raw_body=RAW_BODY, received_method="POST",
                    received_path="/v1/runs", received_content_type="application/json",
                    session_header_value=VECTOR["sessionHeaderValue"],
                    idempotency_key_header_value="phase4-claim-vector",
                    worker_run_id=VECTOR["workerRunId"],
                )
        with patch.dict(os.environ, _env(), clear=True):
            for path in ("/p/other/v1/runs", "/v1/chat/completions"):
                with self.subTest(path=path), self.assertRaises(Phase4ClaimError):
                    capture_phase4_claim_context(
                        bearer=_bearer(), raw_body=RAW_BODY, received_method="POST",
                        received_path=path, received_content_type="application/json",
                        session_header_value=VECTOR["sessionHeaderValue"],
                        idempotency_key_header_value="phase4-claim-vector",
                        worker_run_id=VECTOR["workerRunId"],
                    )

        route_only = _env()
        route_only.pop("MERI_PHASE4_CLAIM_ATTESTATION_KEY_B64URL")
        route_only.update({
            "API_SERVER_KEY": "a" * 64,
            "MERI_WORKER_TOKEN": "b" * 64,
            "MERI_HERMES_TOOL_VIEW_SIGNING_KEY": "c" * 64,
        })
        registry = VECTOR["observedCatalogTools"]
        agent = types.SimpleNamespace(enabled_toolsets=["meri"], disabled_toolsets=[],
                                      tools=VECTOR["observedAppliedToolSchemas"])
        with patch.dict(os.environ, route_only, clear=True), patch.dict(
            sys.modules, {"model_tools": types.SimpleNamespace(
                get_tool_definitions=lambda **_kwargs: registry)},
        ):
            gate = Phase4ClaimGate(_context(), transport=lambda _payload: {})
            with self.assertRaises(Phase4ClaimError):
                gate.authorize(agent, _view())

        raw_key = base64.urlsafe_b64decode(
            VECTOR["key"]["secretBase64url"] + "=").decode("utf-8")
        for name in (
            "MERI_HERMES_TOOL_VIEW_SIGNING_KEY", "API_SERVER_KEY",
            "MERI_PHASE4_CLAIM_SERVICE_SECRET", "MERI_WORKER_TOKEN",
            "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY",
        ):
            with self.subTest(shared_secret=name):
                shared = _env()
                shared[name] = raw_key
                with patch.dict(os.environ, shared, clear=True), self.assertRaisesRegex(
                    Phase4ClaimError, "not_purpose_separated",
                ):
                    _load_attestation_key()

    def test_schema_mutation_before_claim_permanently_denies(self):
        registry = VECTOR["observedCatalogTools"]
        mutated = json.loads(json.dumps(VECTOR["observedAppliedToolSchemas"]))
        mutated[0]["function"]["description"] = "mutated after apply"
        agent = types.SimpleNamespace(enabled_toolsets=["meri"], disabled_toolsets=[], tools=mutated)
        calls = []
        with patch.dict(os.environ, _env(), clear=True), patch.dict(
            sys.modules, {"model_tools": types.SimpleNamespace(
                get_tool_definitions=lambda **_kwargs: registry)},
        ):
            gate = Phase4ClaimGate(_context(), transport=lambda payload: calls.append(payload))
            with self.assertRaises(Exception):
                gate.authorize(agent, _view())
            with self.assertRaises(Phase4ClaimError):
                gate.authorize(agent, _view())
        self.assertEqual(calls, [])
        self.assertFalse(gate.authorized)


if __name__ == "__main__":
    unittest.main()
