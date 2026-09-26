"""Dormant Phase 4 authenticated status/Stop recovery protocol v1.

This module is the Python peer of
``apps/api/src/meri/hermes/meri-hermes-dispatch-recovery.contract.ts``.  It is
pure contract code: it loads no environment, reads no process clock, registers
no route, and performs no network or native worker action.

A valid command authorizes only the exact native method/path/body it signs.  A
receipt authenticates one normalized worker observation; it is not launch or
effect authority.  ``not_found`` and a missing/transport-failed receipt remain
UNKNOWN, and ``stop_accepted`` is deliberately nonterminal.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import re
import urllib.parse
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Mapping


VERSION = 1
COMMAND_PURPOSE = "meri-hermes-recovery-command"
RECEIPT_PURPOSE = "meri-hermes-recovery-receipt"
COMMAND_PREFIX = "mhrc1"
RECEIPT_PREFIX = "mhrr1"
COMMAND_DOMAIN = b"capiro.meri.phase4.recovery-command/v1\0"
RECEIPT_DOMAIN = b"capiro.meri.phase4.recovery-receipt/v1\0"
MAX_TOKEN_BYTES = 8192
MAX_SIGNED_INT64 = 9_223_372_036_854_775_807
MAX_COMMAND_TTL_MICROS = 60_000_000

_POSITIVE_MICROS = re.compile(r"^[1-9][0-9]{0,18}$")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_KEY_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_ROUTE_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$")
_WORKER_RUN_ID = re.compile(r"^[\x21-\x7e]{1,120}$")
_BASE64URL = re.compile(r"^[A-Za-z0-9_-]+$")
_ATTEMPT_NONCE = re.compile(r"^[A-Za-z0-9_-]{22}$")
_EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
_NONTERMINAL = frozenset({
    "queued", "provisioning", "running", "waiting_for_approval",
    "waiting_for_clarification", "cancelling",
})
_TERMINAL = frozenset({"completed", "cancelled", "failed", "interrupted", "expired"})


class RecoveryProtocolError(ValueError):
    """Invalid local minting material; wire verification returns ``None``."""


@dataclass(frozen=True)
class RecoveryKey:
    """One purpose- and route-bound HMAC key selected by its exact key ID."""

    purpose: str
    key_id: str
    tenant_id: str
    worker_audience: str
    worker_ingress_id: str
    worker_generation: str
    worker_credential_id: str
    secret: bytes
    not_before_epoch_micros: str
    not_after_epoch_micros: str


def _canonical_json(value: Any) -> str:
    if isinstance(value, Mapping):
        value = dict(value)
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _canonical_b64url(value: Any) -> bytes | None:
    if not isinstance(value, str) or not _BASE64URL.fullmatch(value):
        return None
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError):
        return None
    if not decoded or _b64url(decoded) != value:
        return None
    return decoded


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise RecoveryProtocolError("duplicate recovery field")
        result[key] = value
    return result


def _micros(value: Any) -> int | None:
    if not isinstance(value, str) or not _POSITIVE_MICROS.fullmatch(value):
        return None
    parsed = int(value)
    return parsed if parsed <= MAX_SIGNED_INT64 else None


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _valid_worker_run_id(value: Any) -> bool:
    return (isinstance(value, str) and _WORKER_RUN_ID.fullmatch(value) is not None
            and value.strip() == value)


def _valid_attempt_nonce(value: Any) -> bool:
    if not isinstance(value, str) or not _ATTEMPT_NONCE.fullmatch(value):
        return False
    decoded = _canonical_b64url(value)
    return decoded is not None and len(decoded) == 16


def _valid_binding(binding: Mapping[str, Any]) -> bool:
    return (
        isinstance(binding.get("tenantId"), str)
        and _UUID.fullmatch(binding["tenantId"]) is not None
        and all(isinstance(binding.get(field), str)
                and _ROUTE_TOKEN.fullmatch(binding[field]) is not None
                for field in ("workerAudience", "workerIngressId",
                              "workerGeneration", "workerCredentialId"))
    )


def _binding_from_identity(identity: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "tenantId": identity.get("tenantId"),
        "workerAudience": identity.get("workerAudience"),
        "workerIngressId": identity.get("workerIngressId"),
        "workerGeneration": identity.get("workerGeneration"),
        "workerCredentialId": identity.get("workerCredentialId"),
    }


def _binding_from_command(command: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "tenantId": command.get("tenantId"),
        "workerAudience": command.get("workerAudience"),
        "workerIngressId": command.get("workerIngressId"),
        "workerGeneration": command.get("workerGeneration"),
        "workerCredentialId": command.get("workerCredentialId"),
    }


def _valid_identity(identity: Any) -> bool:
    if not isinstance(identity, Mapping) or not _valid_binding(_binding_from_identity(identity)):
        return False
    return (
        isinstance(identity.get("runId"), str)
        and _UUID.fullmatch(identity["runId"]) is not None
        and isinstance(identity.get("requestSha256"), str)
        and _SHA256.fullmatch(identity["requestSha256"]) is not None
        and _micros(identity.get("reconciliationNotAfterEpochMicros")) is not None
        and _micros(identity.get("retainUntilEpochMicros")) is not None
        and int(identity["reconciliationNotAfterEpochMicros"])
            <= int(identity["retainUntilEpochMicros"])
    )


def _valid_key(key: Any, binding: Mapping[str, Any], purpose: str) -> bool:
    before = _micros(getattr(key, "not_before_epoch_micros", None))
    after = _micros(getattr(key, "not_after_epoch_micros", None))
    return (
        isinstance(key, RecoveryKey) and _valid_binding(binding)
        and key.purpose == purpose
        and isinstance(key.key_id, str)
        and _KEY_ID.fullmatch(key.key_id) is not None
        and key.tenant_id == binding["tenantId"]
        and key.worker_audience == binding["workerAudience"]
        and key.worker_ingress_id == binding["workerIngressId"]
        and key.worker_generation == binding["workerGeneration"]
        and key.worker_credential_id == binding["workerCredentialId"]
        and type(key.secret) is bytes and len(key.secret) >= 32
        and before is not None and after is not None and before < after
    )


def recovery_keys_are_distinct(command_key: RecoveryKey, receipt_key: RecoveryKey) -> bool:
    """Fail-closed provisioning check for the bidirectional key pair."""
    if (not isinstance(command_key, RecoveryKey) or not isinstance(receipt_key, RecoveryKey)
            or type(command_key.secret) is not bytes
            or type(receipt_key.secret) is not bytes):
        return False
    return not hmac.compare_digest(
        hashlib.sha256(command_key.secret).digest(),
        hashlib.sha256(receipt_key.secret).digest(),
    )


def _native_method(action: str) -> str:
    return "GET" if action == "status" else "POST"


def _native_path(action: str, worker_run_id: str) -> str:
    # JavaScript encodeURIComponent leaves exactly these punctuation marks safe.
    run = urllib.parse.quote(worker_run_id, safe="-_.!~*'()")
    return f"/v1/runs/{run}" if action == "status" else f"/v1/runs/{run}/stop"


def _command_claims(
    identity: Mapping[str, Any], worker_run_id: str, action: str,
    operation_id: str, attempt_nonce: str, native_body_sha256: str,
    not_before_epoch_micros: str, not_after_epoch_micros: str, key_id: str,
) -> dict[str, Any]:
    return {
        "version": VERSION,
        "purpose": COMMAND_PURPOSE,
        "keyId": key_id,
        "tenantId": identity["tenantId"],
        "runId": identity["runId"],
        "requestSha256": identity["requestSha256"],
        "workerRunId": worker_run_id,
        "workerAudience": identity["workerAudience"],
        "workerIngressId": identity["workerIngressId"],
        "workerGeneration": identity["workerGeneration"],
        "workerCredentialId": identity["workerCredentialId"],
        "action": action,
        "operationId": operation_id,
        "attemptNonce": attempt_nonce,
        "nativeMethod": _native_method(action),
        "nativePath": _native_path(action, worker_run_id),
        "nativeBodySha256": native_body_sha256,
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
    key_before = _micros(key.not_before_epoch_micros)
    key_after = _micros(key.not_after_epoch_micros)
    return (
        before is not None and after is not None and now is not None
        and key_before is not None and key_after is not None
        and before < after and after - before <= MAX_COMMAND_TTL_MICROS
        and before >= key_before and after <= key_after
        and after <= int(identity["reconciliationNotAfterEpochMicros"])
        and after <= int(identity["retainUntilEpochMicros"])
        and before <= now < after
    )


def _sign(prefix: str, domain: bytes, payload: str, secret: bytes) -> bytes:
    return hmac.new(secret, domain + f"{prefix}.{payload}".encode("ascii"), hashlib.sha256).digest()


def _encode_token(prefix: str, domain: bytes, claims: Mapping[str, Any], secret: bytes) -> str:
    payload = _b64url(_canonical_json(claims).encode("utf-8"))
    return f"{prefix}.{payload}.{_b64url(_sign(prefix, domain, payload, secret))}"


def _decode_token(token: Any, prefix: str) -> tuple[str, bytes, bytes] | None:
    if not isinstance(token, str):
        return None
    try:
        token_bytes = token.encode("ascii")
    except UnicodeEncodeError:
        return None
    if len(token_bytes) > MAX_TOKEN_BYTES:
        return None
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != prefix:
        return None
    payload = _canonical_b64url(parts[1])
    signature = _canonical_b64url(parts[2])
    if payload is None or signature is None or len(signature) != 32:
        return None
    return parts[1], payload, signature


def _decode_strict_json(payload: bytes) -> tuple[str, Any] | None:
    try:
        text = payload.decode("utf-8", errors="strict")
        parsed = json.loads(text, object_pairs_hook=_strict_object)
    except (UnicodeDecodeError, ValueError, TypeError, RecoveryProtocolError):
        return None
    return text, parsed


def mint_recovery_command_v1(
    *, identity: Mapping[str, Any], worker_run_id: str, action: str,
    operation_id: str, attempt_nonce: str, native_body: bytes,
    not_before_epoch_micros: str, not_after_epoch_micros: str,
    key: RecoveryKey,
) -> str:
    """Reference/API-side minting helper; it performs no I/O and reads no clock."""
    binding = _binding_from_identity(identity) if isinstance(identity, Mapping) else {}
    if (not _valid_identity(identity) or not _valid_worker_run_id(worker_run_id)
            or action not in {"status", "stop"}
            or not isinstance(operation_id, str) or _UUID.fullmatch(operation_id) is None
            or not _valid_attempt_nonce(attempt_nonce) or type(native_body) is not bytes
            or (action == "status" and native_body != b"")
            or not _valid_key(key, binding, COMMAND_PURPOSE)):
        raise RecoveryProtocolError("invalid Phase 4 recovery command material")
    claims = _command_claims(
        identity, worker_run_id, action, operation_id, attempt_nonce,
        _sha256(native_body), not_before_epoch_micros, not_after_epoch_micros,
        key.key_id,
    )
    if not _command_window_valid(claims, identity, key, not_before_epoch_micros):
        raise RecoveryProtocolError("invalid Phase 4 recovery command window")
    return _encode_token(COMMAND_PREFIX, COMMAND_DOMAIN, claims, key.secret)


def verify_recovery_command_v1(
    token: Any, identity: Mapping[str, Any], expected_worker_run_id: str,
    key: RecoveryKey, now_epoch_micros: str,
) -> Mapping[str, Any] | None:
    """Verify exact canonical TS command bytes against trusted identity and key."""
    binding = _binding_from_identity(identity) if isinstance(identity, Mapping) else {}
    if (not _valid_identity(identity) or not _valid_worker_run_id(expected_worker_run_id)
            or not _valid_key(key, binding, COMMAND_PURPOSE)):
        return None
    decoded = _decode_token(token, COMMAND_PREFIX)
    if decoded is None:
        return None
    encoded, payload, presented = decoded
    parsed = _decode_strict_json(payload)
    if parsed is None:
        return None
    text, row = parsed
    if not isinstance(row, dict):
        return None
    action = row.get("action")
    operation_id = row.get("operationId")
    attempt_nonce = row.get("attemptNonce")
    native_digest = row.get("nativeBodySha256")
    before = row.get("notBeforeEpochMicros")
    after = row.get("notAfterEpochMicros")
    if (action not in {"status", "stop"}
            or not isinstance(operation_id, str) or _UUID.fullmatch(operation_id) is None
            or not _valid_attempt_nonce(attempt_nonce)
            or not isinstance(native_digest, str) or _SHA256.fullmatch(native_digest) is None
            or (action == "status" and native_digest != _EMPTY_SHA256)
            or not isinstance(before, str) or not isinstance(after, str)):
        return None
    expected = _command_claims(
        identity, expected_worker_run_id, action, operation_id, attempt_nonce,
        native_digest, before, after, key.key_id,
    )
    if text != _canonical_json(expected) or not _command_window_valid(
            expected, identity, key, now_epoch_micros):
        return None
    expected_signature = _sign(COMMAND_PREFIX, COMMAND_DOMAIN, encoded, key.secret)
    if not hmac.compare_digest(presented, expected_signature):
        return None
    return MappingProxyType(expected)


def matches_recovery_native_request_v1(
    command: Mapping[str, Any], method: Any, path: Any, body: bytes,
) -> bool:
    """Compare the actual native request after strict command verification."""
    return (
        method in {"GET", "POST"} and isinstance(path, str) and type(body) is bytes
        and method == command.get("nativeMethod") and path == command.get("nativePath")
        and _sha256(body) == command.get("nativeBodySha256")
        and (command.get("action") != "status"
             or command.get("nativeBodySha256") == _EMPTY_SHA256)
    )


def normalize_native_observation_v1(
    *, action: str, native_http_status: int, native_status: str | None,
) -> tuple[str, str | None]:
    """Normalize one trusted parse of the pinned native response.

    The pinned worker exposes ``stopping`` while the signed cross-language
    vocabulary uses ``cancelling``.  The raw response bytes are deliberately
    not accepted here: callers must still pass those exact bytes to receipt
    minting so ``nativeResponseBodySha256`` binds the original spelling and
    representation.
    """
    if action not in {"status", "stop"} or type(native_http_status) is not int:
        raise RecoveryProtocolError("invalid native recovery observation")
    if native_http_status == 404 and native_status is None:
        return "not_found", None
    if (action == "stop" and native_http_status in {200, 202, 204}
            and native_status is None):
        return "stop_accepted", None
    if native_http_status != 200 or not isinstance(native_status, str):
        raise RecoveryProtocolError("invalid native recovery observation")
    worker_status = "cancelling" if native_status == "stopping" else native_status
    if worker_status in _NONTERMINAL:
        return "run_nonterminal", worker_status
    if worker_status in _TERMINAL:
        return "run_terminal", worker_status
    raise RecoveryProtocolError("unknown native recovery status")


def normalize_native_response_v1(
    *, command: Mapping[str, Any], native_http_status: int,
    native_response_body: bytes,
) -> tuple[str, str | None]:
    """Strictly parse only response shapes emitted by the pinned handlers."""
    if (not isinstance(command, Mapping) or command.get("action") not in {"status", "stop"}
            or not _valid_worker_run_id(command.get("workerRunId"))
            or type(native_http_status) is not int or type(native_response_body) is not bytes):
        raise RecoveryProtocolError("invalid native recovery response")
    parsed = _decode_strict_json(native_response_body)
    if parsed is None or not isinstance(parsed[1], dict):
        raise RecoveryProtocolError("invalid native recovery response JSON")
    row = parsed[1]
    worker_run_id = command["workerRunId"]
    if native_http_status == 404:
        if set(row) != {"error"} or not isinstance(row["error"], dict):
            raise RecoveryProtocolError("invalid native not-found response shape")
        native_error = row["error"]
        if (set(native_error) != {"message", "type", "param", "code"}
                or native_error.get("type") != "invalid_request_error"
                or native_error.get("param") is not None
                or native_error.get("code") != "run_not_found"
                or native_error.get("message") != f"Run not found: {worker_run_id}"):
            raise RecoveryProtocolError("invalid native not-found response")
        return "not_found", None
    if native_http_status != 200 or row.get("run_id") != worker_run_id:
        raise RecoveryProtocolError("native response is not bound to the worker run")
    native_status = row.get("status")
    if not isinstance(native_status, str):
        raise RecoveryProtocolError("native response status is invalid")
    if command["action"] == "stop" and native_status == "stopping":
        if tuple(row) != ("run_id", "status"):
            raise RecoveryProtocolError("invalid native Stop response shape")
    else:
        required = {"object", "run_id", "status", "updated_at", "created_at"}
        if (not required.issubset(row) or row.get("object") != "hermes.run"
                or any(type(row.get(field)) not in {int, float}
                       or not math.isfinite(row[field])
                       for field in ("updated_at", "created_at"))):
            raise RecoveryProtocolError("invalid native run-status response shape")
    return normalize_native_observation_v1(
        action=command["action"],
        native_http_status=native_http_status,
        native_status=native_status,
    )


def _valid_observation(
    observation: Any, worker_status: Any, native_http_status: Any, action: str,
) -> bool:
    if (type(native_http_status) is not int or native_http_status < 0
            or native_http_status > 599):
        return False
    if observation == "run_nonterminal":
        return (native_http_status == 200 and isinstance(worker_status, str)
                and worker_status in _NONTERMINAL)
    if observation == "run_terminal":
        return (native_http_status == 200 and isinstance(worker_status, str)
                and worker_status in _TERMINAL)
    if observation == "stop_accepted":
        return (action == "stop" and worker_status is None
                and native_http_status in {200, 202, 204})
    return observation == "not_found" and worker_status is None and native_http_status == 404


def _exact_command_claims(value: Any) -> bool:
    if not isinstance(value, Mapping):
        return False
    action = value.get("action")
    worker_run_id = value.get("workerRunId")
    if (action not in {"status", "stop"} or not _valid_worker_run_id(worker_run_id)
            or not isinstance(value.get("keyId"), str)
            or _KEY_ID.fullmatch(value["keyId"]) is None
            or not isinstance(value.get("operationId"), str)
            or _UUID.fullmatch(value["operationId"]) is None
            or not _valid_attempt_nonce(value.get("attemptNonce"))
            or not isinstance(value.get("nativeBodySha256"), str)
            or _SHA256.fullmatch(value["nativeBodySha256"]) is None
            or _micros(value.get("notBeforeEpochMicros")) is None
            or _micros(value.get("notAfterEpochMicros")) is None):
        return False
    identity = {
        "tenantId": value.get("tenantId"),
        "runId": value.get("runId"),
        "requestSha256": value.get("requestSha256"),
        "workerAudience": value.get("workerAudience"),
        "workerIngressId": value.get("workerIngressId"),
        "workerGeneration": value.get("workerGeneration"),
        "workerCredentialId": value.get("workerCredentialId"),
    }
    if (not _valid_binding(_binding_from_identity(identity))
            or not isinstance(identity["runId"], str) or _UUID.fullmatch(identity["runId"]) is None
            or not isinstance(identity["requestSha256"], str)
            or _SHA256.fullmatch(identity["requestSha256"]) is None):
        return False
    expected = _command_claims(
        identity, worker_run_id, action, value["operationId"], value["attemptNonce"],
        value["nativeBodySha256"], value["notBeforeEpochMicros"],
        value["notAfterEpochMicros"], value["keyId"],
    )
    return _canonical_json(value) == _canonical_json(expected)


def _receipt_claims(
    command: Mapping[str, Any], command_sha256: str, observation: str,
    worker_status: str | None, native_http_status: int,
    native_response_body_sha256: str, observed_at_epoch_micros: str,
    key_id: str,
) -> dict[str, Any]:
    return {
        "version": VERSION,
        "purpose": RECEIPT_PURPOSE,
        "keyId": key_id,
        "tenantId": command["tenantId"],
        "runId": command["runId"],
        "requestSha256": command["requestSha256"],
        "workerRunId": command["workerRunId"],
        "workerAudience": command["workerAudience"],
        "workerIngressId": command["workerIngressId"],
        "workerGeneration": command["workerGeneration"],
        "workerCredentialId": command["workerCredentialId"],
        "action": command["action"],
        "operationId": command["operationId"],
        "attemptNonce": command["attemptNonce"],
        "commandSha256": command_sha256,
        "nativeMethod": command["nativeMethod"],
        "nativePath": command["nativePath"],
        "nativeBodySha256": command["nativeBodySha256"],
        "nativeHttpStatus": native_http_status,
        "nativeResponseBodySha256": native_response_body_sha256,
        "observation": observation,
        "workerStatus": worker_status,
        "observedAtEpochMicros": observed_at_epoch_micros,
        "notBeforeEpochMicros": command["notBeforeEpochMicros"],
        "notAfterEpochMicros": command["notAfterEpochMicros"],
    }


def mint_recovery_receipt_v1(
    *, command_token: str, command: Mapping[str, Any], observation: str,
    worker_status: str | None, native_http_status: int,
    native_response_body: bytes, observed_at_epoch_micros: str,
    key: RecoveryKey,
) -> str:
    """Mint a receipt after command verification and native observation."""
    decoded_command = _decode_token(command_token, COMMAND_PREFIX)
    binding = _binding_from_command(command) if isinstance(command, Mapping) else {}
    command_payload_matches = False
    if decoded_command is not None:
        try:
            command_payload_matches = (
                decoded_command[1].decode("utf-8", errors="strict") == _canonical_json(command)
            )
        except UnicodeDecodeError:
            command_payload_matches = False
    if (not _exact_command_claims(command) or not command_payload_matches
            or not _valid_observation(observation, worker_status, native_http_status,
                                      command.get("action"))
            or type(native_response_body) is not bytes
            or not _valid_key(key, binding, RECEIPT_PURPOSE)):
        raise RecoveryProtocolError("invalid Phase 4 recovery receipt material")
    observed = _micros(observed_at_epoch_micros)
    before = _micros(command.get("notBeforeEpochMicros"))
    after = _micros(command.get("notAfterEpochMicros"))
    key_before = _micros(key.not_before_epoch_micros)
    key_after = _micros(key.not_after_epoch_micros)
    if (observed is None or before is None or after is None
            or key_before is None or key_after is None
            or observed < before or observed >= after
            or before < key_before or after > key_after):
        raise RecoveryProtocolError("invalid Phase 4 recovery receipt window")
    claims = _receipt_claims(
        command, _sha256(command_token.encode("ascii")), observation, worker_status,
        native_http_status, _sha256(native_response_body), observed_at_epoch_micros,
        key.key_id,
    )
    return _encode_token(RECEIPT_PREFIX, RECEIPT_DOMAIN, claims, key.secret)


def verify_recovery_receipt_v1(
    token: Any, command_token: Any, identity: Mapping[str, Any],
    expected_worker_run_id: str, command_key: RecoveryKey,
    receipt_key: RecoveryKey, now_epoch_micros: str,
) -> Mapping[str, Any] | None:
    """Verify exact canonical command and receipt tokens using distinct keys."""
    if not recovery_keys_are_distinct(command_key, receipt_key):
        return None
    command = verify_recovery_command_v1(
        command_token, identity, expected_worker_run_id, command_key, now_epoch_micros,
    )
    binding = _binding_from_identity(identity) if isinstance(identity, Mapping) else {}
    if (command is None or not isinstance(command_token, str)
            or not _valid_key(receipt_key, binding, RECEIPT_PURPOSE)):
        return None
    decoded = _decode_token(token, RECEIPT_PREFIX)
    if decoded is None:
        return None
    encoded, payload, presented = decoded
    parsed = _decode_strict_json(payload)
    if parsed is None:
        return None
    text, row = parsed
    if not isinstance(row, dict):
        return None
    response_digest = row.get("nativeResponseBodySha256")
    observed_at = row.get("observedAtEpochMicros")
    if (not isinstance(response_digest, str) or _SHA256.fullmatch(response_digest) is None
            or not isinstance(observed_at, str)
            or not _valid_observation(row.get("observation"), row.get("workerStatus"),
                                      row.get("nativeHttpStatus"), command["action"])):
        return None
    expected = _receipt_claims(
        command, _sha256(command_token.encode("ascii")), row["observation"],
        row["workerStatus"], row["nativeHttpStatus"], response_digest, observed_at,
        receipt_key.key_id,
    )
    if text != _canonical_json(expected):
        return None
    observed = _micros(observed_at)
    now = _micros(now_epoch_micros)
    key_before = _micros(receipt_key.not_before_epoch_micros)
    key_after = _micros(receipt_key.not_after_epoch_micros)
    if (observed is None or now is None or key_before is None or key_after is None
            or observed < int(command["notBeforeEpochMicros"])
            or observed >= int(command["notAfterEpochMicros"])
            or observed > now or int(command["notBeforeEpochMicros"]) < key_before
            or int(command["notAfterEpochMicros"]) > key_after):
        return None
    expected_signature = _sign(RECEIPT_PREFIX, RECEIPT_DOMAIN, encoded, receipt_key.secret)
    if not hmac.compare_digest(presented, expected_signature):
        return None
    return MappingProxyType(expected)


def matches_recovery_native_response_v1(
    receipt: Mapping[str, Any], http_status: Any, body: bytes,
) -> bool:
    return (
        type(http_status) is int and type(body) is bytes
        and http_status == receipt.get("nativeHttpStatus")
        and _sha256(body) == receipt.get("nativeResponseBodySha256")
    )


def recovery_disposition_v1(receipt: Mapping[str, Any] | None) -> str:
    """Map authenticated facts without inventing absence or termination."""
    if receipt is None or receipt.get("observation") == "not_found":
        return "UNKNOWN"
    return "terminal" if receipt.get("observation") == "run_terminal" else "nonterminal"
