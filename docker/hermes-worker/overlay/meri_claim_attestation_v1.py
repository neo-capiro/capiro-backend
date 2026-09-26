"""Dormant Phase 4 worker claim gate for the checksum-pinned Hermes overlay.

This module never falls back to another worker secret.  It captures the exact
``POST /v1/runs`` bytes and headers, mints a purpose-separated tool-view
attestation from immutable worker observations, and performs one bounded HTTPS
claim attempt.  Only an exact ``transitioned`` response opens the run gate.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import ssl
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Callable, Mapping


CLAIM_ATTESTATION_DOMAIN = "capiro.meri.phase4.claim-tool-view-attestation/v1"
CLAIM_ENDPOINT_PATH = "/api/internal/meri/hermes/phase4/claim"
DISPATCH_BEARER_HEADER = "X-Meri-Dispatch-Gate-Bearer"
CLAIM_SERVICE_SECRET_HEADER = "X-Meri-Dispatch-Claim-Service-Secret"
_BEARER_PREFIX = "mdgb1"
_BEARER_PURPOSE = "meri-hermes-dispatch-gate"
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_VISIBLE = re.compile(r"^[\x21-\x7e]+$")
_POSITIVE_MICROS = re.compile(r"^[1-9][0-9]{0,18}$")
_MAX_SIGNED_INT64 = 9_223_372_036_854_775_807
_MAX_ATTESTATION_TTL_MICROS = 60_000_000
_MAX_RAW_BODY_BYTES = 1_048_576
_MAX_RESPONSE_BYTES = 4096
_MAX_NATIVE_RETENTION_SPAN_MICROS = 7 * 24 * 60 * 60 * 1_000_000
_WORKER_IDEMPOTENCY_DOMAIN = b"capiro.meri.phase4.worker-idempotency/v1"


class Phase4ClaimError(RuntimeError):
    pass


def _canonical_b64url_decode(value: Any, *, maximum: int) -> bytes:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise Phase4ClaimError("invalid_phase4_claim_encoding")
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError) as exc:
        raise Phase4ClaimError("invalid_phase4_claim_encoding") from exc
    if (not decoded or len(decoded) > maximum or
            base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=") != value):
        raise Phase4ClaimError("invalid_phase4_claim_encoding")
    return decoded


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise Phase4ClaimError("duplicate_phase4_claim_field")
        result[key] = value
    return result


def _micros(value: Any) -> int:
    if not isinstance(value, str) or not _POSITIVE_MICROS.fullmatch(value):
        raise Phase4ClaimError("invalid_phase4_claim_window")
    parsed = int(value)
    if parsed > _MAX_SIGNED_INT64:
        raise Phase4ClaimError("invalid_phase4_claim_window")
    return parsed


_BEARER_KEYS = (
    "version", "purpose", "keyId", "tenantId", "actorType", "actorId",
    "scopeId", "runId", "requestSha256", "workerAudience", "workerIngressId",
    "workerGeneration", "workerCredentialId", "authorizationVersion",
    "reconciliationNotAfterEpochMicros", "retainUntilEpochMicros",
    "notBeforeEpochMicros", "notAfterEpochMicros",
)


def decode_dispatch_gate_bearer_unverified(bearer: Any) -> dict[str, str]:
    """Strictly decode routing material; the API remains the HMAC verifier."""
    if not isinstance(bearer, str) or len(bearer) > 8192:
        raise Phase4ClaimError("invalid_phase4_dispatch_bearer")
    parts = bearer.split(".")
    if len(parts) != 3 or parts[0] != _BEARER_PREFIX:
        raise Phase4ClaimError("invalid_phase4_dispatch_bearer")
    payload = _canonical_b64url_decode(parts[1], maximum=6144)
    if len(_canonical_b64url_decode(parts[2], maximum=32)) != 32:
        raise Phase4ClaimError("invalid_phase4_dispatch_bearer")
    try:
        parsed = json.loads(payload.decode("utf-8"), object_pairs_hook=_strict_object)
    except (ValueError, UnicodeDecodeError, Phase4ClaimError) as exc:
        raise Phase4ClaimError("invalid_phase4_dispatch_bearer") from exc
    if not isinstance(parsed, dict) or tuple(parsed) != _BEARER_KEYS:
        raise Phase4ClaimError("invalid_phase4_dispatch_bearer")
    expected = {
        "version": 1,
        "purpose": _BEARER_PURPOSE,
        "keyId": parsed.get("keyId"),
        "tenantId": parsed.get("tenantId"),
        "actorType": "user",
        "actorId": parsed.get("actorId"),
        "scopeId": parsed.get("scopeId"),
        "runId": parsed.get("runId"),
        "requestSha256": parsed.get("requestSha256"),
        "workerAudience": parsed.get("workerAudience"),
        "workerIngressId": parsed.get("workerIngressId"),
        "workerGeneration": parsed.get("workerGeneration"),
        "workerCredentialId": parsed.get("workerCredentialId"),
        "authorizationVersion": parsed.get("authorizationVersion"),
        "reconciliationNotAfterEpochMicros": parsed.get(
            "reconciliationNotAfterEpochMicros"),
        "retainUntilEpochMicros": parsed.get("retainUntilEpochMicros"),
        "notBeforeEpochMicros": parsed.get("notBeforeEpochMicros"),
        "notAfterEpochMicros": parsed.get("notAfterEpochMicros"),
    }
    if (payload.decode("utf-8") != json.dumps(expected, separators=(",", ":"), ensure_ascii=False)
            or any(not isinstance(expected[key], str) or not expected[key]
                   for key in _BEARER_KEYS if key not in {"version", "actorType"})
            or not _UUID.fullmatch(str(expected["tenantId"]))
            or not _UUID.fullmatch(str(expected["actorId"]))
            or not _UUID.fullmatch(str(expected["runId"]))
            or not _SHA256.fullmatch(str(expected["requestSha256"]))):
        raise Phase4ClaimError("invalid_phase4_dispatch_bearer")
    before = _micros(expected["notBeforeEpochMicros"])
    after = _micros(expected["notAfterEpochMicros"])
    reconciliation = _micros(expected["reconciliationNotAfterEpochMicros"])
    retain = _micros(expected["retainUntilEpochMicros"])
    if (before >= after or after >= reconciliation or reconciliation >= retain
            or retain - before > _MAX_NATIVE_RETENTION_SPAN_MICROS):
        raise Phase4ClaimError("invalid_phase4_dispatch_bearer")
    return {key: str(value) for key, value in expected.items()}


def phase4_native_retention_until(claims: Mapping[str, Any]) -> int:
    """Return a whole-second deadline that cannot shorten the signed API horizon."""
    if not isinstance(claims, Mapping):
        raise Phase4ClaimError("invalid_phase4_dispatch_bearer")
    before = _micros(claims.get("notBeforeEpochMicros"))
    after = _micros(claims.get("notAfterEpochMicros"))
    reconciliation = _micros(claims.get("reconciliationNotAfterEpochMicros"))
    retain = _micros(claims.get("retainUntilEpochMicros"))
    if (before >= after or after >= reconciliation or reconciliation >= retain
            or retain - before > _MAX_NATIVE_RETENTION_SPAN_MICROS):
        raise Phase4ClaimError("invalid_phase4_dispatch_bearer")
    return (retain + 999_999) // 1_000_000


def validate_phase4_dispatch_bearer(bearer: Any) -> Mapping[str, Any]:
    claims = decode_dispatch_gate_bearer_unverified(bearer)
    bindings = {
        "tenantId": "MERI_PHASE4_TENANT_ID",
        "scopeId": "MERI_PHASE4_SCOPE_ID",
        "workerAudience": "MERI_PHASE4_WORKER_AUDIENCE",
        "workerIngressId": "MERI_PHASE4_WORKER_INGRESS_ID",
        "workerGeneration": "MERI_PHASE4_WORKER_GENERATION",
        "workerCredentialId": "MERI_PHASE4_WORKER_CREDENTIAL_ID",
    }
    if any(not os.environ.get(env_name) or claims[field] != os.environ.get(env_name)
           for field, env_name in bindings.items()):
        raise Phase4ClaimError("phase4_claim_route_binding_mismatch")
    return MappingProxyType(dict(claims))


@dataclass(frozen=True)
class Phase4ClaimContext:
    bearer: str
    claims: Mapping[str, Any]
    raw_body: bytes
    received_method: str
    received_path: str
    received_content_type: str
    session_header_value: str
    idempotency_key_header_value: str
    worker_run_id: str


def phase4_worker_idempotency_fingerprint(
    *, raw_body: Any, received_method: Any, received_path: Any,
    received_content_type: Any, session_header_value: Any,
    idempotency_key_header_value: Any, dispatch_gate_bearer_header_value: Any,
) -> str:
    """Bind native replay lookup/reserve to the exact guarded wire request."""
    if (received_method != "POST" or received_path != "/v1/runs" or
            received_content_type != "application/json" or
            not isinstance(raw_body, (bytes, bytearray)) or
            not isinstance(session_header_value, str) or
            not isinstance(idempotency_key_header_value, str) or
            not isinstance(dispatch_gate_bearer_header_value, str)):
        raise Phase4ClaimError("noncanonical_phase4_claim_ingress")
    parts = (
        _WORKER_IDEMPOTENCY_DOMAIN,
        received_method.encode("utf-8"),
        received_path.encode("utf-8"),
        received_content_type.encode("utf-8"),
        session_header_value.encode("utf-8"),
        idempotency_key_header_value.encode("utf-8"),
        dispatch_gate_bearer_header_value.encode("utf-8"),
        bytes(raw_body),
    )
    return hashlib.sha256(b"".join(
        len(part).to_bytes(8, "big") + part for part in parts)).hexdigest()


def capture_phase4_claim_context(
    *, bearer: Any, raw_body: Any, received_method: Any, received_path: Any,
    received_content_type: Any, session_header_value: Any,
    idempotency_key_header_value: Any, worker_run_id: Any,
) -> Phase4ClaimContext:
    if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") != "1":
        raise Phase4ClaimError("phase4_claim_gate_disabled")
    if (received_method != "POST" or received_path != "/v1/runs" or
            received_content_type != "application/json"):
        raise Phase4ClaimError("noncanonical_phase4_claim_ingress")
    if not isinstance(raw_body, (bytes, bytearray)) or not 0 < len(raw_body) <= _MAX_RAW_BODY_BYTES:
        raise Phase4ClaimError("invalid_phase4_claim_body")
    if (not isinstance(session_header_value, str) or not _VISIBLE.fullmatch(session_header_value)
            or not isinstance(idempotency_key_header_value, str)
            or not _VISIBLE.fullmatch(idempotency_key_header_value)
            or not isinstance(worker_run_id, str) or not 0 < len(worker_run_id) <= 120
            or worker_run_id.strip() != worker_run_id
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in worker_run_id)):
        raise Phase4ClaimError("invalid_phase4_claim_headers")
    claims = validate_phase4_dispatch_bearer(bearer)
    return Phase4ClaimContext(
        bearer=str(bearer), claims=MappingProxyType(dict(claims)), raw_body=bytes(raw_body),
        received_method=received_method, received_path=received_path,
        received_content_type=received_content_type,
        session_header_value=session_header_value,
        idempotency_key_header_value=idempotency_key_header_value,
        worker_run_id=worker_run_id,
    )


@dataclass(frozen=True)
class ClaimAttestationKey:
    secret: bytes
    tenant_id: str
    scope_id: str
    worker_audience: str
    worker_ingress_id: str
    worker_generation: str
    worker_credential_id: str
    not_before_epoch_micros: str
    not_after_epoch_micros: str


def _load_attestation_key() -> ClaimAttestationKey:
    encoded = os.environ.get("MERI_PHASE4_CLAIM_ATTESTATION_KEY_B64URL", "")
    secret = _canonical_b64url_decode(encoded, maximum=64)
    if len(secret) < 32:
        raise Phase4ClaimError("phase4_claim_attestation_key_unavailable")
    for other_name in (
        "MERI_HERMES_TOOL_VIEW_SIGNING_KEY", "API_SERVER_KEY",
        "MERI_PHASE4_CLAIM_SERVICE_SECRET", "MERI_WORKER_TOKEN",
        "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY",
    ):
        other = os.environ.get(other_name, "")
        if other and hmac.compare_digest(secret, other.encode("utf-8")):
            raise Phase4ClaimError("phase4_claim_attestation_key_not_purpose_separated")
    key = ClaimAttestationKey(
        secret=secret,
        tenant_id=os.environ.get("MERI_PHASE4_TENANT_ID", ""),
        scope_id=os.environ.get("MERI_PHASE4_SCOPE_ID", ""),
        worker_audience=os.environ.get("MERI_PHASE4_WORKER_AUDIENCE", ""),
        worker_ingress_id=os.environ.get("MERI_PHASE4_WORKER_INGRESS_ID", ""),
        worker_generation=os.environ.get("MERI_PHASE4_WORKER_GENERATION", ""),
        worker_credential_id=os.environ.get("MERI_PHASE4_WORKER_CREDENTIAL_ID", ""),
        not_before_epoch_micros=os.environ.get(
            "MERI_PHASE4_CLAIM_ATTESTATION_KEY_NOT_BEFORE_EPOCH_MICROS", ""),
        not_after_epoch_micros=os.environ.get(
            "MERI_PHASE4_CLAIM_ATTESTATION_KEY_NOT_AFTER_EPOCH_MICROS", ""),
    )
    before = _micros(key.not_before_epoch_micros)
    after = _micros(key.not_after_epoch_micros)
    if before >= after or any(not value for value in (
        key.tenant_id, key.scope_id, key.worker_audience, key.worker_ingress_id,
        key.worker_generation, key.worker_credential_id,
    )):
        raise Phase4ClaimError("phase4_claim_attestation_key_unavailable")
    return key


def mint_claim_tool_view_attestation_v1(
    *, tenant_id: str, run_id: str, request_sha256: str, worker_run_id: str,
    worker_audience: str, worker_ingress_id: str, worker_generation: str,
    worker_credential_id: str, catalog_digest: str, tool_view_digest: str,
    not_before_epoch_micros: str, not_after_epoch_micros: str,
    key: ClaimAttestationKey,
) -> str:
    if (tenant_id != key.tenant_id or worker_audience != key.worker_audience
            or worker_ingress_id != key.worker_ingress_id
            or worker_generation != key.worker_generation
            or worker_credential_id != key.worker_credential_id
            or not _UUID.fullmatch(tenant_id) or not _UUID.fullmatch(run_id)
            or not _SHA256.fullmatch(request_sha256) or not _SHA256.fullmatch(catalog_digest)
            or not _SHA256.fullmatch(tool_view_digest)
            or not isinstance(worker_run_id, str) or not 0 < len(worker_run_id) <= 120):
        raise Phase4ClaimError("invalid_phase4_claim_attestation_material")
    before = _micros(not_before_epoch_micros)
    after = _micros(not_after_epoch_micros)
    key_before = _micros(key.not_before_epoch_micros)
    key_after = _micros(key.not_after_epoch_micros)
    if (before >= after or after - before > _MAX_ATTESTATION_TTL_MICROS
            or before < key_before or after > key_after):
        raise Phase4ClaimError("invalid_phase4_claim_attestation_window")
    fields = [
        CLAIM_ATTESTATION_DOMAIN, "1", tenant_id, run_id, request_sha256,
        worker_run_id, worker_audience, worker_ingress_id, worker_generation,
        worker_credential_id, catalog_digest, tool_view_digest,
        not_before_epoch_micros, not_after_epoch_micros,
    ]
    encoded = _b64url(json.dumps(fields, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    signature = hmac.new(key.secret, encoded.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


def _strict_claim_origin() -> str:
    raw = os.environ.get("MERI_PHASE4_CLAIM_ORIGIN", "")
    parsed = urllib.parse.urlsplit(raw)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment
            or raw != f"https://{parsed.netloc}"):
        raise Phase4ClaimError("invalid_phase4_claim_origin")
    return raw


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _post_claim(payload: bytes) -> dict[str, Any]:
    secret = os.environ.get("MERI_PHASE4_CLAIM_SERVICE_SECRET", "")
    if len(secret) < 32 or not _VISIBLE.fullmatch(secret):
        raise Phase4ClaimError("phase4_claim_service_secret_unavailable")
    request = urllib.request.Request(
        _strict_claim_origin() + CLAIM_ENDPOINT_PATH,
        data=payload,
        headers={
            "Content-Type": "application/json",
            CLAIM_SERVICE_SECRET_HEADER: secret,
        },
        method="POST",
    )
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        _NoRedirect(),
    )
    try:
        with opener.open(request, timeout=2.0) as response:
            if response.status != 200 or response.headers.get_content_type() != "application/json":
                raise Phase4ClaimError("phase4_claim_rejected")
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as exc:
        raise Phase4ClaimError("phase4_claim_unconfirmed") from exc
    if len(raw) > _MAX_RESPONSE_BYTES:
        raise Phase4ClaimError("phase4_claim_response_too_large")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_strict_object)
    except (ValueError, UnicodeDecodeError, Phase4ClaimError) as exc:
        raise Phase4ClaimError("invalid_phase4_claim_response") from exc
    if not isinstance(value, dict):
        raise Phase4ClaimError("invalid_phase4_claim_response")
    return value


class Phase4ClaimGate:
    """One-shot gate inherited by the pinned delegate and background-review paths."""

    def __init__(self, context: Phase4ClaimContext,
                 transport: Callable[[bytes], dict[str, Any]] | None = None):
        self._context = context
        self._transport = transport or _post_claim
        self._lock = threading.Lock()
        self._state = "pending"

    @property
    def authorized(self) -> bool:
        return self._state == "authorized"

    def authorize(self, agent: Any, view: dict[str, Any]) -> None:
        with self._lock:
            if self._state == "authorized":
                return
            if self._state != "pending":
                raise Phase4ClaimError("phase4_claim_not_authorized")
            # A failure is permanent.  Retrying an ambiguous claim could have
            # committed and would return status_only, which never authorizes launch.
            self._state = "denied"
            from meri_tool_view_v1 import (
                _applied_tool_view_digest, _assert_selected_schemas, _assert_worker_catalog,
            )
            _assert_worker_catalog(agent, view)
            expected = view.get("selected_schema_sha256")
            actual = getattr(agent, "tools", None)
            if not isinstance(expected, dict) or not isinstance(actual, list):
                raise Phase4ClaimError("phase4_claim_tool_view_drift")
            _assert_selected_schemas(actual, expected)
            applied = sorted(actual, key=lambda item: item["function"]["name"])
            if frozenset(item["function"]["name"] for item in applied) != view["tool_names"]:
                raise Phase4ClaimError("phase4_claim_tool_view_drift")
            observed_view = _applied_tool_view_digest(applied)
            if not hmac.compare_digest(observed_view, view["applied_tool_view_sha256"]):
                raise Phase4ClaimError("phase4_claim_tool_view_drift")
            key = _load_attestation_key()
            claims = self._context.claims
            if (key.scope_id != claims["scopeId"] or key.tenant_id != claims["tenantId"]
                    or key.worker_audience != claims["workerAudience"]
                    or key.worker_ingress_id != claims["workerIngressId"]
                    or key.worker_generation != claims["workerGeneration"]
                    or key.worker_credential_id != claims["workerCredentialId"]):
                raise Phase4ClaimError("phase4_claim_route_binding_mismatch")
            not_before = claims["notBeforeEpochMicros"]
            bearer_after = _micros(claims["notAfterEpochMicros"])
            not_after = str(min(bearer_after, _micros(not_before) + _MAX_ATTESTATION_TTL_MICROS))
            token = mint_claim_tool_view_attestation_v1(
                tenant_id=claims["tenantId"], run_id=claims["runId"],
                request_sha256=claims["requestSha256"],
                worker_run_id=self._context.worker_run_id,
                worker_audience=claims["workerAudience"],
                worker_ingress_id=claims["workerIngressId"],
                worker_generation=claims["workerGeneration"],
                worker_credential_id=claims["workerCredentialId"],
                catalog_digest=view["worker_catalog_sha256"],
                tool_view_digest=observed_view,
                not_before_epoch_micros=not_before,
                not_after_epoch_micros=not_after,
                key=key,
            )
            wire = {
                "version": 2,
                "receivedMethod": self._context.received_method,
                "receivedPath": self._context.received_path,
                "receivedContentType": self._context.received_content_type,
                "tenantId": claims["tenantId"],
                "runId": claims["runId"],
                "requestSha256": claims["requestSha256"],
                "workerRunId": self._context.worker_run_id,
                "bearer": self._context.bearer,
                "toolViewAttestation": token,
                "bodyBase64url": _b64url(self._context.raw_body),
                "sessionHeaderValue": self._context.session_header_value,
                "idempotencyKeyHeaderValue": self._context.idempotency_key_header_value,
            }
            payload = json.dumps(wire, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            response = self._transport(payload)
            if response != {"version": 2, "kind": "transitioned", "launchAuthorized": True}:
                raise Phase4ClaimError("phase4_claim_not_authorized")
            self._state = "authorized"

    def assert_authorized(self) -> None:
        if self._state != "authorized":
            raise Phase4ClaimError("phase4_claim_not_authorized")


def assert_phase4_launch_authorized(agent: Any) -> None:
    gate = getattr(agent, "_meri_phase4_claim_gate_v1", None)
    if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1" and not isinstance(gate, Phase4ClaimGate):
        raise Phase4ClaimError("phase4_claim_gate_missing")
    if gate is not None and not isinstance(gate, Phase4ClaimGate):
        raise Phase4ClaimError("invalid_phase4_claim_gate")
    if gate is not None:
        gate.assert_authorized()


def phase4_claim_ingress_allowed(method: Any, path: Any, query_string: Any = "") -> bool:
    if (not isinstance(method, str) or not isinstance(path, str)
            or query_string != "" or path.startswith("/p/")):
        return False
    read_only = method == "GET" and (
        path in {"/health", "/health/detailed", "/v1/capabilities", "/v1/models"}
        or re.fullmatch(r"/v1/runs/[^/]+(?:/events)?", path) is not None
    )
    run_post = method == "POST" and (
        path == "/v1/runs"
        or path == "/v1/meri/phase4/reservations/lookup-or-seal"
        or re.fullmatch(r"/v1/runs/[^/]+/(?:approval|steer|stop)", path) is not None
    )
    return read_only or run_post


def make_phase4_claim_ingress_middleware():
    """Default-deny non-allowlisted routes on the patched main aiohttp surface."""
    from aiohttp import web

    @web.middleware
    async def phase4_claim_ingress_middleware(request, handler):
        if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") != "1":
            return await handler(request)
        if not phase4_claim_ingress_allowed(
                request.method, request.path, request.query_string):
            return web.json_response({"error": "not found"}, status=404)
        return await handler(request)

    return phase4_claim_ingress_middleware
