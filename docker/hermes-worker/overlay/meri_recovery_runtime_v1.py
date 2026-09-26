"""Worker runtime adapter for the pure Phase 4 recovery v1 contract.

Unlike meri_recovery_receipt_v1, this boundary intentionally reads the worker
environment and wall clock. The clock is sampled once per validation,
authorization, or receipt operation and then passed explicitly into the pure
contract functions.
"""
from __future__ import annotations

import hmac
import os
import time
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from meri_recovery_receipt_v1 import (
    COMMAND_PREFIX,
    COMMAND_PURPOSE,
    MAX_TOKEN_BYTES,
    RECEIPT_PURPOSE,
    RecoveryKey,
    RecoveryProtocolError,
    _binding_from_identity,
    _canonical_b64url,
    _decode_strict_json,
    _decode_token,
    _micros,
    _valid_binding,
    _valid_key,
    matches_recovery_native_request_v1,
    mint_recovery_receipt_v1,
    normalize_native_response_v1,
    recovery_keys_are_distinct,
    verify_recovery_command_v1,
)
from meri_reservation_recovery_v1 import (
    RESERVATION_COMMAND_PREFIX,
    matches_reservation_native_request_v1,
    mint_reservation_receipt_v1,
    verify_reservation_command_v1,
)


RECOVERY_COMMAND_HEADER = "X-Meri-Dispatch-Recovery-Command"
RECOVERY_RECEIPT_HEADER = "X-Meri-Dispatch-Recovery-Receipt"
RESERVATION_COMMAND_HEADER = "X-Meri-Dispatch-Reservation-Command"
RESERVATION_RECEIPT_HEADER = "X-Meri-Dispatch-Reservation-Receipt"


@dataclass(frozen=True)
class RecoveryAuthorization:
    """Verified command plus the separate key used for its receipt."""

    command_token: str
    command: Mapping[str, Any]
    receipt_key: RecoveryKey


@dataclass(frozen=True)
class ReservationAuthorization:
    """Verified unknown-ID command plus its separate receipt key."""

    command_token: str
    command: Mapping[str, Any]
    receipt_key: RecoveryKey


def _worker_wall_clock_epoch_micros() -> str:
    return str(time.time_ns() // 1000)


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not isinstance(value, str) or not value or len(value) > 16384:
        raise RecoveryProtocolError(f"missing or invalid {name}")
    return value


def _route_binding_from_env() -> dict[str, str]:
    binding = {
        "tenantId": _required_env("MERI_PHASE4_TENANT_ID"),
        "workerAudience": _required_env("MERI_PHASE4_WORKER_AUDIENCE"),
        "workerIngressId": _required_env("MERI_PHASE4_WORKER_INGRESS_ID"),
        "workerGeneration": _required_env("MERI_PHASE4_WORKER_GENERATION"),
        "workerCredentialId": _required_env("MERI_PHASE4_WORKER_CREDENTIAL_ID"),
    }
    if not _valid_binding(binding):
        raise RecoveryProtocolError("invalid recovery route binding")
    return binding


def _recovery_key_from_env(
    prefix: str, purpose: str, binding: Mapping[str, Any],
) -> RecoveryKey:
    secret = _canonical_b64url(_required_env(f"{prefix}_KEY_B64URL"))
    if secret is None:
        raise RecoveryProtocolError(f"invalid {prefix}_KEY_B64URL")
    key = RecoveryKey(
        purpose=purpose,
        key_id=_required_env(f"{prefix}_KEY_ID"),
        tenant_id=binding["tenantId"],
        worker_audience=binding["workerAudience"],
        worker_ingress_id=binding["workerIngressId"],
        worker_generation=binding["workerGeneration"],
        worker_credential_id=binding["workerCredentialId"],
        secret=secret,
        not_before_epoch_micros=_required_env(
            f"{prefix}_KEY_NOT_BEFORE_EPOCH_MICROS"),
        not_after_epoch_micros=_required_env(
            f"{prefix}_KEY_NOT_AFTER_EPOCH_MICROS"),
    )
    if not _valid_key(key, binding, purpose):
        raise RecoveryProtocolError(f"invalid {prefix} key")
    return key


def _one_header(values: Sequence[str], name: str) -> str:
    if (not isinstance(values, Sequence) or isinstance(values, (str, bytes))
            or len(values) != 1 or not isinstance(values[0], str)
            or not values[0] or len(values[0]) > MAX_TOKEN_BYTES * 2):
        raise RecoveryProtocolError(f"{name} must occur exactly once")
    return values[0]


def _identity_from_command_token(
    token: str, binding: Mapping[str, Any],
) -> Mapping[str, Any]:
    decoded = _decode_token(token, COMMAND_PREFIX)
    parsed = _decode_strict_json(decoded[1]) if decoded is not None else None
    if parsed is None or not isinstance(parsed[1], dict):
        raise RecoveryProtocolError("invalid recovery command")
    row = parsed[1]
    deadline = row.get("notAfterEpochMicros")
    # The signed command deadline is the worker's self-contained authority
    # horizon. The API binds it to durable identity horizons before accepting
    # a receipt.
    return {
        **binding,
        "runId": row.get("runId"),
        "requestSha256": row.get("requestSha256"),
        "reconciliationNotAfterEpochMicros": deadline,
        "retainUntilEpochMicros": deadline,
    }


def _reservation_identity_from_command_token(
    token: str, binding: Mapping[str, Any],
) -> Mapping[str, Any]:
    decoded = _decode_token(token, RESERVATION_COMMAND_PREFIX)
    parsed = _decode_strict_json(decoded[1]) if decoded is not None else None
    if parsed is None or not isinstance(parsed[1], dict):
        raise RecoveryProtocolError("invalid reservation command")
    row = parsed[1]
    return {
        **binding,
        "runId": row.get("runId"),
        "requestSha256": row.get("requestSha256"),
        "reconciliationNotAfterEpochMicros": row.get(
            "reconciliationNotAfterEpochMicros"),
        "retainUntilEpochMicros": row.get("retainUntilEpochMicros"),
    }


def validate_recovery_runtime_v1(
    *, native_api_key: str,
    now_epoch_micros: str | None = None,
) -> tuple[RecoveryKey, RecoveryKey]:
    """Validate every recovery secret and binding before listener startup."""
    configured_api_key = _required_env("API_SERVER_KEY")
    if (not isinstance(native_api_key, str) or not native_api_key
            or not hmac.compare_digest(native_api_key, configured_api_key)):
        raise RecoveryProtocolError(
            "API_SERVER_KEY does not match the native API server key")
    binding = _route_binding_from_env()
    command_key = _recovery_key_from_env(
        "MERI_PHASE4_RECOVERY_COMMAND", COMMAND_PURPOSE, binding)
    receipt_key = _recovery_key_from_env(
        "MERI_PHASE4_RECOVERY_RECEIPT", RECEIPT_PURPOSE, binding)
    if not recovery_keys_are_distinct(command_key, receipt_key):
        raise RecoveryProtocolError("recovery keys must be distinct")
    now_epoch_micros = (
        now_epoch_micros
        if now_epoch_micros is not None
        else _worker_wall_clock_epoch_micros()
    )
    now = _micros(now_epoch_micros)
    if (now is None
            or not int(command_key.not_before_epoch_micros)
                <= now < int(command_key.not_after_epoch_micros)
            or not int(receipt_key.not_before_epoch_micros)
                <= now < int(receipt_key.not_after_epoch_micros)):
        raise RecoveryProtocolError("recovery keys are not currently valid")
    return command_key, receipt_key


def authorize_recovery_request_v1(
    *, command_header_values: Sequence[str],
    authorization_header_values: Sequence[str], method: str, path: str,
    query_string: str, body: bytes, expected_worker_run_id: str,
    now_epoch_micros: str | None = None,
) -> RecoveryAuthorization:
    """Verify all extra authority before native lookup or Stop effects."""
    command_token = _one_header(command_header_values, RECOVERY_COMMAND_HEADER)
    native_authorization = _one_header(
        authorization_header_values, "Authorization")
    expected_authorization = f"Bearer {_required_env('API_SERVER_KEY')}"
    if not hmac.compare_digest(native_authorization, expected_authorization):
        raise RecoveryProtocolError("invalid native Authorization")
    if query_string != "" or type(body) is not bytes:
        raise RecoveryProtocolError("recovery request target is invalid")
    now_epoch_micros = (
        now_epoch_micros
        if now_epoch_micros is not None
        else _worker_wall_clock_epoch_micros()
    )
    command_key, receipt_key = validate_recovery_runtime_v1(
        native_api_key=native_authorization[len("Bearer "):],
        now_epoch_micros=now_epoch_micros,
    )
    binding = _binding_from_identity({
        "tenantId": command_key.tenant_id,
        "workerAudience": command_key.worker_audience,
        "workerIngressId": command_key.worker_ingress_id,
        "workerGeneration": command_key.worker_generation,
        "workerCredentialId": command_key.worker_credential_id,
    })
    identity = _identity_from_command_token(command_token, binding)
    command = verify_recovery_command_v1(
        command_token, identity, expected_worker_run_id, command_key,
        now_epoch_micros,
    )
    if command is None or not matches_recovery_native_request_v1(
            command, method, path, body):
        raise RecoveryProtocolError("invalid or mismatched recovery command")
    return RecoveryAuthorization(command_token, command, receipt_key)


def sign_recovery_response_v1(
    authorization: RecoveryAuthorization, *, native_http_status: int,
    native_response_body: bytes, now_epoch_micros: str | None = None,
) -> str:
    """Strictly interpret and sign exact bytes at worker wall-clock time."""
    if not isinstance(authorization, RecoveryAuthorization):
        raise RecoveryProtocolError("invalid recovery authorization")
    now_epoch_micros = (
        now_epoch_micros
        if now_epoch_micros is not None
        else _worker_wall_clock_epoch_micros()
    )
    observation, worker_status = normalize_native_response_v1(
        command=authorization.command,
        native_http_status=native_http_status,
        native_response_body=native_response_body,
    )
    return mint_recovery_receipt_v1(
        command_token=authorization.command_token,
        command=authorization.command,
        observation=observation,
        worker_status=worker_status,
        native_http_status=native_http_status,
        native_response_body=native_response_body,
        observed_at_epoch_micros=now_epoch_micros,
        key=authorization.receipt_key,
    )


def authorize_reservation_request_v1(
    *, command_header_values: Sequence[str],
    authorization_header_values: Sequence[str], method: str, path: str,
    query_string: str, body: bytes,
    now_epoch_micros: str | None = None,
) -> ReservationAuthorization:
    """Verify an unknown-ID command before any native reservation lookup."""
    command_token = _one_header(
        command_header_values, RESERVATION_COMMAND_HEADER)
    native_authorization = _one_header(
        authorization_header_values, "Authorization")
    expected_authorization = f"Bearer {_required_env('API_SERVER_KEY')}"
    if not hmac.compare_digest(native_authorization, expected_authorization):
        raise RecoveryProtocolError("invalid native Authorization")
    if query_string != "" or type(body) is not bytes:
        raise RecoveryProtocolError("reservation request target is invalid")
    now_epoch_micros = (
        now_epoch_micros
        if now_epoch_micros is not None
        else _worker_wall_clock_epoch_micros()
    )
    command_key, receipt_key = validate_recovery_runtime_v1(
        native_api_key=native_authorization[len("Bearer "):],
        now_epoch_micros=now_epoch_micros,
    )
    binding = _binding_from_identity({
        "tenantId": command_key.tenant_id,
        "workerAudience": command_key.worker_audience,
        "workerIngressId": command_key.worker_ingress_id,
        "workerGeneration": command_key.worker_generation,
        "workerCredentialId": command_key.worker_credential_id,
    })
    identity = _reservation_identity_from_command_token(command_token, binding)
    command = verify_reservation_command_v1(
        command_token, identity, command_key, now_epoch_micros)
    if command is None or not matches_reservation_native_request_v1(
            command, method, path, query_string, body):
        raise RecoveryProtocolError("invalid or mismatched reservation command")
    return ReservationAuthorization(command_token, command, receipt_key)


def sign_reservation_response_v1(
    authorization: ReservationAuthorization, *, native_http_status: int,
    native_response_body: bytes, now_epoch_micros: str | None = None,
) -> str:
    """Sign exact authoritative reservation/seal response bytes."""
    if not isinstance(authorization, ReservationAuthorization):
        raise RecoveryProtocolError("invalid reservation authorization")
    now_epoch_micros = (
        now_epoch_micros
        if now_epoch_micros is not None
        else _worker_wall_clock_epoch_micros()
    )
    return mint_reservation_receipt_v1(
        command_token=authorization.command_token,
        command=authorization.command,
        native_http_status=native_http_status,
        native_response_body=native_response_body,
        observed_at_epoch_micros=now_epoch_micros,
        key=authorization.receipt_key,
    )
