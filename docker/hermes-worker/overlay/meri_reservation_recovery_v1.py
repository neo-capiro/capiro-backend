"""Pure Phase 4 unknown-worker reservation lookup/absence-seal protocol v1.

This module reads no environment or clock and performs no I/O.  Its command
and receipt use domains distinct from known-worker status/Stop recovery.  A
valid ``sealed_absent`` receipt means the worker installed a native late-POST
tombstone; a plain lookup miss is never represented by this protocol.
"""
from __future__ import annotations

import hashlib
import hmac
from types import MappingProxyType
from typing import Any, Mapping

from meri_recovery_receipt_v1 import (
    COMMAND_PURPOSE,
    MAX_COMMAND_TTL_MICROS,
    RECEIPT_PURPOSE,
    RecoveryKey,
    RecoveryProtocolError,
    _ATTEMPT_NONCE,
    _KEY_ID,
    _SHA256,
    _UUID,
    _binding_from_identity,
    _canonical_json,
    _decode_strict_json,
    _decode_token,
    _encode_token,
    _micros,
    _sha256,
    _sign,
    _valid_attempt_nonce,
    _valid_identity,
    _valid_key,
    recovery_keys_are_distinct,
)


VERSION = 1
RESERVATION_COMMAND_PURPOSE = "meri-hermes-reservation-command"
RESERVATION_RECEIPT_PURPOSE = "meri-hermes-reservation-receipt"
RESERVATION_COMMAND_PREFIX = "mhrqc1"
RESERVATION_RECEIPT_PREFIX = "mhrqr1"
RESERVATION_COMMAND_DOMAIN = b"capiro.meri.phase4.reservation-command/v1\0"
RESERVATION_RECEIPT_DOMAIN = b"capiro.meri.phase4.reservation-receipt/v1\0"
RESERVATION_NATIVE_PATH = "/v1/meri/phase4/reservations/lookup-or-seal"
_EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
_NONTERMINAL = frozenset({
    "queued", "provisioning", "running", "waiting_for_approval",
    "waiting_for_clarification", "cancelling",
})
_TERMINAL = frozenset({"completed", "cancelled", "failed", "interrupted", "expired"})


def _valid_idempotency_key(value: Any) -> bool:
    return (isinstance(value, str) and 1 <= len(value) <= 255
            and value.strip() == value
            and all(33 <= ord(char) <= 126 for char in value))


def _command_claims(
    identity: Mapping[str, Any], idempotency_key: str,
    delivery_not_before_epoch_micros: str, operation_id: str,
    attempt_nonce: str, not_before_epoch_micros: str,
    not_after_epoch_micros: str, key_id: str,
) -> dict[str, Any]:
    return {
        "version": VERSION,
        "purpose": RESERVATION_COMMAND_PURPOSE,
        "keyId": key_id,
        "tenantId": identity["tenantId"],
        "runId": identity["runId"],
        "requestSha256": identity["requestSha256"],
        "workerAudience": identity["workerAudience"],
        "workerIngressId": identity["workerIngressId"],
        "workerGeneration": identity["workerGeneration"],
        "workerCredentialId": identity["workerCredentialId"],
        "idempotencyKey": idempotency_key,
        "deliveryNotBeforeEpochMicros": delivery_not_before_epoch_micros,
        "reconciliationNotAfterEpochMicros": identity[
            "reconciliationNotAfterEpochMicros"],
        "retainUntilEpochMicros": identity["retainUntilEpochMicros"],
        "operationId": operation_id,
        "attemptNonce": attempt_nonce,
        "nativeMethod": "POST",
        "nativePath": RESERVATION_NATIVE_PATH,
        "nativeBodySha256": _EMPTY_SHA256,
        "notBeforeEpochMicros": not_before_epoch_micros,
        "notAfterEpochMicros": not_after_epoch_micros,
    }


def _command_window_valid(
    claims: Mapping[str, Any], identity: Mapping[str, Any], key: RecoveryKey,
    now_epoch_micros: str,
) -> bool:
    before = _micros(claims.get("notBeforeEpochMicros"))
    after = _micros(claims.get("notAfterEpochMicros"))
    now = _micros(now_epoch_micros)
    delivery = _micros(claims.get("deliveryNotBeforeEpochMicros"))
    reconcile = _micros(identity.get("reconciliationNotAfterEpochMicros"))
    retain = _micros(identity.get("retainUntilEpochMicros"))
    key_before = _micros(key.not_before_epoch_micros)
    key_after = _micros(key.not_after_epoch_micros)
    return (
        all(value is not None for value in (
            before, after, now, delivery, reconcile, retain,
            key_before, key_after))
        and delivery < reconcile <= retain
        and delivery <= before <= now < after <= reconcile
        and after - before <= MAX_COMMAND_TTL_MICROS
        and key_before <= before and after <= key_after
    )


def mint_reservation_command_v1(
    *, identity: Mapping[str, Any], idempotency_key: str,
    delivery_not_before_epoch_micros: str, operation_id: str,
    attempt_nonce: str, not_before_epoch_micros: str,
    not_after_epoch_micros: str, key: RecoveryKey,
) -> str:
    binding = _binding_from_identity(identity) if isinstance(identity, Mapping) else {}
    if (not _valid_identity(identity) or not _valid_idempotency_key(idempotency_key)
            or _micros(delivery_not_before_epoch_micros) is None
            or not isinstance(operation_id, str) or _UUID.fullmatch(operation_id) is None
            or not _valid_attempt_nonce(attempt_nonce)
            or not _valid_key(key, binding, COMMAND_PURPOSE)):
        raise RecoveryProtocolError("invalid Phase 4 reservation command material")
    claims = _command_claims(
        identity, idempotency_key, delivery_not_before_epoch_micros,
        operation_id, attempt_nonce, not_before_epoch_micros,
        not_after_epoch_micros, key.key_id,
    )
    if not _command_window_valid(claims, identity, key, not_before_epoch_micros):
        raise RecoveryProtocolError("invalid Phase 4 reservation command window")
    return _encode_token(
        RESERVATION_COMMAND_PREFIX, RESERVATION_COMMAND_DOMAIN, claims, key.secret)


def verify_reservation_command_v1(
    token: Any, identity: Mapping[str, Any], key: RecoveryKey,
    now_epoch_micros: str,
) -> Mapping[str, Any] | None:
    binding = _binding_from_identity(identity) if isinstance(identity, Mapping) else {}
    if (not _valid_identity(identity)
            or not _valid_key(key, binding, COMMAND_PURPOSE)):
        return None
    decoded = _decode_token(token, RESERVATION_COMMAND_PREFIX)
    if decoded is None:
        return None
    encoded, payload, presented = decoded
    parsed = _decode_strict_json(payload)
    if parsed is None or not isinstance(parsed[1], dict):
        return None
    text, row = parsed
    if (row.get("version") != VERSION
            or row.get("purpose") != RESERVATION_COMMAND_PURPOSE
            or not isinstance(row.get("keyId"), str)
            or _KEY_ID.fullmatch(row["keyId"]) is None
            or not _valid_idempotency_key(row.get("idempotencyKey"))
            or _micros(row.get("deliveryNotBeforeEpochMicros")) is None
            or not isinstance(row.get("operationId"), str)
            or _UUID.fullmatch(row["operationId"]) is None
            or not _valid_attempt_nonce(row.get("attemptNonce"))
            or row.get("nativeMethod") != "POST"
            or row.get("nativePath") != RESERVATION_NATIVE_PATH
            or row.get("nativeBodySha256") != _EMPTY_SHA256):
        return None
    expected = _command_claims(
        identity, row["idempotencyKey"], row["deliveryNotBeforeEpochMicros"],
        row["operationId"], row["attemptNonce"],
        row.get("notBeforeEpochMicros"), row.get("notAfterEpochMicros"),
        key.key_id,
    )
    if (text != _canonical_json(expected)
            or not _command_window_valid(expected, identity, key, now_epoch_micros)):
        return None
    expected_signature = _sign(
        RESERVATION_COMMAND_PREFIX, RESERVATION_COMMAND_DOMAIN,
        encoded, key.secret)
    if not hmac.compare_digest(presented, expected_signature):
        return None
    return MappingProxyType(expected)


def matches_reservation_native_request_v1(
    command: Mapping[str, Any], method: Any, path: Any,
    query_string: Any, body: bytes,
) -> bool:
    return (
        isinstance(command, Mapping) and method == "POST"
        and path == RESERVATION_NATIVE_PATH and query_string == ""
        and type(body) is bytes and body == b""
        and command.get("nativeMethod") == method
        and command.get("nativePath") == path
        and command.get("nativeBodySha256") == _EMPTY_SHA256
    )


def reservation_response_bytes_v1(
    outcome: str, record: Mapping[str, Any], *,
    retain_until_epoch_micros: str | None = None,
) -> bytes:
    if outcome == "reserved":
        run_id = record.get("run_id")
        status_row = record.get("status")
        status = status_row.get("status") if isinstance(status_row, Mapping) else None
        status = "cancelling" if status == "stopping" else status
        if (not isinstance(run_id, str) or not run_id
                or status not in _NONTERMINAL | _TERMINAL):
            raise RecoveryProtocolError("invalid reserved response")
        row = {"outcome": "reserved", "workerRunId": run_id, "workerStatus": status}
    elif outcome == "sealed_absent":
        digest = record.get("dispatch_request_sha256")
        sealed_at = record.get("sealed_at")
        retain_until = record.get("retention_until")
        exact_retain = _micros(retain_until_epoch_micros)
        if (not isinstance(digest, str) or _SHA256.fullmatch(digest) is None
                or not isinstance(sealed_at, (int, float))
                or not isinstance(retain_until, (int, float))
                or exact_retain is None or sealed_at <= 0
                or retain_until <= sealed_at
                or abs(retain_until * 1_000_000 - exact_retain) > 1):
            raise RecoveryProtocolError("invalid absence response")
        row = {
            "outcome": "sealed_absent",
            "sealedAtEpochMicros": str(int(sealed_at * 1_000_000)),
            "retainUntilEpochMicros": retain_until_epoch_micros,
        }
    else:
        raise RecoveryProtocolError("invalid reservation outcome")
    return _canonical_json(row).encode("utf-8")


def normalize_reservation_response_v1(
    command: Mapping[str, Any], native_http_status: int,
    native_response_body: bytes,
) -> tuple[str, str | None, str | None, str | None]:
    if (not isinstance(command, Mapping) or native_http_status != 200
            or type(native_response_body) is not bytes):
        raise RecoveryProtocolError("invalid native reservation response")
    parsed = _decode_strict_json(native_response_body)
    if parsed is None or not isinstance(parsed[1], dict):
        raise RecoveryProtocolError("invalid native reservation response")
    text, row = parsed
    if row.get("outcome") == "reserved":
        if (set(row) != {"outcome", "workerRunId", "workerStatus"}
                or not isinstance(row.get("workerRunId"), str)
                or not row["workerRunId"]
                or row.get("workerStatus") not in _NONTERMINAL | _TERMINAL
                or text != _canonical_json(row)):
            raise RecoveryProtocolError("invalid reserved response")
        return "reserved", row["workerRunId"], row["workerStatus"], None
    if row.get("outcome") == "sealed_absent":
        sealed = _micros(row.get("sealedAtEpochMicros"))
        retain = _micros(row.get("retainUntilEpochMicros"))
        command_retain = _micros(command.get("retainUntilEpochMicros"))
        delivery = _micros(command.get("deliveryNotBeforeEpochMicros"))
        if (set(row) != {"outcome", "sealedAtEpochMicros", "retainUntilEpochMicros"}
                or sealed is None or retain is None or command_retain is None
                or delivery is None or sealed < delivery or sealed >= retain
                or retain != command_retain
                or text != _canonical_json(row)):
            raise RecoveryProtocolError("invalid absence response")
        return "sealed_absent", None, None, row["sealedAtEpochMicros"]
    raise RecoveryProtocolError("invalid reservation outcome")


def _receipt_claims(
    command: Mapping[str, Any], command_sha256: str, outcome: str,
    worker_run_id: str | None, worker_status: str | None,
    sealed_at_epoch_micros: str | None, native_http_status: int,
    response_sha256: str, observed_at_epoch_micros: str, key_id: str,
) -> dict[str, Any]:
    return {
        "version": VERSION,
        "purpose": RESERVATION_RECEIPT_PURPOSE,
        "keyId": key_id,
        "tenantId": command["tenantId"],
        "runId": command["runId"],
        "requestSha256": command["requestSha256"],
        "workerAudience": command["workerAudience"],
        "workerIngressId": command["workerIngressId"],
        "workerGeneration": command["workerGeneration"],
        "workerCredentialId": command["workerCredentialId"],
        "idempotencyKey": command["idempotencyKey"],
        "deliveryNotBeforeEpochMicros": command["deliveryNotBeforeEpochMicros"],
        "retainUntilEpochMicros": command["retainUntilEpochMicros"],
        "operationId": command["operationId"],
        "attemptNonce": command["attemptNonce"],
        "commandSha256": command_sha256,
        "nativeMethod": command["nativeMethod"],
        "nativePath": command["nativePath"],
        "nativeBodySha256": command["nativeBodySha256"],
        "nativeHttpStatus": native_http_status,
        "nativeResponseBodySha256": response_sha256,
        "outcome": outcome,
        "workerRunId": worker_run_id,
        "workerStatus": worker_status,
        "sealedAtEpochMicros": sealed_at_epoch_micros,
        "observedAtEpochMicros": observed_at_epoch_micros,
        "notBeforeEpochMicros": command["notBeforeEpochMicros"],
        "notAfterEpochMicros": command["notAfterEpochMicros"],
    }


def mint_reservation_receipt_v1(
    *, command_token: str, command: Mapping[str, Any],
    native_http_status: int, native_response_body: bytes,
    observed_at_epoch_micros: str, key: RecoveryKey,
) -> str:
    decoded = _decode_token(command_token, RESERVATION_COMMAND_PREFIX)
    binding = _binding_from_identity(command) if isinstance(command, Mapping) else {}
    if (decoded is None or not isinstance(command_token, str)
            or not _valid_key(key, binding, RECEIPT_PURPOSE)):
        raise RecoveryProtocolError("invalid Phase 4 reservation receipt material")
    try:
        payload_matches = (
            decoded[1].decode("utf-8", errors="strict") == _canonical_json(command))
    except UnicodeDecodeError:
        payload_matches = False
    if not payload_matches:
        raise RecoveryProtocolError("invalid Phase 4 reservation receipt material")
    outcome, worker_run_id, worker_status, sealed_at = (
        normalize_reservation_response_v1(
            command, native_http_status, native_response_body))
    observed = _micros(observed_at_epoch_micros)
    before = _micros(command.get("notBeforeEpochMicros"))
    after = _micros(command.get("notAfterEpochMicros"))
    key_before = _micros(key.not_before_epoch_micros)
    key_after = _micros(key.not_after_epoch_micros)
    if (observed is None or before is None or after is None
            or key_before is None or key_after is None
            or not key_before <= before <= observed < after <= key_after):
        raise RecoveryProtocolError("invalid Phase 4 reservation receipt window")
    if (outcome == "sealed_absent" and sealed_at is not None
            and int(sealed_at) > observed):
        raise RecoveryProtocolError("invalid Phase 4 reservation receipt window")
    claims = _receipt_claims(
        command, _sha256(command_token.encode("ascii")), outcome,
        worker_run_id, worker_status, sealed_at, native_http_status,
        _sha256(native_response_body), observed_at_epoch_micros, key.key_id,
    )
    return _encode_token(
        RESERVATION_RECEIPT_PREFIX, RESERVATION_RECEIPT_DOMAIN,
        claims, key.secret)


def verify_reservation_receipt_v1(
    token: Any, command_token: Any, identity: Mapping[str, Any],
    command_key: RecoveryKey, receipt_key: RecoveryKey,
    now_epoch_micros: str,
) -> Mapping[str, Any] | None:
    if not recovery_keys_are_distinct(command_key, receipt_key):
        return None
    command = verify_reservation_command_v1(
        command_token, identity, command_key, now_epoch_micros)
    binding = _binding_from_identity(identity) if isinstance(identity, Mapping) else {}
    if (command is None or not isinstance(command_token, str)
            or not _valid_key(receipt_key, binding, RECEIPT_PURPOSE)):
        return None
    decoded = _decode_token(token, RESERVATION_RECEIPT_PREFIX)
    if decoded is None:
        return None
    encoded, payload, presented = decoded
    parsed = _decode_strict_json(payload)
    if parsed is None or not isinstance(parsed[1], dict):
        return None
    text, row = parsed
    outcome = row.get("outcome")
    worker_run_id = row.get("workerRunId")
    worker_status = row.get("workerStatus")
    sealed_at = row.get("sealedAtEpochMicros")
    if not ((outcome == "reserved" and isinstance(worker_run_id, str)
             and worker_run_id and worker_status in _NONTERMINAL | _TERMINAL
             and sealed_at is None and row.get("nativeHttpStatus") == 200)
            or (outcome == "sealed_absent" and worker_run_id is None
                and worker_status is None and _micros(sealed_at) is not None
                and row.get("nativeHttpStatus") == 200)):
        return None
    response_sha = row.get("nativeResponseBodySha256")
    observed_at = row.get("observedAtEpochMicros")
    if (not isinstance(response_sha, str) or _SHA256.fullmatch(response_sha) is None
            or _micros(observed_at) is None):
        return None
    expected = _receipt_claims(
        command, _sha256(command_token.encode("ascii")), outcome,
        worker_run_id, worker_status, sealed_at, row.get("nativeHttpStatus"),
        response_sha, observed_at, receipt_key.key_id,
    )
    observed = _micros(observed_at)
    now = _micros(now_epoch_micros)
    key_before = _micros(receipt_key.not_before_epoch_micros)
    key_after = _micros(receipt_key.not_after_epoch_micros)
    if (text != _canonical_json(expected) or observed is None or now is None
            or key_before is None or key_after is None
            or observed > now
            or observed < int(command["notBeforeEpochMicros"])
            or observed >= int(command["notAfterEpochMicros"])
            or int(command["notBeforeEpochMicros"]) < key_before
            or int(command["notAfterEpochMicros"]) > key_after):
        return None
    if (outcome == "sealed_absent"
            and not int(command["deliveryNotBeforeEpochMicros"])
                <= int(sealed_at) <= observed):
        return None
    expected_signature = _sign(
        RESERVATION_RECEIPT_PREFIX, RESERVATION_RECEIPT_DOMAIN,
        encoded, receipt_key.secret)
    if not hmac.compare_digest(presented, expected_signature):
        return None
    return MappingProxyType(expected)


def matches_reservation_native_response_v1(
    receipt: Mapping[str, Any], http_status: Any, body: bytes,
) -> bool:
    return (
        type(http_status) is int and type(body) is bytes
        and http_status == receipt.get("nativeHttpStatus")
        and _sha256(body) == receipt.get("nativeResponseBodySha256")
    )
