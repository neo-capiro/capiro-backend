"""Hermetic Phase 4 recovery v1 command/receipt contract tests."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import pathlib
import time
import unittest
from dataclasses import replace
from unittest.mock import patch

from meri_recovery_receipt_v1 import (
    COMMAND_PURPOSE,
    RECEIPT_PURPOSE,
    RecoveryKey,
    RecoveryProtocolError,
    matches_recovery_native_request_v1,
    matches_recovery_native_response_v1,
    mint_recovery_command_v1,
    mint_recovery_receipt_v1,
    normalize_native_observation_v1,
    normalize_native_response_v1,
    recovery_disposition_v1,
    recovery_keys_are_distinct,
    verify_recovery_command_v1,
    verify_recovery_receipt_v1,
)
from meri_recovery_runtime_v1 import (
    authorize_recovery_request_v1,
    sign_recovery_response_v1,
    validate_recovery_runtime_v1,
)


ROOT = pathlib.Path(__file__).parent
VECTOR = json.loads((ROOT / "recovery-receipt-vectors.json").read_text(encoding="utf-8"))
COMMAND_DOMAIN = b"capiro.meri.phase4.recovery-command/v1\0"
RECEIPT_DOMAIN = b"capiro.meri.phase4.recovery-receipt/v1\0"


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _key(value: dict) -> RecoveryKey:
    return RecoveryKey(
        purpose=value["purpose"], key_id=value["keyId"],
        tenant_id=value["tenantId"], worker_audience=value["workerAudience"],
        worker_ingress_id=value["workerIngressId"],
        worker_generation=value["workerGeneration"],
        worker_credential_id=value["workerCredentialId"],
        secret=_b64decode(value["secretBase64url"]),
        not_before_epoch_micros=value["notBeforeEpochMicros"],
        not_after_epoch_micros=value["notAfterEpochMicros"],
    )


def _payload(token: str) -> dict:
    return json.loads(_b64decode(token.split(".")[1]).decode("utf-8"))


def _resign(prefix: str, domain: bytes, raw_json: str, secret: bytes) -> str:
    encoded = _b64(raw_json.encode("utf-8"))
    signature = hmac.new(
        secret, domain + f"{prefix}.{encoded}".encode("ascii"), hashlib.sha256,
    ).digest()
    return f"{prefix}.{encoded}.{_b64(signature)}"


class RecoveryReceiptV1Test(unittest.TestCase):
    def setUp(self) -> None:
        self.identity = VECTOR["identity"]
        self.worker_run_id = VECTOR["workerRunId"]
        self.verify_at = VECTOR["verifyAtEpochMicros"]
        self.command_key = _key(VECTOR["commandKey"])
        self.receipt_key = _key(VECTOR["receiptKey"])

    def _mint_vector_command(self) -> str:
        command = VECTOR["command"]
        return mint_recovery_command_v1(
            identity=self.identity, worker_run_id=self.worker_run_id,
            action=command["action"], operation_id=command["operationId"],
            attempt_nonce=command["attemptNonce"],
            native_body=_b64decode(command["nativeBodyBase64url"]),
            not_before_epoch_micros=command["notBeforeEpochMicros"],
            not_after_epoch_micros=command["notAfterEpochMicros"],
            key=self.command_key,
        )

    def _worker_env(self) -> dict[str, str]:
        identity = self.identity
        result = {
            "API_SERVER_KEY": "native-api-key",
            "MERI_PHASE4_TENANT_ID": identity["tenantId"],
            "MERI_PHASE4_WORKER_AUDIENCE": identity["workerAudience"],
            "MERI_PHASE4_WORKER_INGRESS_ID": identity["workerIngressId"],
            "MERI_PHASE4_WORKER_GENERATION": identity["workerGeneration"],
            "MERI_PHASE4_WORKER_CREDENTIAL_ID": identity["workerCredentialId"],
        }
        for prefix, key in (
            ("MERI_PHASE4_RECOVERY_COMMAND", VECTOR["commandKey"]),
            ("MERI_PHASE4_RECOVERY_RECEIPT", VECTOR["receiptKey"]),
        ):
            result.update({
                f"{prefix}_KEY_ID": key["keyId"],
                f"{prefix}_KEY_B64URL": key["secretBase64url"],
                f"{prefix}_KEY_NOT_BEFORE_EPOCH_MICROS": key["notBeforeEpochMicros"],
                f"{prefix}_KEY_NOT_AFTER_EPOCH_MICROS": key["notAfterEpochMicros"],
            })
        return result

    def _verify_command(self, token: str | None = None, **changes):
        identity = {**self.identity, **changes}
        return verify_recovery_command_v1(
            token or VECTOR["commandToken"], identity, self.worker_run_id,
            self.command_key, self.verify_at,
        )

    def _mint_vector_receipt(self, command_token: str, command) -> str:
        receipt = VECTOR["receipt"]
        return mint_recovery_receipt_v1(
            command_token=command_token, command=command,
            observation=receipt["observation"], worker_status=receipt["workerStatus"],
            native_http_status=receipt["nativeHttpStatus"],
            native_response_body=_b64decode(receipt["nativeResponseBodyBase64url"]),
            observed_at_epoch_micros=receipt["observedAtEpochMicros"],
            key=self.receipt_key,
        )

    def _verify_receipt(self, token: str, command_token: str | None = None,
                        command_key: RecoveryKey | None = None,
                        receipt_key: RecoveryKey | None = None):
        return verify_recovery_receipt_v1(
            token, command_token or VECTOR["commandToken"], self.identity,
            self.worker_run_id, command_key or self.command_key,
            receipt_key or self.receipt_key, self.verify_at,
        )

    def test_exact_typescript_command_and_expected_python_receipt_vectors(self):
        self.assertEqual(VECTOR["source"],
                         "apps/api/src/meri/hermes/meri-hermes-dispatch-recovery.contract.spec.ts")
        command_token = self._mint_vector_command()
        self.assertEqual(command_token, VECTOR["commandToken"])
        command = self._verify_command(command_token)
        self.assertIsNotNone(command)
        self.assertEqual(dict(command), VECTOR["commandClaims"])
        receipt_token = self._mint_vector_receipt(command_token, command)
        self.assertEqual(receipt_token, VECTOR["receiptToken"])
        receipt = self._verify_receipt(receipt_token, command_token)
        self.assertIsNotNone(receipt)
        self.assertEqual(dict(receipt), VECTOR["receiptClaims"])
        self.assertEqual(recovery_disposition_v1(receipt), "nonterminal")

    def test_command_rejects_duplicate_unknown_reordered_and_malformed_json(self):
        token = VECTOR["commandToken"]
        claims = _payload(token)
        unknown = {**claims, "extra": True}
        reordered = dict(reversed(list(claims.items())))
        duplicate = json.dumps(claims, separators=(",", ":")).replace(
            '"tenantId":',
            '"tenantId":"99999999-9999-4999-8999-999999999999","tenantId":',
        )
        for raw in (
            json.dumps(unknown, separators=(",", ":")),
            json.dumps(reordered, separators=(",", ":")),
            duplicate,
            "{",
            "[]",
        ):
            with self.subTest(raw=raw[:40]):
                forged = _resign("mhrc1", COMMAND_DOMAIN, raw, self.command_key.secret)
                self.assertIsNone(self._verify_command(forged))

    def test_command_rejects_wrong_route_generation_credential_key_id_and_native_request(self):
        claims = _payload(VECTOR["commandToken"])
        mutations = {
            "keyId": "another-command-key",
            "tenantId": "99999999-9999-4999-8999-999999999999",
            "runId": "99999999-9999-4999-8999-999999999999",
            "requestSha256": "c" * 64,
            "workerRunId": "another-worker-run",
            "workerAudience": "another-audience",
            "workerIngressId": "another-ingress",
            "workerGeneration": "another-generation",
            "workerCredentialId": "another-credential",
            "action": "stop",
            "nativeMethod": "POST",
            "nativePath": f'/v1/runs/{self.worker_run_id}/stop',
            "nativeBodySha256": "d" * 64,
        }
        for field, value in mutations.items():
            with self.subTest(field=field):
                changed = {**claims, field: value}
                forged = _resign(
                    "mhrc1", COMMAND_DOMAIN,
                    json.dumps(changed, separators=(",", ":")), self.command_key.secret,
                )
                self.assertIsNone(self._verify_command(forged))
        command = self._verify_command()
        self.assertTrue(matches_recovery_native_request_v1(
            command, "GET", f"/v1/runs/{self.worker_run_id}", b""))
        self.assertFalse(matches_recovery_native_request_v1(
            command, "POST", f"/v1/runs/{self.worker_run_id}", b""))
        self.assertFalse(matches_recovery_native_request_v1(
            command, "GET", f"/v1/runs/{self.worker_run_id}", b"{}"))
        wrong_key = replace(self.command_key, key_id="another-command-key")
        self.assertIsNone(verify_recovery_command_v1(
            VECTOR["commandToken"], self.identity, self.worker_run_id,
            wrong_key, self.verify_at))

    def test_noncanonical_base64url_signature_and_exclusive_windows_fail_closed(self):
        token = VECTOR["commandToken"]
        prefix, payload, signature = token.split(".")
        cases = (
            token + "=",
            f"{prefix}.{payload}=.{signature}",
            f"{prefix}.{payload}.{signature}=",
            f"{prefix}.{payload}.{signature[:-1]}{('A' if signature[-1] != 'A' else 'B')}",
            token.replace("mhrc1.", "mhrr1.", 1),
            "a" * 8193,
            "mhrc1.\ud800.invalid",
        )
        for candidate in cases:
            with self.subTest(candidate=candidate[:20]):
                self.assertIsNone(self._verify_command(candidate))
        self.assertIsNotNone(verify_recovery_command_v1(
            token, self.identity, self.worker_run_id, self.command_key,
            VECTOR["command"]["notBeforeEpochMicros"]))
        self.assertIsNone(verify_recovery_command_v1(
            token, self.identity, self.worker_run_id, self.command_key,
            VECTOR["command"]["notAfterEpochMicros"]))
        self.assertIsNone(verify_recovery_command_v1(
            token, self.identity, self.worker_run_id, self.command_key,
            str(int(VECTOR["command"]["notBeforeEpochMicros"]) - 1)))

    def test_native_path_matches_javascript_encode_uri_component(self):
        special = "worker/run?one"
        token = mint_recovery_command_v1(
            identity=self.identity, worker_run_id=special, action="status",
            operation_id="88888888-8888-4888-8888-888888888888",
            attempt_nonce=_b64(bytes([33]) * 16), native_body=b"",
            not_before_epoch_micros=VECTOR["command"]["notBeforeEpochMicros"],
            not_after_epoch_micros=VECTOR["command"]["notAfterEpochMicros"],
            key=self.command_key,
        )
        command = verify_recovery_command_v1(
            token, self.identity, special, self.command_key, self.verify_at)
        self.assertEqual(command["nativePath"], "/v1/runs/worker%2Frun%3Fone")

    def test_terminal_not_found_and_stop_acceptance_have_conservative_dispositions(self):
        command_token = VECTOR["commandToken"]
        command = self._verify_command(command_token)

        def status_receipt(observation, status, http, body):
            token = mint_recovery_receipt_v1(
                command_token=command_token, command=command, observation=observation,
                worker_status=status, native_http_status=http,
                native_response_body=body,
                observed_at_epoch_micros=VECTOR["receipt"]["observedAtEpochMicros"],
                key=self.receipt_key,
            )
            return self._verify_receipt(token)

        terminal_body = b'{"run_id":"worker-run-recovery-1","status":"cancelled"}'
        terminal = status_receipt("run_terminal", "cancelled", 200, terminal_body)
        not_found = status_receipt("not_found", None, 404, b'{"error":"not found"}')
        self.assertEqual(recovery_disposition_v1(terminal), "terminal")
        self.assertEqual(recovery_disposition_v1(not_found), "UNKNOWN")
        self.assertEqual(recovery_disposition_v1(None), "UNKNOWN")
        self.assertTrue(matches_recovery_native_response_v1(terminal, 200, terminal_body))

        stop_body = b"{}"
        stop_token = mint_recovery_command_v1(
            identity=self.identity, worker_run_id=self.worker_run_id, action="stop",
            operation_id="77777777-7777-4777-8777-777777777777",
            attempt_nonce=_b64(bytes([32]) * 16), native_body=stop_body,
            not_before_epoch_micros=VECTOR["command"]["notBeforeEpochMicros"],
            not_after_epoch_micros=VECTOR["command"]["notAfterEpochMicros"],
            key=self.command_key,
        )
        stop_command = verify_recovery_command_v1(
            stop_token, self.identity, self.worker_run_id, self.command_key, self.verify_at)
        self.assertTrue(matches_recovery_native_request_v1(
            stop_command, "POST", f"/v1/runs/{self.worker_run_id}/stop", stop_body))
        stop_receipt_token = mint_recovery_receipt_v1(
            command_token=stop_token, command=stop_command,
            observation="stop_accepted", worker_status=None, native_http_status=202,
            native_response_body=b'{"accepted":true}',
            observed_at_epoch_micros=VECTOR["receipt"]["observedAtEpochMicros"],
            key=self.receipt_key,
        )
        stop_receipt = verify_recovery_receipt_v1(
            stop_receipt_token, stop_token, self.identity, self.worker_run_id,
            self.command_key, self.receipt_key, self.verify_at)
        self.assertEqual(recovery_disposition_v1(stop_receipt), "nonterminal")

    def test_native_stopping_normalizes_to_signed_cancelling_but_binds_raw_bytes(self):
        stop_body = b"{}"
        stop_token = mint_recovery_command_v1(
            identity=self.identity, worker_run_id=self.worker_run_id, action="stop",
            operation_id="77777777-7777-4777-8777-777777777777",
            attempt_nonce=_b64(bytes([32]) * 16), native_body=stop_body,
            not_before_epoch_micros=VECTOR["command"]["notBeforeEpochMicros"],
            not_after_epoch_micros=VECTOR["command"]["notAfterEpochMicros"],
            key=self.command_key,
        )
        stop_command = verify_recovery_command_v1(
            stop_token, self.identity, self.worker_run_id, self.command_key, self.verify_at)
        observation, worker_status = normalize_native_observation_v1(
            action="stop", native_http_status=200, native_status="stopping")
        self.assertEqual((observation, worker_status), ("run_nonterminal", "cancelling"))

        raw_response = b'{"run_id":"worker-run-recovery-1","status":"stopping"}'
        receipt_token = mint_recovery_receipt_v1(
            command_token=stop_token, command=stop_command,
            observation=observation, worker_status=worker_status,
            native_http_status=200, native_response_body=raw_response,
            observed_at_epoch_micros=VECTOR["receipt"]["observedAtEpochMicros"],
            key=self.receipt_key,
        )
        receipt = verify_recovery_receipt_v1(
            receipt_token, stop_token, self.identity, self.worker_run_id,
            self.command_key, self.receipt_key, self.verify_at)
        self.assertEqual(receipt["workerStatus"], "cancelling")
        self.assertEqual(recovery_disposition_v1(receipt), "nonterminal")
        self.assertTrue(matches_recovery_native_response_v1(receipt, 200, raw_response))
        self.assertFalse(matches_recovery_native_response_v1(
            receipt, 200, b'{"run_id":"worker-run-recovery-1","status":"cancelling"}'))

        self.assertEqual(
            normalize_native_response_v1(
                command=stop_command, native_http_status=200,
                native_response_body=raw_response),
            ("run_nonterminal", "cancelling"),
        )
        for malformed in (
            b'{"run_id":"wrong","status":"stopping"}',
            b'{"run_id":"worker-run-recovery-1","status":"stopping","extra":true}',
            b'{"run_id":"worker-run-recovery-1","run_id":"worker-run-recovery-1",'
            b'"status":"stopping"}',
        ):
            with self.assertRaises(RecoveryProtocolError):
                normalize_native_response_v1(
                    command=stop_command, native_http_status=200,
                    native_response_body=malformed)

        self.assertEqual(
            normalize_native_observation_v1(
                action="stop", native_http_status=202, native_status=None),
            ("stop_accepted", None),
        )
        self.assertEqual(
            normalize_native_observation_v1(
                action="status", native_http_status=404, native_status=None),
            ("not_found", None),
        )
        for invalid in (
            {"action": "status", "native_http_status": 200, "native_status": "stopping-now"},
            {"action": "status", "native_http_status": 202, "native_status": "stopping"},
            {"action": "status", "native_http_status": 200, "native_status": None},
            {"action": "other", "native_http_status": 200, "native_status": "running"},
        ):
            with self.assertRaises(RecoveryProtocolError):
                normalize_native_observation_v1(**invalid)

    def test_worker_boundary_requires_exact_headers_route_query_body_and_window(self):
        token = VECTOR["commandToken"]
        raw_response = json.dumps({
            "object": "hermes.run", "run_id": self.worker_run_id,
            "status": "running", "updated_at": 1.0, "created_at": 1.0,
        }).encode()
        kwargs = {
            "command_header_values": [token],
            "authorization_header_values": ["Bearer native-api-key"],
            "method": "GET",
            "path": f"/v1/runs/{self.worker_run_id}",
            "query_string": "",
            "body": b"",
            "expected_worker_run_id": self.worker_run_id,
            "now_epoch_micros": self.verify_at,
        }
        with patch.dict(os.environ, self._worker_env(), clear=True):
            validate_recovery_runtime_v1(
                native_api_key="native-api-key",
                now_epoch_micros=self.verify_at)
            with self.assertRaises(RecoveryProtocolError):
                validate_recovery_runtime_v1(
                    native_api_key="wrong-native-key",
                    now_epoch_micros=self.verify_at)
            authorization = authorize_recovery_request_v1(**kwargs)
            receipt_token = sign_recovery_response_v1(
                authorization, native_http_status=200,
                native_response_body=raw_response,
                now_epoch_micros=VECTOR["receipt"]["observedAtEpochMicros"],
            )
            self.assertIsNotNone(self._verify_receipt(receipt_token, token))
            for changed in (
                {"command_header_values": []},
                {"command_header_values": [token, token]},
                {"authorization_header_values": []},
                {"authorization_header_values": [
                    "Bearer native-api-key", "Bearer native-api-key"]},
                {"authorization_header_values": ["Bearer wrong"]},
                {"method": "POST"},
                {"path": f"/v1/runs/{self.worker_run_id}/stop"},
                {"query_string": "extra=1"},
                {"body": b"{}"},
                {"expected_worker_run_id": "another-run"},
                {"now_epoch_micros": VECTOR["command"]["notAfterEpochMicros"]},
            ):
                with self.subTest(changed=changed):
                    with self.assertRaises(RecoveryProtocolError):
                        authorize_recovery_request_v1(**{**kwargs, **changed})

            not_found = json.dumps({"error": {
                "message": f"Run not found: {self.worker_run_id}",
                "type": "invalid_request_error", "param": None,
                "code": "run_not_found",
            }}).encode()
            self.assertEqual(
                normalize_native_response_v1(
                    command=authorization.command, native_http_status=404,
                    native_response_body=not_found),
                ("not_found", None),
            )
            wrong_not_found = not_found.replace(
                self.worker_run_id.encode(), b"another-run")
            with self.assertRaises(RecoveryProtocolError):
                normalize_native_response_v1(
                    command=authorization.command, native_http_status=404,
                    native_response_body=wrong_not_found)
        missing_key = self._worker_env()
        missing_key.pop("MERI_PHASE4_RECOVERY_RECEIPT_KEY_B64URL")
        with patch.dict(os.environ, missing_key, clear=True):
            with self.assertRaises(RecoveryProtocolError):
                validate_recovery_runtime_v1(
                    native_api_key="native-api-key",
                    now_epoch_micros=self.verify_at)

    def test_invalid_observation_and_receipt_shape_fail_closed(self):
        command_token = VECTOR["commandToken"]
        command = self._verify_command(command_token)
        common = dict(
            command_token=command_token, command=command,
            native_response_body=b"{}",
            observed_at_epoch_micros=VECTOR["receipt"]["observedAtEpochMicros"],
            key=self.receipt_key,
        )
        invalid = (
            ("run_nonterminal", "completed", 200),
            ("stop_accepted", None, 202),
            ("not_found", None, 200),
            ("run_terminal", "running", 200),
        )
        for observation, status, http in invalid:
            with self.subTest(observation=observation, status=status):
                with self.assertRaises(RecoveryProtocolError):
                    mint_recovery_receipt_v1(
                        observation=observation, worker_status=status,
                        native_http_status=http, **common)

        receipt_claims = _payload(VECTOR["receiptToken"])
        malformed = (
            {**receipt_claims, "extra": True},
            dict(reversed(list(receipt_claims.items()))),
            {**receipt_claims, "keyId": "another-receipt-key"},
            {**receipt_claims, "workerCredentialId": "another-credential"},
            {**receipt_claims, "observation": "run_terminal", "workerStatus": "running"},
            {**receipt_claims, "workerStatus": []},
        )
        for changed in malformed:
            forged = _resign(
                "mhrr1", RECEIPT_DOMAIN,
                json.dumps(changed, separators=(",", ":")), self.receipt_key.secret,
            )
            self.assertIsNone(self._verify_receipt(forged))
        duplicate = json.dumps(receipt_claims, separators=(",", ":")).replace(
            '"observation":', '"observation":"not_found","observation":',
        )
        self.assertIsNone(self._verify_receipt(_resign(
            "mhrr1", RECEIPT_DOMAIN, duplicate, self.receipt_key.secret)))

    def test_wrong_command_and_same_secret_are_rejected(self):
        command = self._verify_command()
        receipt_token = self._mint_vector_receipt(VECTOR["commandToken"], command)
        other_command_token = mint_recovery_command_v1(
            identity=self.identity, worker_run_id=self.worker_run_id, action="status",
            operation_id="88888888-8888-4888-8888-888888888888",
            attempt_nonce=_b64(bytes([34]) * 16), native_body=b"",
            not_before_epoch_micros=VECTOR["command"]["notBeforeEpochMicros"],
            not_after_epoch_micros=VECTOR["command"]["notAfterEpochMicros"],
            key=self.command_key,
        )
        self.assertIsNone(self._verify_receipt(receipt_token, other_command_token))

        reused = replace(self.receipt_key, secret=self.command_key.secret)
        self.assertFalse(recovery_keys_are_distinct(self.command_key, reused))
        self.assertFalse(recovery_keys_are_distinct(
            replace(self.command_key, secret=None), self.receipt_key))
        self.assertIsNone(verify_recovery_command_v1(
            VECTOR["commandToken"], self.identity, self.worker_run_id,
            replace(self.command_key, key_id=None), self.verify_at))
        reused_token = mint_recovery_receipt_v1(
            command_token=VECTOR["commandToken"], command=command,
            observation="run_nonterminal", worker_status="running",
            native_http_status=200,
            native_response_body=_b64decode(VECTOR["receipt"]["nativeResponseBodyBase64url"]),
            observed_at_epoch_micros=VECTOR["receipt"]["observedAtEpochMicros"],
            key=reused,
        )
        self.assertIsNone(self._verify_receipt(
            reused_token, receipt_key=reused))

    def test_uses_only_explicit_times_and_never_process_clock(self):
        with patch.object(time, "time", side_effect=AssertionError("process clock read")):
            command_token = self._mint_vector_command()
            command = self._verify_command(command_token)
            receipt_token = self._mint_vector_receipt(command_token, command)
            self.assertIsNotNone(self._verify_receipt(receipt_token, command_token))


if __name__ == "__main__":
    unittest.main()
