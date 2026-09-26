"""Hermetic unknown-worker reservation lookup/absence-seal protocol tests."""
from __future__ import annotations

import base64
import json
import os
import pathlib
import unittest
from dataclasses import replace
from unittest.mock import patch

from meri_recovery_receipt_v1 import RecoveryKey, RecoveryProtocolError
from meri_recovery_runtime_v1 import (
    authorize_reservation_request_v1,
    sign_reservation_response_v1,
)
from meri_reservation_recovery_v1 import (
    RESERVATION_NATIVE_PATH,
    matches_reservation_native_request_v1,
    matches_reservation_native_response_v1,
    mint_reservation_command_v1,
    mint_reservation_receipt_v1,
    reservation_response_bytes_v1,
    verify_reservation_command_v1,
    verify_reservation_receipt_v1,
)


ROOT = pathlib.Path(__file__).parent
VECTOR = json.loads((ROOT / "recovery-receipt-vectors.json").read_text(encoding="utf-8"))
RESERVATION_VECTOR = json.loads(
    (ROOT / "reservation-recovery-vectors.json").read_text(encoding="utf-8"))
DELIVERY = "1790366290000000"
COMMAND_BEFORE = "1790366300000000"
COMMAND_AFTER = "1790366350000000"
AUTH_NOW = "1790366320000000"
OBSERVED = "1790366330000000"
VERIFY_NOW = "1790366340000000"
IDEMPOTENCY_KEY = "phase4-dispatch-55555555"
OPERATION_ID = "77777777-7777-4777-8777-777777777777"
ATTEMPT_NONCE = "ISEhISEhISEhISEhISEhIQ"


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _key(row: dict) -> RecoveryKey:
    return RecoveryKey(
        purpose=row["purpose"], key_id=row["keyId"],
        tenant_id=row["tenantId"], worker_audience=row["workerAudience"],
        worker_ingress_id=row["workerIngressId"],
        worker_generation=row["workerGeneration"],
        worker_credential_id=row["workerCredentialId"],
        secret=_decode(row["secretBase64url"]),
        not_before_epoch_micros=row["notBeforeEpochMicros"],
        not_after_epoch_micros=row["notAfterEpochMicros"],
    )


class ReservationRecoveryV1Test(unittest.TestCase):
    def setUp(self) -> None:
        self.identity = VECTOR["identity"]
        self.command_key = _key(VECTOR["commandKey"])
        self.receipt_key = _key(VECTOR["receiptKey"])

    def _command(self) -> str:
        return mint_reservation_command_v1(
            identity=self.identity, idempotency_key=IDEMPOTENCY_KEY,
            delivery_not_before_epoch_micros=DELIVERY,
            operation_id=OPERATION_ID, attempt_nonce=ATTEMPT_NONCE,
            not_before_epoch_micros=COMMAND_BEFORE,
            not_after_epoch_micros=COMMAND_AFTER, key=self.command_key,
        )

    def _verified_command(self):
        return verify_reservation_command_v1(
            self._command(), self.identity, self.command_key, AUTH_NOW)

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
        for prefix, row in (
            ("MERI_PHASE4_RECOVERY_COMMAND", VECTOR["commandKey"]),
            ("MERI_PHASE4_RECOVERY_RECEIPT", VECTOR["receiptKey"]),
        ):
            result.update({
                f"{prefix}_KEY_ID": row["keyId"],
                f"{prefix}_KEY_B64URL": row["secretBase64url"],
                f"{prefix}_KEY_NOT_BEFORE_EPOCH_MICROS": row["notBeforeEpochMicros"],
                f"{prefix}_KEY_NOT_AFTER_EPOCH_MICROS": row["notAfterEpochMicros"],
            })
        return result

    def test_command_binds_identity_route_key_cutoff_horizon_and_empty_request(self):
        token = self._command()
        command = self._verified_command()
        self.assertIsNotNone(command)
        self.assertEqual(command["requestSha256"], self.identity["requestSha256"])
        self.assertEqual(command["idempotencyKey"], IDEMPOTENCY_KEY)
        self.assertEqual(command["deliveryNotBeforeEpochMicros"], DELIVERY)
        self.assertEqual(
            command["retainUntilEpochMicros"], self.identity["retainUntilEpochMicros"])
        self.assertTrue(matches_reservation_native_request_v1(
            command, "POST", RESERVATION_NATIVE_PATH, "", b""))
        for method, path, query, body in (
            ("GET", RESERVATION_NATIVE_PATH, "", b""),
            ("POST", RESERVATION_NATIVE_PATH + "/", "", b""),
            ("POST", RESERVATION_NATIVE_PATH, "x=1", b""),
            ("POST", RESERVATION_NATIVE_PATH, "", b"{}"),
        ):
            self.assertFalse(matches_reservation_native_request_v1(
                command, method, path, query, body))
        self.assertIsNone(verify_reservation_command_v1(
            token, {**self.identity, "requestSha256": "0" * 64},
            self.command_key, AUTH_NOW))

    def test_command_windows_are_exclusive_and_start_after_delivery_cutoff(self):
        self.assertIsNone(verify_reservation_command_v1(
            self._command(), self.identity, self.command_key, COMMAND_AFTER))
        with self.assertRaisesRegex(RecoveryProtocolError, "command window"):
            mint_reservation_command_v1(
                identity=self.identity, idempotency_key=IDEMPOTENCY_KEY,
                delivery_not_before_epoch_micros=COMMAND_BEFORE,
                operation_id=OPERATION_ID, attempt_nonce=ATTEMPT_NONCE,
                not_before_epoch_micros=str(int(COMMAND_BEFORE) - 1),
                not_after_epoch_micros=COMMAND_AFTER, key=self.command_key)
        with self.assertRaisesRegex(RecoveryProtocolError, "command material"):
            mint_reservation_command_v1(
                identity=self.identity, idempotency_key=" key ",
                delivery_not_before_epoch_micros=DELIVERY,
                operation_id=OPERATION_ID, attempt_nonce=ATTEMPT_NONCE,
                not_before_epoch_micros=COMMAND_BEFORE,
                not_after_epoch_micros=COMMAND_AFTER, key=self.command_key)

    def test_reserved_receipt_binds_exact_response_and_distinct_key(self):
        command_token = self._command()
        command = self._verified_command()
        body = reservation_response_bytes_v1(
            "reserved", {"run_id": "worker-run-1", "status": {"status": "running"}})
        receipt_token = mint_reservation_receipt_v1(
            command_token=command_token, command=command,
            native_http_status=200, native_response_body=body,
            observed_at_epoch_micros=OBSERVED, key=self.receipt_key)
        receipt = verify_reservation_receipt_v1(
            receipt_token, command_token, self.identity,
            self.command_key, self.receipt_key, VERIFY_NOW)
        self.assertEqual(receipt["outcome"], "reserved")
        self.assertEqual(receipt["workerRunId"], "worker-run-1")
        self.assertTrue(matches_reservation_native_response_v1(receipt, 200, body))
        self.assertFalse(matches_reservation_native_response_v1(
            receipt, 200, body + b" "))
        same_secret = replace(self.receipt_key, secret=self.command_key.secret)
        self.assertIsNone(verify_reservation_receipt_v1(
            receipt_token, command_token, self.identity,
            self.command_key, same_secret, VERIFY_NOW))

    def test_matches_checked_in_typescript_command_receipt_and_response_vector(self):
        command_token = self._command()
        command = self._verified_command()
        body = reservation_response_bytes_v1(
            "reserved", {"run_id": "worker-run-1", "status": {"status": "running"}})
        receipt_token = mint_reservation_receipt_v1(
            command_token=command_token, command=command,
            native_http_status=200, native_response_body=body,
            observed_at_epoch_micros=OBSERVED, key=self.receipt_key)
        self.assertEqual(command_token, RESERVATION_VECTOR["commandToken"])
        self.assertEqual(receipt_token, RESERVATION_VECTOR["receiptToken"])
        self.assertEqual(
            base64.urlsafe_b64encode(body).rstrip(b"=").decode("ascii"),
            RESERVATION_VECTOR["nativeResponseBodyBase64url"])

    def test_sealed_absent_receipt_is_not_a_plain_miss(self):
        command_token = self._command()
        command = self._verified_command()
        sealed_seconds = int(COMMAND_BEFORE) / 1_000_000 + 1
        retain_seconds = int(self.identity["retainUntilEpochMicros"]) / 1_000_000
        body = reservation_response_bytes_v1(
            "sealed_absent", {
                "dispatch_request_sha256": self.identity["requestSha256"],
                "sealed_at": sealed_seconds,
                "retention_until": retain_seconds,
            }, retain_until_epoch_micros=self.identity["retainUntilEpochMicros"])
        receipt_token = mint_reservation_receipt_v1(
            command_token=command_token, command=command,
            native_http_status=200, native_response_body=body,
            observed_at_epoch_micros=OBSERVED, key=self.receipt_key)
        receipt = verify_reservation_receipt_v1(
            receipt_token, command_token, self.identity,
            self.command_key, self.receipt_key, VERIFY_NOW)
        self.assertEqual(receipt["outcome"], "sealed_absent")
        self.assertIsNone(receipt["workerRunId"])
        self.assertGreaterEqual(
            int(receipt["sealedAtEpochMicros"]), int(DELIVERY))
        with self.assertRaisesRegex(RecoveryProtocolError, "outcome"):
            reservation_response_bytes_v1("missing", {})

    def test_worker_runtime_requires_exact_headers_native_auth_target_and_body(self):
        token = self._command()
        with patch.dict(os.environ, self._worker_env(), clear=True):
            authorization = authorize_reservation_request_v1(
                command_header_values=[token],
                authorization_header_values=["Bearer native-api-key"],
                method="POST", path=RESERVATION_NATIVE_PATH,
                query_string="", body=b"", now_epoch_micros=AUTH_NOW)
            body = reservation_response_bytes_v1(
                "reserved", {"run_id": "worker-run-1", "status": {"status": "queued"}})
            receipt = sign_reservation_response_v1(
                authorization, native_http_status=200,
                native_response_body=body, now_epoch_micros=OBSERVED)
            self.assertIsNotNone(verify_reservation_receipt_v1(
                receipt, token, self.identity, self.command_key,
                self.receipt_key, VERIFY_NOW))
            for commands, auth, method, path, query, request_body in (
                ([], ["Bearer native-api-key"], "POST", RESERVATION_NATIVE_PATH, "", b""),
                ([token, token], ["Bearer native-api-key"], "POST", RESERVATION_NATIVE_PATH, "", b""),
                ([token], ["Bearer wrong"], "POST", RESERVATION_NATIVE_PATH, "", b""),
                ([token], ["Bearer native-api-key"], "GET", RESERVATION_NATIVE_PATH, "", b""),
                ([token], ["Bearer native-api-key"], "POST", RESERVATION_NATIVE_PATH, "x=1", b""),
                ([token], ["Bearer native-api-key"], "POST", RESERVATION_NATIVE_PATH, "", b"{}"),
            ):
                with self.assertRaises(RecoveryProtocolError):
                    authorize_reservation_request_v1(
                        command_header_values=commands,
                        authorization_header_values=auth,
                        method=method, path=path, query_string=query,
                        body=request_body, now_epoch_micros=AUTH_NOW)


if __name__ == "__main__":
    unittest.main()
