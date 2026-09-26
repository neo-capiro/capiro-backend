"""One-shot internal-network probe for the built reservation recovery endpoint."""
from __future__ import annotations

import base64
import hashlib
import http.client
import json
import os
import time
import urllib.parse

from meri_recovery_receipt_v1 import COMMAND_PURPOSE, RECEIPT_PURPOSE, RecoveryKey
from meri_reservation_recovery_v1 import (
    RESERVATION_NATIVE_PATH,
    matches_reservation_native_response_v1,
    mint_reservation_command_v1,
    verify_reservation_receipt_v1,
)
from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore


def required(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"missing {name}")
    return value


def decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def key(prefix: str, purpose: str, identity: dict[str, str]) -> RecoveryKey:
    return RecoveryKey(
        purpose=purpose, key_id=required(f"{prefix}_KEY_ID"),
        tenant_id=identity["tenantId"],
        worker_audience=identity["workerAudience"],
        worker_ingress_id=identity["workerIngressId"],
        worker_generation=identity["workerGeneration"],
        worker_credential_id=identity["workerCredentialId"],
        secret=decode(required(f"{prefix}_KEY_B64URL")),
        not_before_epoch_micros=required(
            f"{prefix}_KEY_NOT_BEFORE_EPOCH_MICROS"),
        not_after_epoch_micros=required(
            f"{prefix}_KEY_NOT_AFTER_EPOCH_MICROS"),
    )


def send(origin: str, command: str) -> tuple[int, bytes, list[str]]:
    parsed = urllib.parse.urlsplit(origin)
    for attempt in range(120):
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=5)
        try:
            connection.request("POST", RESERVATION_NATIVE_PATH, body=b"", headers={
                "Authorization": f"Bearer {required('API_SERVER_KEY')}",
                "X-Meri-Dispatch-Reservation-Command": command,
                "Content-Length": "0",
            })
            break
        except OSError:
            connection.close()
            if attempt == 119:
                raise
            time.sleep(0.5)
    response = connection.getresponse()
    body = response.read(65_537)
    receipts = response.headers.get_all(
        "X-Meri-Dispatch-Reservation-Receipt", [])
    connection.close()
    if len(body) > 65_536:
        raise RuntimeError("oversize worker response")
    return response.status, body, receipts


def main() -> None:
    now = time.time_ns() // 1000
    identity = {
        "tenantId": required("MERI_PHASE4_TENANT_ID"),
        "runId": "55555555-5555-4555-8555-555555555555",
        "requestSha256": "d" * 64,
        "workerAudience": required("MERI_PHASE4_WORKER_AUDIENCE"),
        "workerIngressId": required("MERI_PHASE4_WORKER_INGRESS_ID"),
        "workerGeneration": required("MERI_PHASE4_WORKER_GENERATION"),
        "workerCredentialId": required("MERI_PHASE4_WORKER_CREDENTIAL_ID"),
        "reconciliationNotAfterEpochMicros": str(now + 40_000_000),
        "retainUntilEpochMicros": str(now + 120_000_000),
    }
    command_key = key(
        "MERI_PHASE4_RECOVERY_COMMAND", COMMAND_PURPOSE, identity)
    receipt_key = key(
        "MERI_PHASE4_RECOVERY_RECEIPT", RECEIPT_PURPOSE, identity)
    command = mint_reservation_command_v1(
        identity=identity, idempotency_key="image-proof-unknown-id",
        delivery_not_before_epoch_micros=str(now - 2_000_000),
        operation_id="77777777-7777-4777-8777-777777777777",
        attempt_nonce="ISEhISEhISEhISEhISEhIQ",
        not_before_epoch_micros=str(now - 500_000),
        not_after_epoch_micros=str(now + 30_000_000), key=command_key,
    )
    origin = required("WORKER_ORIGIN")
    first = send(origin, command)
    second = send(origin, command)
    for status, body, receipts in (first, second):
        if status != 200 or len(receipts) != 1:
            raise RuntimeError(f"unexpected response: {status} {body!r}")
        receipt = verify_reservation_receipt_v1(
            receipts[0], command, identity, command_key, receipt_key,
            str(time.time_ns() // 1000))
        if receipt is None or receipt["outcome"] != "sealed_absent":
            raise RuntimeError("invalid absence receipt")
        if not matches_reservation_native_response_v1(receipt, status, body):
            raise RuntimeError("receipt does not bind exact response")
    if first[1] != second[1]:
        raise RuntimeError("absence replay changed authoritative response bytes")

    reserved_identity = {
        **identity,
        "runId": "66666666-6666-4666-8666-666666666666",
        "requestSha256": "e" * 64,
    }
    reserved_key = "image-proof-reserved-id"
    native_scope = hashlib.sha256(
        f"default\0{required('API_SERVER_KEY')}".encode()).hexdigest()
    store = RunIdempotencyStore("/opt/data/runs_idempotency.db")
    try:
        seeded, _ = store.reserve(
            native_scope, reserved_key, "8" * 64, "worker-run-reserved-proof",
            {"status": "queued"},
            retention_until=int(reserved_identity[
                "retainUntilEpochMicros"]) / 1_000_000,
            dispatch_request_sha256=reserved_identity["requestSha256"])
    finally:
        store.close()
    if seeded != "created":
        raise RuntimeError(f"reservation seed failed: {seeded}")
    reserved_command = mint_reservation_command_v1(
        identity=reserved_identity, idempotency_key=reserved_key,
        delivery_not_before_epoch_micros=str(now - 2_000_000),
        operation_id="88888888-8888-4888-8888-888888888888",
        attempt_nonce="IiIiIiIiIiIiIiIiIiIiIg",
        not_before_epoch_micros=str(now - 500_000),
        not_after_epoch_micros=str(now + 30_000_000), key=command_key)
    reserved_first = send(origin, reserved_command)
    reserved_second = send(origin, reserved_command)
    for status, body, receipts in (reserved_first, reserved_second):
        if status != 200 or len(receipts) != 1:
            raise RuntimeError(f"unexpected reserved response: {status} {body!r}")
        receipt = verify_reservation_receipt_v1(
            receipts[0], reserved_command, reserved_identity,
            command_key, receipt_key, str(time.time_ns() // 1000))
        if (receipt is None or receipt["outcome"] != "reserved"
                or receipt["workerRunId"] != "worker-run-reserved-proof"
                or not matches_reservation_native_response_v1(
                    receipt, status, body)):
            raise RuntimeError("invalid reserved receipt")
    if reserved_first[1] != reserved_second[1]:
        raise RuntimeError("reservation replay changed authoritative response bytes")
    rejected = send(origin, command + "x")
    if rejected[0] != 401 or rejected[2]:
        raise RuntimeError("invalid command was not rejected before receipt")
    print(json.dumps({
        "outcome": "sealed_absent",
        "replayExact": True,
        "reservedOutcome": "reserved",
        "reservedReplayExact": True,
        "invalidCommandStatus": rejected[0],
        "bodySha256": __import__("hashlib").sha256(first[1]).hexdigest(),
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
