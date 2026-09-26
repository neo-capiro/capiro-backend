"""Meri's opt-in, request-local Hermes tool view (pinned v2026.9.14 overlay).

The payload is signed by the Meri API using a dedicated tool-view key.
No process-wide tool registry or worker profile is changed. This is a schema
exposure control; Meri's broker remains the execution authorization source.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
from typing import Any


class ToolViewError(ValueError):
    pass


_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
# These can dispatch undisclosed tools or create agents with independent tools.
_UNSUPPORTED_BRIDGES = frozenset({"tool_search", "tool_call", "delegate_task", "execute_code"})
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_MAX_CANONICAL_BYTES = 1_048_576
_MAX_CATALOG_TOOLS = 4_096
WORKER_CATALOG_DIGEST_ALGORITHM = "capiro.meri.phase4.worker-catalog/v1"
APPLIED_TOOL_VIEW_DIGEST_ALGORITHM = "capiro.meri.phase4.applied-tool-view/v1"
_TOOL_SCHEMA_DIGEST_ALGORITHM = "capiro.meri.phase4.tool-schema/v1"


def _canonical_json(value: Any, depth: int = 0) -> str:
    """Cross-language v1 form shared with meri-hermes-tool-view.ts."""
    if depth > 64:
        raise ToolViewError("invalid_worker_tool_schema")
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise ToolViewError("invalid_worker_tool_schema") from exc
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > _MAX_SAFE_INTEGER:
            raise ToolViewError("invalid_worker_tool_schema")
        return str(value)
    if isinstance(value, list):
        return "[" + ",".join(_canonical_json(item, depth + 1) for item in value) + "]"
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ToolViewError("invalid_worker_tool_schema")
        try:
            keys = sorted(value, key=lambda key: key.encode("utf-8"))
        except UnicodeEncodeError as exc:
            raise ToolViewError("invalid_worker_tool_schema") from exc
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False, separators=(",", ":")) + ":" +
            _canonical_json(value[key], depth + 1) for key in keys
        ) + "}"
    raise ToolViewError("invalid_worker_tool_schema")


def _versioned_digest(domain: str, value: Any) -> str:
    encoded = _canonical_json(value).encode("utf-8")
    if len(encoded) > _MAX_CANONICAL_BYTES:
        raise ToolViewError("invalid_worker_tool_schema")
    framed = domain.encode("utf-8") + len(encoded).to_bytes(4, "big") + encoded
    return hashlib.sha256(framed).hexdigest()


def _schema_digest(schema: dict[str, Any]) -> str:
    return _versioned_digest(_TOOL_SCHEMA_DIGEST_ALGORITHM, schema)


def _applied_tool_view_digest(schemas: list[dict[str, Any]]) -> str:
    ordered = sorted(schemas, key=lambda item: item["function"]["name"])
    return _versioned_digest(APPLIED_TOOL_VIEW_DIGEST_ALGORITHM, ordered)


def _worker_catalog(agent: Any = None, *, enabled_toolsets: Any = None) -> tuple[str, dict[str, dict[str, Any]]]:
    """Snapshot the worker's raw registry before tool_search assembly."""
    try:
        import model_tools
        raw = model_tools.get_tool_definitions(
            enabled_toolsets=(enabled_toolsets if agent is None else getattr(agent, "enabled_toolsets", None)),
            disabled_toolsets=getattr(agent, "disabled_toolsets", None),
            quiet_mode=True,
            skip_tool_search_assembly=True,
        )
    except Exception as exc:
        raise ToolViewError("worker_catalog_unavailable") from exc
    if not isinstance(raw, list) or len(raw) > _MAX_CATALOG_TOOLS:
        raise ToolViewError("invalid_worker_tool_schema")
    by_name: dict[str, dict[str, Any]] = {}
    for schema in raw:
        function = schema.get("function") if isinstance(schema, dict) else None
        name = function.get("name") if isinstance(function, dict) else None
        outer_name = schema.get("name") if isinstance(schema, dict) else None
        if (not isinstance(schema, dict) or schema.get("type") != "function"
                or not isinstance(name, str) or not _NAME.fullmatch(name) or name in by_name
                or (outer_name is not None and outer_name != name)):
            raise ToolViewError("invalid_worker_tool_schema")
        # Clone registry objects so a later refresh cannot mutate the baseline.
        try:
            by_name[name] = json.loads(_canonical_json(schema))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ToolViewError("invalid_worker_tool_schema") from exc
    version = _versioned_digest(
        WORKER_CATALOG_DIGEST_ALGORITHM,
        [by_name[name] for name in sorted(by_name)],
    )
    return version, by_name


def worker_catalog_capability(*, enabled_toolsets: Any) -> dict[str, Any]:
    """Advertise the current digest only when this optional extension is ready."""
    if os.environ.get("MERI_HERMES_TOOL_VIEW_V1_ENABLED") != "1":
        return {"supported": False}
    try:
        version, by_name = _worker_catalog(enabled_toolsets=enabled_toolsets)
    except ToolViewError:
        return {"supported": False}
    return {
        "supported": True,
        "worker_catalog_sha256": version,
        "worker_catalog_schemas": [by_name[name] for name in sorted(by_name)],
        "worker_catalog_digest_algorithm": WORKER_CATALOG_DIGEST_ALGORITHM,
        "applied_tool_view_digest_algorithm": APPLIED_TOOL_VIEW_DIGEST_ALGORITHM,
    }


def _assert_worker_catalog(agent: Any, view: dict[str, Any]) -> dict[str, dict[str, Any]]:
    expected = view.get("worker_catalog_sha256")
    if not isinstance(expected, str) or not _SHA256.fullmatch(expected):
        raise ToolViewError("invalid_tool_view_payload")
    actual, by_name = _worker_catalog(agent)
    if not hmac.compare_digest(actual, expected):
        raise ToolViewError("stale_worker_catalog")
    if not view["required_tool_names"].issubset(by_name):
        raise ToolViewError("required_tool_unavailable_in_worker")
    if not view["tool_names"].issubset(by_name):
        raise ToolViewError("tool_unavailable_in_worker_catalog")
    return by_name


def _assert_selected_schemas(schemas: Any, expected: dict[str, str]) -> None:
    if schemas is None:
        return
    if not isinstance(schemas, list):
        raise ToolViewError("invalid_worker_tool_schema")
    for schema in schemas:
        function = schema.get("function") if isinstance(schema, dict) else None
        name = function.get("name") if isinstance(function, dict) else None
        if not isinstance(name, str):
            raise ToolViewError("invalid_worker_tool_schema")
        if name in expected and _schema_digest(schema) != expected[name]:
            raise ToolViewError("changed_worker_tool_schema")


def _decode_payload(token: dict[str, Any], *, key: str) -> dict[str, Any]:
    if not isinstance(token, dict) or set(token) != {"payload", "signature"}:
        raise ToolViewError("invalid_tool_view_token")
    payload_b64, signature = token["payload"], token["signature"]
    if not isinstance(payload_b64, str) or not isinstance(signature, str):
        raise ToolViewError("invalid_tool_view_token")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,8192}", payload_b64) or not re.fullmatch(r"[0-9a-f]{64}", signature):
        raise ToolViewError("invalid_tool_view_token")
    expected = hmac.new(key.encode(), payload_b64.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ToolViewError("invalid_tool_view_signature")
    try:
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4)))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ToolViewError("invalid_tool_view_payload") from exc
    if not isinstance(payload, dict):
        raise ToolViewError("invalid_tool_view_payload")
    return payload


def verify_tool_view(token: Any, *, user_message: str, now: float | None = None,
                     check_freshness: bool = True) -> dict[str, Any]:
    """Verify the signed policy. Only a retained exact replay may skip freshness."""
    if os.environ.get("MERI_HERMES_TOOL_VIEW_V1_ENABLED") != "1":
        raise ToolViewError("tool_view_extension_disabled")
    key = os.environ.get("MERI_HERMES_TOOL_VIEW_SIGNING_KEY", "")
    if len(key) < 32:
        raise ToolViewError("tool_view_signing_key_unavailable")
    payload = _decode_payload(token, key=key)
    names, required = payload.get("tool_names"), payload.get("required_tool_names")
    worker_version = payload.get("worker_catalog_sha256")
    applied_version = payload.get("applied_tool_view_sha256")
    if (set(payload) != {"version", "catalog_version", "worker_catalog_sha256",
                         "worker_catalog_digest_algorithm", "applied_tool_view_sha256",
                         "applied_tool_view_digest_algorithm", "tool_names",
                         "required_tool_names", "expires_at", "input_sha256"}
            or payload.get("version") != 1 or not isinstance(payload.get("catalog_version"), str)
            or not payload["catalog_version"] or not isinstance(names, list)
            or not isinstance(worker_version, str) or not _SHA256.fullmatch(worker_version)
            or not isinstance(applied_version, str) or not _SHA256.fullmatch(applied_version)
            or payload.get("worker_catalog_digest_algorithm") != WORKER_CATALOG_DIGEST_ALGORITHM
            or payload.get("applied_tool_view_digest_algorithm") != APPLIED_TOOL_VIEW_DIGEST_ALGORITHM
            or not isinstance(required, list) or len(names) > 128 or len(required) > 128
            or any(not isinstance(n, str) or not _NAME.fullmatch(n) for n in names + required)
            or len(set(names)) != len(names) or not set(required).issubset(names)
            or set(names) & _UNSUPPORTED_BRIDGES):
        raise ToolViewError("invalid_tool_view_payload")
    expiry = payload.get("expires_at")
    current = time.time() if now is None else now
    if (not isinstance(expiry, (int, float)) or isinstance(expiry, bool)
            or (check_freshness and (expiry <= current or expiry > current + 300))):
        raise ToolViewError("expired_tool_view")
    digest = hashlib.sha256(user_message.encode("utf-8")).hexdigest()
    if payload.get("input_sha256") != digest:
        raise ToolViewError("tool_view_input_mismatch")
    return {
        "version": 1,
        "catalog_version": payload["catalog_version"],
        "worker_catalog_sha256": worker_version,
        "worker_catalog_digest_algorithm": WORKER_CATALOG_DIGEST_ALGORITHM,
        "applied_tool_view_sha256": applied_version,
        "applied_tool_view_digest_algorithm": APPLIED_TOOL_VIEW_DIGEST_ALGORITHM,
        "tool_names": frozenset(names),
        "required_tool_names": frozenset(required),
    }


def retained_durable_replay(store: Any, record: Any, *, now: float | None = None) -> bool:
    """Conservative replay bound for a scoped, matching native idempotency row.

    The caller must first obtain ``record`` from Hermes' scope/key/fingerprint
    lookup. Phase 4 binds the API's retained reconciliation horizon into the
    native row; never substitute the upstream fixed 24-hour age heuristic.
    """
    if not store.durable or not isinstance(record, dict):
        return False
    updated_at = record.get("updated_at")
    retention_until = record.get("retention_until")
    if (not isinstance(updated_at, (int, float)) or isinstance(updated_at, bool)
            or not isinstance(retention_until, (int, float))
            or isinstance(retention_until, bool) or retention_until <= 0):
        return False
    observed_now = time.time() if now is None else now
    return isinstance(observed_now, (int, float)) and not isinstance(observed_now, bool) \
        and observed_now >= updated_at and observed_now < retention_until


def filter_tool_schemas(schemas: Any, allowed: frozenset[str]) -> list[dict[str, Any]]:
    if schemas is None:
        return []
    if not isinstance(schemas, list):
        raise ToolViewError("invalid_worker_tool_schema")
    result = []
    for schema in schemas:
        function = schema.get("function") if isinstance(schema, dict) else None
        name = function.get("name") if isinstance(function, dict) else None
        if not isinstance(name, str):
            raise ToolViewError("invalid_worker_tool_schema")
        if name in allowed:
            result.append(schema)
    return result


def apply_agent_tool_view(agent: Any, view: dict[str, Any]) -> None:
    """Install a per-agent snapshot from the exact registered raw catalog."""
    allowed = view["tool_names"]
    # Hermes' progressive tool_search may have deferred plugin schemas behind
    # a generic discovery tool in agent.tools. A signed required Meri tool must
    # be model-visible for this run, so compile from the same registry's raw
    # enabled/disabled snapshot before progressive disclosure, then intersect
    # with the signed view. Run-local additions outside that registry cannot
    # be versioned by this handshake and therefore fail closed.
    raw_by_name = _assert_worker_catalog(agent, view)
    visible_by_name = {name: raw_by_name[name] for name in allowed}
    for tool in filter_tool_schemas(agent.tools, allowed):
        name = tool["function"]["name"]
        if visible_by_name[name] != tool:
            raise ToolViewError("conflicting_worker_tool_schema")
    visible = [visible_by_name[name] for name in sorted(visible_by_name)]
    if not hmac.compare_digest(_applied_tool_view_digest(visible),
                               view["applied_tool_view_sha256"]):
        raise ToolViewError("applied_tool_view_mismatch")
    names = frozenset(tool["function"]["name"] for tool in visible)
    if not view["required_tool_names"].issubset(names):
        raise ToolViewError("required_tool_unavailable_in_worker")
    agent._meri_tool_view_v1 = {
        **view,
        "selected_schema_sha256": {name: _schema_digest(tool)
                                   for name, tool in visible_by_name.items()},
    }
    agent.tools = visible
    agent.valid_tool_names = set(names)
    agent._tool_search_scope_cache = None


def filter_agent_tool_view(agent: Any, schemas: Any = None) -> Any:
    """Reapply after MCP/registry refresh, before every provider request."""
    view = getattr(agent, "_meri_tool_view_v1", None)
    if view is None:
        return schemas
    _assert_worker_catalog(agent, view)
    expected = view["selected_schema_sha256"]
    _assert_selected_schemas(agent.tools, expected)
    _assert_selected_schemas(schemas, expected)
    allowed = view["tool_names"]
    agent.tools = filter_tool_schemas(agent.tools, allowed)
    agent.valid_tool_names = {tool["function"]["name"] for tool in agent.tools}
    return filter_tool_schemas(schemas, allowed) if schemas is not None else None


def tool_name_allowed(agent: Any, name: str) -> bool:
    view = getattr(agent, "_meri_tool_view_v1", None)
    if view is not None:
        _assert_worker_catalog(agent, view)
    return view is None or (name in view["tool_names"] and name in agent.valid_tool_names)


def assert_provider_tool_payload(kwargs: Any, allowed: frozenset[str],
                                 expected_schemas: dict[str, str] | None = None) -> frozenset[str]:
    """Fail closed if request middleware reintroduces a provider-visible tool."""
    if not isinstance(kwargs, dict):
        raise ToolViewError("invalid_provider_request")
    if "functions" in kwargs or "toolConfig" in kwargs:
        raise ToolViewError("unsupported_provider_tool_shape")
    extra = kwargs.get("extra_body")
    if isinstance(extra, dict) and any(key in extra for key in ("tools", "functions", "toolConfig")):
        raise ToolViewError("unsupported_provider_tool_shape")
    tools = kwargs.get("tools")
    if tools is None:
        return frozenset()
    if not isinstance(tools, list):
        raise ToolViewError("invalid_provider_tool_schema")
    names = set()
    for tool in tools:
        if not isinstance(tool, dict):
            raise ToolViewError("invalid_provider_tool_schema")
        function = tool.get("function")
        if isinstance(function, dict):
            name = function.get("name")
        else:
            name = tool.get("name")
        if not isinstance(name, str) or name not in allowed:
            raise ToolViewError("provider_tool_outside_view")
        if expected_schemas is not None and _schema_digest(tool) != expected_schemas.get(name):
            raise ToolViewError("changed_worker_tool_schema")
        names.add(name)
    return frozenset(names)


def assert_final_provider_tool_payload(agent: Any, kwargs: Any) -> None:
    """Called at each chat transport attempt after hooks and relay rewrites."""
    from meri_claim_attestation_v1 import assert_phase4_launch_authorized
    assert_phase4_launch_authorized(agent)
    view = getattr(agent, "_meri_tool_view_v1", None)
    if view is None:
        return
    if getattr(agent, "api_mode", None) != "chat_completions" or getattr(agent, "provider", None) != "custom":
        raise ToolViewError("unsupported_tool_view_provider")
    _assert_worker_catalog(agent, view)
    expected = view.get("selected_schema_sha256")
    if not isinstance(expected, dict):
        raise ToolViewError("invalid_tool_view_payload")
    visible = assert_provider_tool_payload(kwargs, view["tool_names"], expected)
    if not view["required_tool_names"].issubset(visible):
        raise ToolViewError("required_tool_missing_from_provider_request")
    schemas = kwargs.get("tools") or []
    if not hmac.compare_digest(_applied_tool_view_digest(schemas),
                               view["applied_tool_view_sha256"]):
        raise ToolViewError("applied_tool_view_mismatch")


def assert_narrowed_runtime_supported(agent: Any) -> None:
    """A provider/mode switch cannot escape the custom chat transport gate."""
    from meri_claim_attestation_v1 import assert_phase4_launch_authorized
    assert_phase4_launch_authorized(agent)
    if getattr(agent, "_meri_tool_view_v1", None) is not None and (
        getattr(agent, "api_mode", None) != "chat_completions"
        or getattr(agent, "provider", None) != "custom"
    ):
        raise ToolViewError("unsupported_tool_view_provider")
