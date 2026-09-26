"""Apply the Meri tool-view prototype only to the checksum-pinned Hermes tag.

This runs at image build time against /opt/hermes (never a mutable worker
profile). Exact file hashes and one-occurrence anchors make upstream drift a
hard build failure instead of silently installing a partial security control.
"""
from __future__ import annotations

import hashlib
import pathlib
import sys


PINNED = {
    "gateway/platforms/api_server_runs.py": "dd7303663f8062ece1a08b03b2010a7737500162c9b1e7a7f5e802b4b80504c0",
    # Native scope/key/fingerprint lookup and durable retention semantics used by replay.
    "gateway/platforms/api_server_run_idempotency.py": "c3f25711695a5aad97b207581e0c532d1291bb9f12ca3c1e32add19e5f0f153a",
    "gateway/platforms/api_server.py": "7ec405dc2a59789582ad9f61a189a41079e621f14642d3c9dc754e312616a868",
    "gateway/run.py": "ab619aa0dc193c6d8741f3cabc9a028c2fb7459c22262c69597b0e872091bde5",
    "agent/tool_executor.py": "9634ebdc01b12591753fa9a1653f4aa8937edde7130175bbd69be8a0e5895ab7",
    "agent/turn_api_request.py": "524b412e8ae4bee7760994d90386ee54f2260b03db8ce73460e861ddeaaa9542",
    "agent/chat_completion_helpers.py": "af69c5001fa0de6cb637d6999191045d12410affd41d862d6bbaa3f0db6a24a3",
    "agent/background_review.py": "17551ad59cb5aa2d0a0da260de96eef3790fec786a6d0b8043ac8e8eb29d8651",
    "agent/model_metadata.py": "f340e4d8ae3ef1c451bbfef47a4cfec65bf0615b2a54940c58e825975b7f7704",
    "hermes_cli/plugins_dispatch.py": "6de218e8b72e9717a5bfba701e54595b21c9f89a6dd78a938c72140bf5ab0501",
    # Read-only dependencies of the catalog handshake and final schema check.
    "model_tools.py": "c99620c824ab59f341ac7d0e22cde016b0c469d0643e7a5a5a82e0d63176e4b5",
    "agent/agent_init.py": "d1a1df8dc03a1381a9fd7591d4293e912fb1cb0fa2c1370f8c72a7500acb824a",
    "agent/transports/chat_completions.py": "87f392e9ba5317edaff4f470d523befb380f23c47cbb18de728105a912eec60d",
    "tools/delegate_tool.py": "8d2d684eda36dfa2b8371da814522d9b08c686105969eef366d265ae6f9e50f2",
}


def replace_once(source: str, old: str, new: str, path: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one anchor, found {count}: {old[:80]!r}")
    return source.replace(old, new, 1)


def patch_runs(source: str) -> str:
    path = "gateway/platforms/api_server_runs.py"
    source = replace_once(source,
        '        ("POST", "/v1/runs/{run_id}/stop", self._handle_stop_run)]\n',
        '        ("POST", "/v1/runs/{run_id}/stop", self._handle_stop_run),\n'
        '        ("POST", "/v1/meri/phase4/reservations/lookup-or-seal",\n'
        '         self._handle_reservation_recovery)]\n', path)
    source = replace_once(source,
        '    gateway_session_key, key_err = self._parse_session_key_header(request)\n'
        '    if key_err is not None:\n'
        '        return key_err\n'
        '    try:\n'
        '        body = await request.json()\n'
        '    except Exception:\n'
        '        return _json_error(_openai_error, "Invalid JSON", status=400)\n',
        '    phase4_claim_enabled = os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1"\n'
        '    if phase4_claim_enabled:\n'
        '        canonical_headers = ("Content-Type", "X-Hermes-Session-Key",\n'
        '                             "Idempotency-Key", "X-Meri-Dispatch-Gate-Bearer")\n'
        '        if (request.method != "POST" or request.path != "/v1/runs"\n'
        '                or request.query_string != ""\n'
        '                or any(len(request.headers.getall(name, [])) != 1\n'
        '                       for name in canonical_headers)\n'
        '                or request.headers.get("Content-Type", "") != "application/json"\n'
        '                or bool(request.headers.getall("Content-Encoding", []))):\n'
        '            return _json_error(_openai_error, "Noncanonical Phase 4 ingress",\n'
        '                               code="noncanonical_phase4_claim_ingress", status=400)\n'
        '    gateway_session_key, key_err = self._parse_session_key_header(request)\n'
        '    if key_err is not None:\n'
        '        return key_err\n'
        '    try:\n'
        '        # Freeze the exact received bytes before parsing; the API authenticates these bytes.\n'
        '        raw_request_body = await request.read()\n'
        '        body = json.loads(raw_request_body.decode("utf-8"))\n'
        '        if not isinstance(body, dict):\n'
        '            raise ValueError("request body must be an object")\n'
        '    except Exception:\n'
        '        return _json_error(_openai_error, "Invalid JSON", status=400)\n', path)
    source = replace_once(source,
        '    body, room_error = await self._normalize_room_dispatch(request, body)\n',
        '    if phase4_claim_enabled and (\n'
        '            any(field in body for field in ("provider", "model_options",\n'
        '                "hosted_room_dispatch", "_room_execution_policy"))\n'
        '            or ("model" in body and body.get("model") != self._model_name)):\n'
        '        return _json_error(_openai_error, "Guarded runs use the provisioned runtime",\n'
        '                           code="noncanonical_phase4_runtime_selection", status=400)\n'
        '    if phase4_claim_enabled:\n'
        '        room_error = None\n'
        '    else:\n'
        '        body, room_error = await self._normalize_room_dispatch(request, body)\n', path)
    source = replace_once(source,
        '    route = self._resolve_route(body.get("model"))\n'
        '    agent_overrides = _api_server._request_agent_overrides(body, virtual_model=self._model_name)\n',
        '    route = None if phase4_claim_enabled else self._resolve_route(body.get("model"))\n'
        '    agent_overrides = ({} if phase4_claim_enabled else\n'
        '        _api_server._request_agent_overrides(body, virtual_model=self._model_name))\n', path)
    source = replace_once(source,
        '    idempotency_scope = idempotency_fingerprint = ""\n'
        '    if idempotency_key:\n'
        '        idempotency_scope = self._run_idempotency_scope(request)\n'
        '        idempotency_fingerprint = hashlib.sha256(json.dumps(\n'
        '            {"body": body, "gateway_session_key": gateway_session_key or ""},\n'
        '            sort_keys=True, separators=(",", ":"), ensure_ascii=False,\n'
        '        ).encode()).hexdigest()\n',
        '    idempotency_scope = idempotency_fingerprint = ""\n'
        '    if idempotency_key:\n'
        '        idempotency_scope = self._run_idempotency_scope(request)\n'
        '        if phase4_claim_enabled:\n'
        '            from meri_claim_attestation_v1 import phase4_worker_idempotency_fingerprint\n'
        '            idempotency_fingerprint = phase4_worker_idempotency_fingerprint(\n'
        '                raw_body=raw_request_body, received_method=request.method,\n'
        '                received_path=request.path,\n'
        '                received_content_type=request.headers.get("Content-Type", ""),\n'
        '                session_header_value=request.headers.get("X-Hermes-Session-Key", ""),\n'
        '                idempotency_key_header_value=request.headers.get("Idempotency-Key", ""),\n'
        '                dispatch_gate_bearer_header_value=request.headers.get(\n'
        '                    "X-Meri-Dispatch-Gate-Bearer", ""))\n'
        '        else:\n'
        '            idempotency_fingerprint = hashlib.sha256(json.dumps(\n'
        '                {"body": body, "gateway_session_key": gateway_session_key or ""},\n'
        '                sort_keys=True, separators=(",", ":"), ensure_ascii=False,\n'
        '            ).encode()).hexdigest()\n', path)
    source = replace_once(source,
        '    if not user_message:\n        return _json_error(_openai_error, "No user message found in input", status=400)\n',
        '    if not user_message:\n        return _json_error(_openai_error, "No user message found in input", status=400)\n'
        '    meri_tool_view = None\n'
        '    if phase4_claim_enabled:\n'
        '        from meri_claim_attestation_v1 import (\n'
        '            Phase4ClaimError, phase4_native_retention_until,\n'
        '            validate_phase4_dispatch_bearer)\n'
        '        if "meri_tool_view_v1" not in body:\n'
        '            return _json_error(_openai_error, "Signed tool view is required",\n'
        '                               code="phase4_tool_view_required", status=400)\n'
        '        try:\n'
        '            phase4_bearer_claims = validate_phase4_dispatch_bearer(\n'
        '                request.headers.get("X-Meri-Dispatch-Gate-Bearer", ""))\n'
        '            _remember_room_retention(request, {"status_expires_at":\n'
        '                phase4_native_retention_until(phase4_bearer_claims)})\n'
        '        except Phase4ClaimError as exc:\n'
        '            return _json_error(_openai_error, str(exc),\n'
        '                               code="invalid_phase4_dispatch_bearer", status=400)\n'
        '    if "meri_tool_view_v1" in body:\n'
        '        from meri_tool_view_v1 import ToolViewError, verify_tool_view\n'
        '        try:\n'
        '            # Authenticate the exact signed body before the scoped idempotency lookup.\n'
        '            # An admitted replay may outlive this request token or catalog snapshot.\n'
        '            meri_tool_view = verify_tool_view(body["meri_tool_view_v1"],\n'
        '                                              user_message=user_message, check_freshness=False)\n'
        '        except ToolViewError as exc:\n'
        '            return _json_error(_openai_error, str(exc), code="invalid_meri_tool_view", status=400)\n'
        '    if meri_tool_view is not None and idempotency_key:\n'
        '        # This is the native authenticated scope/key/whole-body fingerprint.\n'
        '        # A retained hit needs no new route, token expiry or catalog admission.\n'
        '        outcome, record = self._run_idempotency_store.lookup(\n'
        '            idempotency_scope, idempotency_key, idempotency_fingerprint,\n'
        '            retention_until=_room_retention_until(request),\n'
        '            dispatch_request_sha256=(phase4_bearer_claims["requestSha256"]\n'
        '                if phase4_claim_enabled else ""))\n'
        '        if outcome in ("conflict", "sealed_absent"):\n'
        '            return _replay_or_conflict(self, request, outcome, record, gateway_session_key, _openai_error)\n'
        '        if outcome == "reused" and record is not None:\n'
        '            from meri_tool_view_v1 import retained_durable_replay\n'
        '            if not retained_durable_replay(self._run_idempotency_store, record):\n'
        '                return _json_error(_openai_error, "Signed replay is outside durable retention",\n'
        '                                   code="signed_replay_unavailable", status=409)\n'
        '            return _replay_or_conflict(self, request, outcome, record, gateway_session_key, _openai_error)\n', path)
    source = replace_once(source,
        '    if idempotency_key:\n'
        '        outcome, record = self._run_idempotency_store.lookup(\n'
        '            idempotency_scope, idempotency_key, idempotency_fingerprint,\n'
        '            retention_until=_room_retention_until(request))\n',
        '    if idempotency_key:\n'
        '        outcome, record = self._run_idempotency_store.lookup(\n'
        '            idempotency_scope, idempotency_key, idempotency_fingerprint,\n'
        '            retention_until=_room_retention_until(request),\n'
        '            dispatch_request_sha256=(phase4_bearer_claims["requestSha256"]\n'
        '                if phase4_claim_enabled else ""))\n', path)
    source = replace_once(source,
        '        if outcome == "conflict" or (outcome == "reused" and record is not None):\n'
        '            return _replay_or_conflict(self, request, outcome, record, gateway_session_key, _openai_error)\n'
        '    # Enforce concurrency only for a genuinely new run.\n',
        '        if outcome in ("conflict", "sealed_absent") or (\n'
        '                outcome == "reused" and record is not None):\n'
        '            if meri_tool_view is not None and outcome == "reused":\n'
        '                from meri_tool_view_v1 import retained_durable_replay\n'
        '                if not retained_durable_replay(self._run_idempotency_store, record):\n'
        '                    return _json_error(_openai_error, "Signed replay is outside durable retention",\n'
        '                                       code="signed_replay_unavailable", status=409)\n'
        '            return _replay_or_conflict(self, request, outcome, record, gateway_session_key, _openai_error)\n'
        '    if meri_tool_view is not None:\n'
        '        try:\n'
        '            # A key MISS must meet the current expiry. Catalog is checked during agent creation.\n'
        '            meri_tool_view = verify_tool_view(body["meri_tool_view_v1"], user_message=user_message)\n'
        '        except ToolViewError as exc:\n'
        '            return _json_error(_openai_error, str(exc), code="invalid_meri_tool_view", status=400)\n'
        '    # Enforce concurrency only for a genuinely new run.\n', path)
    source = replace_once(source,
        '        if outcome != "created":\n'
        '            _forget_run(\n'
        '                self, run_id, self._run_streams, self._run_streams_created, self._run_approval_sessions,\n'
        '                self._run_statuses, self._run_owners)\n'
        '            return _replay_or_conflict(self, request, outcome, record, gateway_session_key, _openai_error)\n',
        '        if outcome != "created":\n'
        '            _forget_run(\n'
        '                self, run_id, self._run_streams, self._run_streams_created, self._run_approval_sessions,\n'
        '                self._run_statuses, self._run_owners)\n'
        '            if meri_tool_view is not None and outcome == "reused":\n'
        '                from meri_tool_view_v1 import retained_durable_replay\n'
        '                if not retained_durable_replay(self._run_idempotency_store, record):\n'
        '                    return _json_error(_openai_error, "Signed replay is outside durable retention",\n'
        '                                       code="signed_replay_unavailable", status=409)\n'
        '            return _replay_or_conflict(self, request, outcome, record, gateway_session_key, _openai_error)\n', path)
    source = replace_once(source,
        '    if idempotency_key:\n'
        '        outcome, record = self._run_idempotency_store.reserve(\n'
        '            idempotency_scope, idempotency_key, idempotency_fingerprint, run_id, initial_status,\n',
        '    meri_phase4_claim_context = None\n'
        '    if phase4_claim_enabled:\n'
        '        from meri_claim_attestation_v1 import (\n'
        '            Phase4ClaimError, capture_phase4_claim_context)\n'
        '        try:\n'
        '            meri_phase4_claim_context = capture_phase4_claim_context(\n'
        '                bearer=request.headers.get("X-Meri-Dispatch-Gate-Bearer", ""),\n'
        '                raw_body=raw_request_body, received_method=request.method,\n'
        '                received_path=request.path,\n'
        '                received_content_type=request.headers.get("Content-Type", ""),\n'
        '                session_header_value=request.headers.get("X-Hermes-Session-Key", ""),\n'
        '                idempotency_key_header_value=request.headers.get("Idempotency-Key", ""),\n'
        '                worker_run_id=run_id)\n'
        '        except Phase4ClaimError as exc:\n'
        '            _forget_run(\n'
        '                self, run_id, self._run_streams, self._run_streams_created,\n'
        '                self._run_approval_sessions, self._run_statuses, self._run_owners)\n'
        '            return _json_error(_openai_error, str(exc), code="invalid_phase4_claim", status=400)\n'
        '    if idempotency_key:\n'
        '        outcome, record = self._run_idempotency_store.reserve(\n'
        '            idempotency_scope, idempotency_key, idempotency_fingerprint, run_id, initial_status,\n', path)
    source = replace_once(source,
        '            owner_pid=self._run_owner_pid, owner_started=self._run_owner_started,\n'
        '            retention_until=_room_retention_until(request))\n',
        '            owner_pid=self._run_owner_pid, owner_started=self._run_owner_started,\n'
        '            retention_until=_room_retention_until(request),\n'
        '            dispatch_request_sha256=(phase4_bearer_claims["requestSha256"]\n'
        '                if phase4_claim_enabled else ""))\n', path)
    source = replace_once(source,
        '    if outcome == "conflict":\n'
        '        return _json_error(\n'
        '            _openai_error, "Idempotency-Key was already used with a different request payload",\n'
        '            code="idempotency_key_conflict", status=409)\n',
        '    if outcome == "sealed_absent":\n'
        '        return _json_error(\n'
        '            _openai_error, "This Phase 4 dispatch was durably sealed absent",\n'
        '            code="phase4_dispatch_sealed_absent", status=409)\n'
        '    if outcome == "conflict":\n'
        '        return _json_error(\n'
        '            _openai_error, "Idempotency-Key was already used with a different request payload",\n'
        '            code="idempotency_key_conflict", status=409)\n', path)
    source = replace_once(source,
        '            route=route, room_dispatch=room_dispatch, room_execution_policy=room_execution_policy,\n',
        '            route=route, room_dispatch=room_dispatch, room_execution_policy=room_execution_policy,\n'
        '            confirmed_runtime_lock=phase4_claim_enabled,\n'
        '            meri_tool_view=meri_tool_view,\n', path)
    source = replace_once(source,
        '            meri_tool_view=meri_tool_view,\n',
        '            meri_tool_view=meri_tool_view,\n'
        '            meri_phase4_claim_context=meri_phase4_claim_context,\n', path)
    source = replace_once(source,
        '        self._active_run_agents[run_id] = agent\n'
        '        approval_notify = _make_approval_notify(self, run, _api_server=_api_server)\n',
        '        phase4_gate = getattr(agent, "_meri_phase4_claim_gate_v1", None)\n'
        '        if phase4_gate is not None:\n'
        '            # One bounded claim before _run_agent_sync and the patched transport/tool paths.\n'
        '            await loop.run_in_executor(\n'
        '                None, lambda: phase4_gate.authorize(agent, agent._meri_tool_view_v1))\n'
        '        if run_id in self._stopping_run_ids:\n'
        '            _finish("cancelled")\n'
        '            return\n'
        '        self._active_run_agents[run_id] = agent\n'
        '        approval_notify = _make_approval_notify(self, run, _api_server=_api_server)\n', path)
    source = replace_once(source,
        '    run_id, _, _, _, err = _load_owned_run(\n'
        '        self, request, _api_server=_api_server, permission="approve", active_fallback=False)\n'
        '    if err is not None:\n'
        '        return err\n',
        '    run_id, _, agent, _, err = _load_owned_run(\n'
        '        self, request, _api_server=_api_server, permission="approve", active_fallback=False)\n'
        '    if err is not None:\n'
        '        return err\n'
        '    try:\n'
        '        from meri_claim_attestation_v1 import assert_phase4_launch_authorized\n'
        '        assert_phase4_launch_authorized(agent)\n'
        '    except Exception:\n'
        '        return _json_error(_openai_error, "Run claim is not authorized",\n'
        '                           code="phase4_claim_not_authorized", status=409)\n', path)
    source = replace_once(source,
        '    # /stop keeps agent refs during cooperative shutdown, so the status gate (not the\n'
        '    # agent ref) is what rejects stop-then-steer.\n',
        '    try:\n'
        '        from meri_claim_attestation_v1 import assert_phase4_launch_authorized\n'
        '        assert_phase4_launch_authorized(agent)\n'
        '    except Exception:\n'
        '        return _json_error(_openai_error, "Run claim is not authorized",\n'
        '                           code="phase4_claim_not_authorized", status=409)\n'
        '    # /stop keeps agent refs during cooperative shutdown, so the status gate (not the\n'
        '    # agent ref) is what rejects stop-then-steer.\n', path)
    source = replace_once(source,
        'async def _handle_get_run(self, request: "web.Request", *, _api_server) -> "web.Response":\n'
        '    """GET /v1/runs/{run_id} — return pollable run status for external UIs."""\n'
        '    _, status, _, _, err = _load_owned_run(\n'
        '        self, request, _api_server=_api_server, permission="status", active_fallback=True)\n'
        '    return err or web.json_response(status)\n',
        'async def _handle_get_run(self, request: "web.Request", *, _api_server) -> "web.Response":\n'
        '    """GET /v1/runs/{run_id} — return pollable run status for external UIs."""\n'
        '    recovery = None\n'
        '    if os.environ.get("MERI_PHASE4_RECOVERY_V1_ENABLED") == "1":\n'
        '        try:\n'
        '            from meri_recovery_runtime_v1 import authorize_recovery_request_v1\n'
        '            recovery = authorize_recovery_request_v1(\n'
        '                command_header_values=request.headers.getall(\n'
        '                    "X-Meri-Dispatch-Recovery-Command", []),\n'
        '                authorization_header_values=request.headers.getall("Authorization", []),\n'
        '                method=request.method, path=request.path,\n'
        '                query_string=request.query_string, body=await request.read(),\n'
        '                expected_worker_run_id=request.match_info["run_id"])\n'
        '        except Exception:\n'
        '            return _json_error(_api_server._openai_error, "Recovery request rejected",\n'
        '                               code="invalid_recovery_command", status=401)\n'
        '    _, status, _, _, err = _load_owned_run(\n'
        '        self, request, _api_server=_api_server, permission="status", active_fallback=True)\n'
        '    response = err or web.json_response(status)\n'
        '    if recovery is not None:\n'
        '        try:\n'
        '            from meri_recovery_runtime_v1 import (\n'
        '                RECOVERY_RECEIPT_HEADER, sign_recovery_response_v1)\n'
        '            response.headers[RECOVERY_RECEIPT_HEADER] = sign_recovery_response_v1(\n'
        '                recovery, native_http_status=response.status,\n'
        '                native_response_body=bytes(response.body or b""))\n'
        '        except Exception:\n'
        '            return _json_error(_api_server._openai_error, "Recovery receipt unavailable",\n'
        '                               code="recovery_receipt_unavailable", status=503)\n'
        '    return response\n', path)
    source = replace_once(source,
        'async def _handle_stop_run(self, request: "web.Request", *, _api_server) -> "web.Response":\n'
        '    """POST /v1/runs/{run_id}/stop — interrupt a running agent."""\n'
        '    _openai_error = _api_server._openai_error\n'
        '    run_id, status, agent, task, err = _load_owned_run(\n'
        '        self, request, _api_server=_api_server, permission="stop", active_fallback=True)\n'
        '    if err is not None:\n'
        '        return err\n'
        '    if status.get("status") in TERMINAL_STATUSES:\n'
        '        return web.json_response(status)\n'
        '    if agent is None and task is None:\n'
        '        return _json_error(\n'
        '            _openai_error, f"Run is not active in this gateway process: {run_id}",\n'
        '            code="run_not_active", status=409)\n'
        '    self._set_run_status(run_id, "stopping", last_event="run.stopping")\n'
        '    self._stopping_run_ids.add(run_id)\n'
        '    if agent is not None:\n'
        '        with suppress(Exception):\n'
        '            _api_server.request_hard_interrupt(agent, "Stop requested via API")\n'
        '        # Reap only this run\'s background processes (epoch-gated inside, so a concurrent\n'
        '        # run on the same session_id keeps its own); no-op if the run already finished.\n'
        '        _api_server._reap_disconnected_agent_processes(agent, source="api_server_run_stop")\n'
        '    return web.json_response({"run_id": run_id, "status": "stopping"})\n',
        'async def _handle_stop_run(self, request: "web.Request", *, _api_server) -> "web.Response":\n'
        '    """POST /v1/runs/{run_id}/stop — interrupt a running agent."""\n'
        '    _openai_error = _api_server._openai_error\n'
        '    recovery = None\n'
        '    if os.environ.get("MERI_PHASE4_RECOVERY_V1_ENABLED") == "1":\n'
        '        try:\n'
        '            from meri_recovery_runtime_v1 import authorize_recovery_request_v1\n'
        '            recovery = authorize_recovery_request_v1(\n'
        '                command_header_values=request.headers.getall(\n'
        '                    "X-Meri-Dispatch-Recovery-Command", []),\n'
        '                authorization_header_values=request.headers.getall("Authorization", []),\n'
        '                method=request.method, path=request.path,\n'
        '                query_string=request.query_string, body=await request.read(),\n'
        '                expected_worker_run_id=request.match_info["run_id"])\n'
        '        except Exception:\n'
        '            return _json_error(_openai_error, "Recovery request rejected",\n'
        '                               code="invalid_recovery_command", status=401)\n'
        '    run_id, status, agent, task, err = _load_owned_run(\n'
        '        self, request, _api_server=_api_server, permission="stop", active_fallback=True)\n'
        '    stop_effect_started = False\n'
        '    if err is not None:\n'
        '        response = err\n'
        '    elif status.get("status") in TERMINAL_STATUSES:\n'
        '        response = web.json_response(status)\n'
        '    elif agent is None and task is None:\n'
        '        response = _json_error(\n'
        '            _openai_error, f"Run is not active in this gateway process: {run_id}",\n'
        '            code="run_not_active", status=409)\n'
        '    else:\n'
        '        stop_effect_started = True\n'
        '        self._set_run_status(run_id, "stopping", last_event="run.stopping")\n'
        '        self._stopping_run_ids.add(run_id)\n'
        '        if agent is not None:\n'
        '            with suppress(Exception):\n'
        '                _api_server.request_hard_interrupt(agent, "Stop requested via API")\n'
        '            # Reap only this run\'s background processes (epoch-gated inside, so a concurrent\n'
        '            # run on the same session_id keeps its own); no-op if the run already finished.\n'
        '            _api_server._reap_disconnected_agent_processes(\n'
        '                agent, source="api_server_run_stop")\n'
        '        response = web.json_response({"run_id": run_id, "status": "stopping"})\n'
        '    if recovery is not None:\n'
        '        try:\n'
        '            from meri_recovery_runtime_v1 import (\n'
        '                RECOVERY_RECEIPT_HEADER, sign_recovery_response_v1)\n'
        '            response.headers[RECOVERY_RECEIPT_HEADER] = sign_recovery_response_v1(\n'
        '                recovery, native_http_status=response.status,\n'
        '                native_response_body=bytes(response.body or b""))\n'
        '        except Exception:\n'
        '            if stop_effect_started:\n'
        '                return _json_error(_openai_error, "Recovery receipt unavailable",\n'
        '                                   code="recovery_receipt_unavailable", status=503)\n'
        '    return response\n', path)
    source = replace_once(source,
        'async def _handle_get_run(self, request: "web.Request", *, _api_server) -> "web.Response":\n'
        '    """GET /v1/runs/{run_id} — return pollable run status for external UIs."""\n'
        '    recovery = None\n',
        'async def _handle_reservation_recovery(\n'
        '        self, request: "web.Request", *, _api_server) -> "web.Response":\n'
        '    """Return one signed reservation or install one late-POST tombstone."""\n'
        '    if os.environ.get("MERI_PHASE4_RESERVATION_RECOVERY_V1_ENABLED") != "1":\n'
        '        return web.json_response({"error": "not found"}, status=404)\n'
        '    try:\n'
        '        from meri_recovery_runtime_v1 import authorize_reservation_request_v1\n'
        '        authorization = authorize_reservation_request_v1(\n'
        '            command_header_values=request.headers.getall(\n'
        '                "X-Meri-Dispatch-Reservation-Command", []),\n'
        '            authorization_header_values=request.headers.getall("Authorization", []),\n'
        '            method=request.method, path=request.path,\n'
        '            query_string=request.query_string, body=await request.read())\n'
        '    except Exception:\n'
        '        return _json_error(_api_server._openai_error, "Reservation request rejected",\n'
        '                           code="invalid_reservation_command", status=401)\n'
        '    command = authorization.command\n'
        '    try:\n'
        '        outcome, record = self._run_idempotency_store.lookup_or_seal_absent(\n'
        '            self._run_idempotency_scope(request), command["idempotencyKey"],\n'
        '            command["requestSha256"],\n'
        '            not_before=int(command["deliveryNotBeforeEpochMicros"]) / 1_000_000,\n'
        '            retention_until=int(command["retainUntilEpochMicros"]) / 1_000_000)\n'
        '        if outcome == "reused" and record is not None:\n'
        '            response_outcome = "reserved"\n'
        '        elif outcome == "sealed_absent" and record is not None:\n'
        '            response_outcome = "sealed_absent"\n'
        '        else:\n'
        '            return _json_error(\n'
        '                _api_server._openai_error, "Reservation is not authoritative",\n'
        '                code="reservation_not_authoritative", status=409)\n'
        '        if record.get("dispatch_request_sha256") != command["requestSha256"]:\n'
        '            raise RuntimeError("reservation request digest drift")\n'
        '        from meri_reservation_recovery_v1 import reservation_response_bytes_v1\n'
        '        response_body = reservation_response_bytes_v1(\n'
        '            response_outcome, record,\n'
        '            retain_until_epoch_micros=command["retainUntilEpochMicros"])\n'
        '        from meri_recovery_runtime_v1 import (\n'
        '            RESERVATION_RECEIPT_HEADER, sign_reservation_response_v1)\n'
        '        receipt = sign_reservation_response_v1(\n'
        '            authorization, native_http_status=200,\n'
        '            native_response_body=response_body)\n'
        '    except Exception:\n'
        '        return _json_error(_api_server._openai_error, "Reservation receipt unavailable",\n'
        '                           code="reservation_receipt_unavailable", status=503)\n'
        '    return web.Response(\n'
        '        body=response_body, status=200, content_type="application/json",\n'
        '        headers={RESERVATION_RECEIPT_HEADER: receipt})\n'
        '\n'
        '\n'
        'async def _handle_get_run(self, request: "web.Request", *, _api_server) -> "web.Response":\n'
        '    """GET /v1/runs/{run_id} — return pollable run status for external UIs."""\n'
        '    recovery = None\n', path)
    return source


def patch_api_server(source: str) -> str:
    path = "gateway/platforms/api_server.py"
    source = replace_once(source,
        '            return False\n'
        '        try:\n'
        '            mws = [mw for mw in (\n'
        '                self._make_profile_prefix_middleware(), cors_middleware, body_limit_middleware,\n',
        '            return False\n'
        '        if (os.environ.get("MERI_PHASE4_RESERVATION_RECOVERY_V1_ENABLED") == "1"\n'
        '                and (os.environ.get("MERI_PHASE4_RECOVERY_V1_ENABLED") != "1"\n'
        '                     or os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") != "1")):\n'
        '            self._set_fatal_error(\n'
        '                "meri_phase4_reservation_recovery_invalid",\n'
        '                "Phase 4 reservation recovery requires claim and recovery v1.",\n'
        '                retryable=False)\n'
        '            return False\n'
        '        if os.environ.get("MERI_PHASE4_RECOVERY_V1_ENABLED") == "1":\n'
        '            try:\n'
        '                from meri_recovery_runtime_v1 import validate_recovery_runtime_v1\n'
        '                validate_recovery_runtime_v1(native_api_key=self._api_key)\n'
        '            except Exception:\n'
        '                self._set_fatal_error(\n'
        '                    "meri_phase4_recovery_invalid",\n'
        '                    "Phase 4 recovery configuration was rejected.", retryable=False)\n'
        '                return False\n'
        '        try:\n'
        '            mws = [mw for mw in (\n'
        '                self._make_profile_prefix_middleware(), cors_middleware, body_limit_middleware,\n', path)
    source = replace_once(source,
        '    async def _handle_capabilities(self, request: "web.Request") -> "web.Response":\n'
        '        """GET /v1/capabilities — the stable, machine-readable API surface for external UIs."""\n'
        '        return web.json_response({\n',
        '    async def _handle_capabilities(self, request: "web.Request") -> "web.Response":\n'
        '        """GET /v1/capabilities — the stable, machine-readable API surface for external UIs."""\n'
        '        if os.environ.get("MERI_HERMES_TOOL_VIEW_V1_ENABLED") == "1":\n'
        '            from gateway.run import _load_gateway_config\n'
        '            from hermes_cli.tools_config import _get_platform_tools\n'
        '            meri_tool_view_capability = __import__("meri_tool_view_v1").worker_catalog_capability(\n'
        '                enabled_toolsets=sorted(_get_platform_tools(_load_gateway_config(), "api_server")))\n'
        '        else:\n'
        '            meri_tool_view_capability = {"supported": False}\n'
        '        meri_recovery_capability = {\n'
        '            "supported": os.environ.get("MERI_PHASE4_RECOVERY_V1_ENABLED") == "1",\n'
        '            "version": 1,\n'
        '            "command_header": "X-Meri-Dispatch-Recovery-Command",\n'
        '            "receipt_header": "X-Meri-Dispatch-Recovery-Receipt",\n'
        '            "reservation_supported": os.environ.get(\n'
        '                "MERI_PHASE4_RESERVATION_RECOVERY_V1_ENABLED") == "1",\n'
        '            "reservation_command_header":\n'
        '                "X-Meri-Dispatch-Reservation-Command",\n'
        '            "reservation_receipt_header":\n'
        '                "X-Meri-Dispatch-Reservation-Receipt",\n'
        '        }\n'
        '        return web.json_response({\n', path)
    source = replace_once(source,
        '        room_execution_policy: Optional[Dict[str, Any]] = None) -> Any:\n',
        '        room_execution_policy: Optional[Dict[str, Any]] = None,\n'
        '        meri_tool_view: Optional[Dict[str, Any]] = None,\n'
        '        meri_phase4_claim_context: Any = None) -> Any:\n', path)
    source = replace_once(source,
        '        from run_agent import AIAgent\n',
        '        if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1":\n'
        '            if (not confirmed_runtime_lock or requested_model is not None\n'
        '                    or requested_provider is not None or model_options is not None\n'
        '                    or route is not None or session_model is not None\n'
        '                    or room_dispatch is not None or room_execution_policy is not None):\n'
        '                from meri_claim_attestation_v1 import Phase4ClaimError\n'
        '                raise Phase4ClaimError("phase4_claim_runtime_not_locked")\n'
        '        from run_agent import AIAgent\n', path)
    source = replace_once(source,
        '        agent = AIAgent(**agent_kwargs)\n        route_source = (\n',
        '        agent = AIAgent(**agent_kwargs)\n'
        '        if meri_tool_view is not None:\n'
        '            from meri_tool_view_v1 import ToolViewError, apply_agent_tool_view\n'
        '            if agent.api_mode != "chat_completions" or agent.provider != "custom":\n'
        '                raise ToolViewError("unsupported_tool_view_provider")\n'
        '            apply_agent_tool_view(agent, meri_tool_view)\n'
        '        if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1":\n'
        '            if meri_phase4_claim_context is None or meri_tool_view is None:\n'
        '                from meri_claim_attestation_v1 import Phase4ClaimError\n'
        '                raise Phase4ClaimError("phase4_claim_context_required")\n'
        '            from meri_claim_attestation_v1 import Phase4ClaimGate\n'
        '            agent._meri_phase4_claim_gate_v1 = Phase4ClaimGate(meri_phase4_claim_context)\n'
        '        route_source = (\n', path)
    source = replace_once(source,
        '                "runs_idempotency": _api_runs._idempotency_capabilities(self, store_type=RunIdempotencyStore),\n',
        '                "runs_idempotency": _api_runs._idempotency_capabilities(self, store_type=RunIdempotencyStore),\n'
        '                "meri_request_local_tool_view_v1": meri_tool_view_capability,\n', path)
    source = replace_once(source,
        '                "meri_request_local_tool_view_v1": meri_tool_view_capability,\n',
        '                "meri_request_local_tool_view_v1": meri_tool_view_capability,\n'
        '                "meri_phase4_recovery_v1": meri_recovery_capability,\n', path)
    source = replace_once(source,
        '            mws = [mw for mw in (\n'
        '                self._make_profile_prefix_middleware(), cors_middleware, body_limit_middleware,\n'
        '                security_headers_middleware) if mw is not None]\n',
        '            phase4_claim_middleware = (\n'
        '                __import__("meri_claim_attestation_v1").make_phase4_claim_ingress_middleware())\n'
        '            mws = [mw for mw in (\n'
        '                phase4_claim_middleware, self._make_profile_prefix_middleware(),\n'
        '                cors_middleware, body_limit_middleware, security_headers_middleware)\n'
        '                if mw is not None]\n', path)
    source = replace_once(source,
        '    _handle_stop_run = _run_route_delegate("_handle_stop_run")\n',
        '    _handle_stop_run = _run_route_delegate("_handle_stop_run")\n'
        '    _handle_reservation_recovery = _run_route_delegate(\n'
        '        "_handle_reservation_recovery")\n', path)
    return source


def patch_executor(source: str) -> str:
    path = "agent/tool_executor.py"
    return replace_once(source,
        '    block_message, block_error_type = scope_block, "tool_scope_block"\n',
        '    from meri_claim_attestation_v1 import assert_phase4_launch_authorized\n'
        '    assert_phase4_launch_authorized(agent)\n'
        '    from meri_tool_view_v1 import tool_name_allowed\n'
        '    if not tool_name_allowed(agent, ref.name):\n'
        '        scope_block = f"{ref.name} is outside this run\'s tool view"\n'
        '    block_message, block_error_type = scope_block, "tool_scope_block"\n', path)


def patch_request(source: str) -> str:
    path = "agent/turn_api_request.py"
    source = replace_once(source,
        '    agent._reset_stream_delivery_tracking()\n',
        '    from meri_tool_view_v1 import filter_agent_tool_view\n'
        '    tools_for_api = filter_agent_tool_view(agent, tools_for_api)\n'
        '    agent._reset_stream_delivery_tracking()\n', path)
    source = replace_once(source,
        '    if tools_for_api == agent.tools:\n',
        '    tools_for_api = filter_agent_tool_view(agent, tools_for_api)\n'
        '    if tools_for_api == agent.tools:\n', path)
    # Middleware is allowed to remove tools, but never to insert a tool outside
    # the signed view. Supported provider payload shapes must expose a name.
    source = replace_once(source,
        '    _fire_pre_api_request_hook(\n',
        '    if getattr(agent, "_meri_tool_view_v1", None) is not None:\n'
        '        from meri_tool_view_v1 import assert_provider_tool_payload\n'
        '        assert_provider_tool_payload(api_kwargs, agent._meri_tool_view_v1["tool_names"])\n'
        '    _fire_pre_api_request_hook(\n', path)
    return source


def patch_background_review(source: str) -> str:
    path = "agent/background_review.py"
    return replace_once(source,
        '        _inherit_parent_tool_surface(review_agent, agent)\n'
        '    _detach_fork_compression(review_agent)\n',
        '        _inherit_parent_tool_surface(review_agent, agent)\n'
        '    parent_view = getattr(agent, "_meri_tool_view_v1", None)\n'
        '    if parent_view is not None:\n'
        '        from meri_tool_view_v1 import apply_agent_tool_view\n'
        '        apply_agent_tool_view(review_agent, {**parent_view, "required_tool_names": frozenset()})\n'
        '        parent_gate = getattr(agent, "_meri_phase4_claim_gate_v1", None)\n'
        '        if parent_gate is not None:\n'
        '            review_agent._meri_phase4_claim_gate_v1 = parent_gate\n'
        '    _detach_fork_compression(review_agent)\n', path)


def patch_plugins_dispatch(source: str) -> str:
    """Serialize policy callbacks only when the opt-in Meri worker gate is on.

    Hermes normally fail-closes a second pre-tool invocation that arrives while
    the first callback's tiny daemon-thread window is still open. In the opt-in
    worker, wait for that callback's completion within the SAME timeout budget;
    never run it twice, retry a tool, or bypass timeout suppression.
    """
    path = "hermes_cli/plugins_dispatch.py"
    source = replace_once(source, 'import logging\nimport queue\n', 'import logging\nimport os\nimport queue\n', path)
    source = replace_once(source,
        '        token = object()\n'
        '        with self._hook_timeout_lock:\n'
        '            suppressed_until = self._hook_timeout_suppressed_until.get(callback_key)\n'
        '            running = callback_key in self._hook_running_callbacks\n'
        '            if (suppressed_until is not None and suppressed_until > time.monotonic()) or running:\n'
        '                logger.warning(\n'
        '                    "Hook \'%s\' callback %s skipped after previous "\n'
        '                    "timeout or while still running", hook_name, callback_name)\n'
        '                return _HOOK_SKIPPED\n'
        '            if suppressed_until is not None:\n'
        '                self._hook_timeout_suppressed_until.pop(callback_key, None)\n'
        '            self._hook_running_callbacks[callback_key] = token\n',
        '        serialize_policy = (hook_name == "pre_tool_call" and\n'
        '                            os.environ.get("MERI_HERMES_TOOL_VIEW_V1_ENABLED") == "1")\n'
        '        deadline = time.monotonic() + timeout\n'
        '        token = threading.Event()\n'
        '        while True:\n'
        '            with self._hook_timeout_lock:\n'
        '                now = time.monotonic()\n'
        '                suppressed_until = self._hook_timeout_suppressed_until.get(callback_key)\n'
        '                running_token = self._hook_running_callbacks.get(callback_key)\n'
        '                if (suppressed_until is not None and suppressed_until > now):\n'
        '                    logger.warning("Hook \'%s\' callback %s skipped after previous timeout",\n'
        '                                   hook_name, callback_name)\n'
        '                    return _HOOK_SKIPPED\n'
        '                if running_token is None:\n'
        '                    if serialize_policy and now >= deadline:\n'
        '                        logger.warning("Hook \'%s\' callback %s wait budget exhausted",\n'
        '                                       hook_name, callback_name)\n'
        '                        return _HOOK_SKIPPED\n'
        '                    if suppressed_until is not None:\n'
        '                        self._hook_timeout_suppressed_until.pop(callback_key, None)\n'
        '                    self._hook_running_callbacks[callback_key] = token\n'
        '                    break\n'
        '                if not serialize_policy:\n'
        '                    logger.warning("Hook \'%s\' callback %s skipped while still running",\n'
        '                                   hook_name, callback_name)\n'
        '                    return _HOOK_SKIPPED\n'
        '            remaining = deadline - time.monotonic()\n'
        '            if remaining <= 0:\n'
        '                logger.warning("Hook \'%s\' callback %s wait budget exhausted",\n'
        '                               hook_name, callback_name)\n'
        '                return _HOOK_SKIPPED\n'
        '            if isinstance(running_token, threading.Event):\n'
        '                running_token.wait(timeout=remaining)\n'
        '            else:\n'
        '                time.sleep(min(0.01, remaining))\n', path)
    source = replace_once(source,
        '        def _release_token() -> None:\n'
        '            with self._hook_timeout_lock:\n'
        '                if self._hook_running_callbacks.get(callback_key) is token:\n'
        '                    self._hook_running_callbacks.pop(callback_key, None)\n',
        '        def _release_token() -> None:\n'
        '            with self._hook_timeout_lock:\n'
        '                if serialize_policy and outcome.get("completed_at", time.monotonic()) >= deadline:\n'
        '                    # A waiter must not slip between a late callback releasing\n'
        '                    # its token and the caller recording timeout suppression.\n'
        '                    until = time.monotonic() + self._hook_timeout_suppression_seconds\n'
        '                    prior = self._hook_timeout_suppressed_until.get(callback_key, 0.0)\n'
        '                    self._hook_timeout_suppressed_until[callback_key] = max(prior, until)\n'
        '                if self._hook_running_callbacks.get(callback_key) is token:\n'
        '                    self._hook_running_callbacks.pop(callback_key, None)\n'
        '            token.set()\n', path)
    source = replace_once(source,
        '            finally:\n'
        '                _release_token()\n'
        '                done.set()\n',
        '            finally:\n'
        '                outcome["completed_at"] = time.monotonic()\n'
        '                _release_token()\n'
        '                done.set()\n', path)
    source = replace_once(source,
        '        if not done.wait(timeout=timeout):  # do not join — that would reintroduce the hang\n',
        '        wait_budget = max(0.0, deadline - time.monotonic()) if serialize_policy else timeout\n'
        '        if not done.wait(timeout=wait_budget):  # do not join — that would reintroduce the hang\n', path)
    source = replace_once(source,
        '        if "exc" in failure:\n'
        '            raise failure["exc"]\n'
        '        return outcome.get("value")\n',
        '        if serialize_policy and outcome.get("completed_at", float("inf")) >= deadline:\n'
        '            return _HOOK_SKIPPED  # never accept a policy result completed after deadline\n'
        '        if "exc" in failure:\n'
        '            raise failure["exc"]\n'
        '        return outcome.get("value")\n', path)
    return source


def patch_chat_completion_helpers(source: str) -> str:
    path = "agent/chat_completion_helpers.py"
    source = replace_once(source,
        '    if agent.api_mode == "codex_responses":\n'
        '        return agent._run_codex_stream(api_kwargs, client=make_client("codex_stream_request"),\n',
        '    from meri_tool_view_v1 import assert_narrowed_runtime_supported\n'
        '    assert_narrowed_runtime_supported(agent)\n'
        '    if agent.api_mode == "codex_responses":\n'
        '        return agent._run_codex_stream(api_kwargs, client=make_client("codex_stream_request"),\n', path)
    source = replace_once(source,
        '    if agent._interrupt_requested:\n'
        '        raise InterruptedError("Agent interrupted before streaming API call")\n',
        '    from meri_tool_view_v1 import assert_narrowed_runtime_supported\n'
        '    assert_narrowed_runtime_supported(agent)\n'
        '    if agent._interrupt_requested:\n'
        '        raise InterruptedError("Agent interrupted before streaming API call")\n', path)
    source = replace_once(source,
        'def try_activate_fallback(agent, reason: "FailoverReason | None" = None) -> bool:\n'
        '    """Switch to the next fallback model/provider in the chain; False when exhausted. Swaps client,\n'
        '    model slug and provider in place so the retry loop continues on the new backend; client\n'
        '    construction goes through resolve_provider_client (no duplicated provider→key mappings)."""\n',
        'def try_activate_fallback(agent, reason: "FailoverReason | None" = None) -> bool:\n'
        '    """Switch to the next fallback model/provider in the chain; False when exhausted. Swaps client,\n'
        '    model slug and provider in place so the retry loop continues on the new backend; client\n'
        '    construction goes through resolve_provider_client (no duplicated provider→key mappings)."""\n'
        '    if getattr(agent, "_meri_tool_view_v1", None) is not None:\n'
        '        return False  # no fallback may leave the guarded custom/chat transport\n', path)
    # `turn_api_request` runs before the pre-request hook. These three calls
    # are the final OpenAI-wire transport sites, including relay retries.
    source = replace_once(source,
        '        return agent.client.chat.completions.create(**api_kwargs)\n',
        '        from meri_tool_view_v1 import assert_final_provider_tool_payload\n'
        '        assert_final_provider_tool_payload(agent, api_kwargs)\n'
        '        return agent.client.chat.completions.create(**api_kwargs)\n', path)
    source = replace_once(source,
        '    return make_client("chat_completion_request").chat.completions.create(**api_kwargs)\n',
        '    from meri_tool_view_v1 import assert_final_provider_tool_payload\n'
        '    assert_final_provider_tool_payload(agent, api_kwargs)\n'
        '    return make_client("chat_completion_request").chat.completions.create(**api_kwargs)\n', path)
    source = replace_once(source,
        '        return request_client.chat.completions.create(**stream_kwargs)\n',
        '        from meri_tool_view_v1 import assert_final_provider_tool_payload\n'
        '        assert_final_provider_tool_payload(self.agent, stream_kwargs)\n'
        '        return request_client.chat.completions.create(**stream_kwargs)\n', path)
    source = replace_once(source,
        '            agent, api_request_id, summary_kwargs, lambda request: summary_client.chat.completions.create(**request), retry_count=retry_count)\n',
        '            agent, api_request_id, summary_kwargs,\n'
        '            lambda request: _meri_send_checked_summary(agent, summary_client, request), retry_count=retry_count)\n', path)
    source = replace_once(source,
        'def _chat_summary_attempt(agent, api_messages: list, api_request_id: str):\n',
        'def _meri_send_checked_summary(agent, summary_client, request):\n'
        '    from meri_tool_view_v1 import assert_final_provider_tool_payload\n'
        '    assert_final_provider_tool_payload(agent, request)\n'
        '    return summary_client.chat.completions.create(**request)\n'
        '\n'
        'def _chat_summary_attempt(agent, api_messages: list, api_request_id: str):\n', path)
    return source


def patch_gateway_run(source: str) -> str:
    path = "gateway/run.py"
    source = replace_once(source,
        'def _housekeeping_misfire_catch_up(cron_provider, adapters, loop) -> None:\n'
        '    """External cron providers only: fire jobs whose time passed with no external fire delivered (dead\n'
        '    loopback hop). No-op for the built-in ticker; enforces misfire_grace_minutes; CAS claim de-dupes."""\n'
        '    from cron.scheduler_provider import fire_overdue_jobs\n',
        'def _housekeeping_misfire_catch_up(cron_provider, adapters, loop) -> None:\n'
        '    """External cron providers only: fire jobs whose time passed with no external fire delivered (dead\n'
        '    loopback hop). No-op for the built-in ticker; enforces misfire_grace_minutes; CAS claim de-dupes."""\n'
        '    if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1":\n'
        '        return\n'
        '    from cron.scheduler_provider import fire_overdue_jobs\n', path)
    source = replace_once(source,
        'def _housekeeping_curator() -> None:\n'
        '    """maybe_run_curator() is gated by config.interval_hours (7 days default); this is the poll."""\n'
        '    from agent.curator import maybe_run_curator\n',
        'def _housekeeping_curator() -> None:\n'
        '    """maybe_run_curator() is gated by config.interval_hours (7 days default); this is the poll."""\n'
        '    if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1":\n'
        '        return\n'
        '    from agent.curator import maybe_run_curator\n', path)
    source = replace_once(source,
        'def _drain_restart_safe_cron_deliveries(adapters, loop, runner=None) -> None:\n'
        '    """Drain each profile\'s worker queue through its matching live adapters. A credential-less satellite\n'
        '    profile (empty adapter map) drains through the primary\'s adapters routed by its own profile routes."""\n'
        '    from cron import scheduler as cron_scheduler\n',
        'def _drain_restart_safe_cron_deliveries(adapters, loop, runner=None) -> None:\n'
        '    """Drain each profile\'s worker queue through its matching live adapters. A credential-less satellite\n'
        '    profile (empty adapter map) drains through the primary\'s adapters routed by its own profile routes."""\n'
        '    if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1":\n'
        '        return\n'
        '    from cron import scheduler as cron_scheduler\n', path)
    source = replace_once(source,
        '    if isinstance(cron_provider, InProcessCronScheduler):\n'
        '        cron_start_kwargs["can_dispatch"] = lambda: not (\n'
        '            runner._draining or runner._external_drain_active)\n',
        '    if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1":\n'
        '        cron_start_kwargs["can_dispatch"] = lambda: False\n'
        '    elif isinstance(cron_provider, InProcessCronScheduler):\n'
        '        cron_start_kwargs["can_dispatch"] = lambda: not (\n'
        '            runner._draining or runner._external_drain_active)\n', path)
    return source


def patch_model_metadata(source: str) -> str:
    """Make guarded runtime metadata resolution local and deterministic.

    Hermes fingerprints local OpenAI-compatible endpoints while constructing an
    agent.  Those discovery GETs are provider I/O and therefore cannot occur
    before a Phase 4 claim.  The guarded image already requires an explicit,
    bounded context pin, so use that pin everywhere and disable endpoint-type
    discovery while the claim gate is enabled.
    """
    path = "agent/model_metadata.py"
    source = replace_once(source,
        'def detect_local_server_type(base_url: str, api_key: str = "") -> Optional[str]:\n'
        '    """Probe known endpoints: "ollama", "lm-studio", "vllm", "llamacpp", or None (TTL-cached)."""\n'
        '    import httpx\n',
        'def detect_local_server_type(base_url: str, api_key: str = "") -> Optional[str]:\n'
        '    """Probe known endpoints: "ollama", "lm-studio", "vllm", "llamacpp", or None (TTL-cached)."""\n'
        '    if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1":\n'
        '        return None  # no provider discovery is permitted before the Phase 4 claim\n'
        '    import httpx\n', path)
    source = replace_once(source,
        '    # 0. Explicit config override — user knows best\n'
        '    if isinstance(config_context_length, int) and config_context_length > 0:\n'
        '        return config_context_length\n',
        '    if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1":\n'
        '        try:\n'
        '            guarded_context_length = int(os.environ.get("MERI_HERMES_CONTEXT_LENGTH", ""))\n'
        '        except (TypeError, ValueError):\n'
        '            guarded_context_length = 0\n'
        '        if not 64000 <= guarded_context_length <= 4000000:\n'
        '            raise RuntimeError("phase4_claim_context_length_pin_required")\n'
        '        return guarded_context_length\n'
        '    # 0. Explicit config override — user knows best\n'
        '    if isinstance(config_context_length, int) and config_context_length > 0:\n'
        '        return config_context_length\n', path)
    return source


def patch_run_idempotency(source: str) -> str:
    """Fence Phase 4 reservations onto durable storage and the signed horizon."""
    path = "gateway/platforms/api_server_run_idempotency.py"
    source = replace_once(source,
        'import logging\nimport sqlite3\n',
        'import logging\nimport os\nimport sqlite3\n', path)
    source = replace_once(source,
        '    "SELECT fingerprint, run_id, status_json, owner_pid, owner_started, updated_at "\n'
        '    "FROM run_idempotency WHERE scope=? AND idempotency_key=?")\n',
        '    "SELECT fingerprint, run_id, status_json, owner_pid, owner_started, updated_at, "\n'
        '    "retention_until FROM run_idempotency WHERE scope=? AND idempotency_key=?")\n', path)
    source = replace_once(source,
        'def _record(run_id, status_json, owner_pid, owner_started, updated_at) -> dict[str, Any]:\n'
        '    return {\n'
        '        "run_id": run_id, "status": json.loads(status_json), "owner_pid": int(owner_pid or 0),\n'
        '        "owner_started": int(owner_started or 0), "updated_at": float(updated_at or 0)}\n',
        'def _record(run_id, status_json, owner_pid, owner_started, updated_at,\n'
        '            retention_until=0) -> dict[str, Any]:\n'
        '    return {\n'
        '        "run_id": run_id, "status": json.loads(status_json), "owner_pid": int(owner_pid or 0),\n'
        '        "owner_started": int(owner_started or 0), "updated_at": float(updated_at or 0),\n'
        '        "retention_until": float(retention_until or 0)}\n', path)
    source = replace_once(source,
        '    def __init__(self, db_path: str = None):\n'
        '        if db_path is None:\n'
        '            try:\n'
        '                from hermes_cli.config import get_hermes_home\n'
        '                db_path = str(get_hermes_home() / "runs_idempotency.db")\n'
        '            except Exception:\n'
        '                db_path = ":memory:"\n'
        '        self._db_path = None if db_path == ":memory:" else db_path\n'
        '        try:\n'
        '            self._conn = sqlite3.connect(db_path, check_same_thread=False, timeout=30)\n'
        '        except Exception as exc:\n'
        '            # Docker may create the container object before `docker run` fails to start it (e.g. exit code\n'
        '            # 125 when the daemon isn\'t ready, or a timeout mid-pull). That orphan is left in "Created"\n'
        '            # state — which the exited-only orphan reaper (reap_orphan_containers, status=exited) never\n'
        '            # catches, so it leaks permanently. Remove it by its known name before re-raising. See #7439.\n'
        '            logger.warning(\n'
        '                "Run idempotency storage is unavailable; falling back to "\n'
        '                "process memory, so replay will not survive a restart: %s", exc)\n'
        '            self._conn = sqlite3.connect(":memory:", check_same_thread=False)\n'
        '            self._db_path = None\n',
        '    def __init__(self, db_path: str = None):\n'
        '        phase4_guarded = os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1"\n'
        '        if db_path is None:\n'
        '            try:\n'
        '                from hermes_cli.config import get_hermes_home\n'
        '                db_path = str(get_hermes_home() / "runs_idempotency.db")\n'
        '            except Exception as exc:\n'
        '                if phase4_guarded:\n'
        '                    raise RuntimeError("phase4_durable_idempotency_path_unavailable") from exc\n'
        '                db_path = ":memory:"\n'
        '        if phase4_guarded and db_path == ":memory:":\n'
        '            raise RuntimeError("phase4_durable_idempotency_store_required")\n'
        '        self._db_path = None if db_path == ":memory:" else db_path\n'
        '        try:\n'
        '            self._conn = sqlite3.connect(db_path, check_same_thread=False, timeout=30)\n'
        '        except Exception as exc:\n'
        '            if phase4_guarded:\n'
        '                raise RuntimeError("phase4_durable_idempotency_store_unavailable") from exc\n'
        '            logger.warning(\n'
        '                "Run idempotency storage is unavailable; falling back to "\n'
        '                "process memory, so replay will not survive a restart: %s", exc)\n'
        '            self._conn = sqlite3.connect(":memory:", check_same_thread=False)\n'
        '            self._db_path = None\n', path)
    source = replace_once(source,
        '        retention_until = max(0.0, float(retention_until or 0))\n'
        '        encoded = _encode_status(status)\n',
        '        retention_until = max(0.0, float(retention_until or 0))\n'
        '        if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1" and (\n'
        '                not self.durable or retention_until <= 0):\n'
        '            raise RuntimeError("phase4_durable_retention_required")\n'
        '        encoded = _encode_status(status)\n', path)
    source = replace_once(source,
        '        retention_until = max(0.0, float(retention_until or 0))\n'
        '        with self._immediate_txn():\n',
        '        retention_until = max(0.0, float(retention_until or 0))\n'
        '        if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1" and (\n'
        '                not self.durable or retention_until <= 0):\n'
        '            raise RuntimeError("phase4_durable_retention_required")\n'
        '        with self._immediate_txn():\n', path)
    source = replace_once(source,
        '            return "created", _record(run_id, encoded, owner_pid, owner_started, now) | {"status": status}\n',
        '            return "created", _record(\n'
        '                run_id, encoded, owner_pid, owner_started, now, retention_until) | {"status": status}\n', path)
    source = replace_once(source,
        '                WHERE acknowledged_at <= ?\n'
        '                   OR (retention_until > 0 AND retention_until <= ?)\n'
        '                   OR (retention_until <= 0 AND updated_at < ?)""",\n'
        '            (now - self.ACKNOWLEDGED_RETENTION_SECONDS, now, now - self.RETENTION_SECONDS),\n',
        '                WHERE (retention_until > 0 AND retention_until <= ?)\n'
        '                   OR (retention_until <= 0 AND acknowledged_at <= ?)\n'
        '                   OR (retention_until <= 0 AND acknowledged_at IS NULL AND updated_at < ?)""",\n'
        '            (now, now - self.ACKNOWLEDGED_RETENTION_SECONDS, now - self.RETENTION_SECONDS),\n', path)
    source = replace_once(source,
        '                "SELECT status_json, owner_pid, owner_started, updated_at "\n'
        '                "FROM run_idempotency WHERE scope=? AND run_id=?",\n',
        '                "SELECT status_json, owner_pid, owner_started, updated_at, retention_until "\n'
        '                "FROM run_idempotency WHERE scope=? AND run_id=?",\n', path)
    source = replace_once(source,
        '    "retention_until FROM run_idempotency WHERE scope=? AND idempotency_key=?")\n',
        '    "retention_until, dispatch_request_sha256 FROM run_idempotency "\n'
        '    "WHERE scope=? AND idempotency_key=?")\n', path)
    source = replace_once(source,
        '    "acknowledged_at": "REAL"}\n',
        '    "acknowledged_at": "REAL",\n'
        '    "dispatch_request_sha256": "TEXT"}\n', path)
    source = replace_once(source,
        '                retention_until REAL NOT NULL DEFAULT 0,\n'
        '                acknowledged_at REAL,\n',
        '                retention_until REAL NOT NULL DEFAULT 0,\n'
        '                acknowledged_at REAL,\n'
        '                dispatch_request_sha256 TEXT,\n', path)
    source = replace_once(source,
        '        self._conn.execute(\n'
        '            "CREATE UNIQUE INDEX IF NOT EXISTS run_idempotency_run_id ON run_idempotency(run_id)")\n'
        '        self._conn.commit()\n',
        '        self._conn.execute(\n'
        '            "CREATE UNIQUE INDEX IF NOT EXISTS run_idempotency_run_id ON run_idempotency(run_id)")\n'
        '        self._conn.execute(\n'
        '            """CREATE TABLE IF NOT EXISTS run_idempotency_absence (\n'
        '                scope TEXT NOT NULL, idempotency_key TEXT NOT NULL,\n'
        '                dispatch_request_sha256 TEXT NOT NULL,\n'
        '                retention_until REAL NOT NULL, sealed_at REAL NOT NULL,\n'
        '                PRIMARY KEY (scope, idempotency_key)\n'
        '            )""")\n'
        '        self._conn.commit()\n', path)
    source = replace_once(source,
        'def _record(run_id, status_json, owner_pid, owner_started, updated_at,\n'
        '            retention_until=0) -> dict[str, Any]:\n'
        '    return {\n'
        '        "run_id": run_id, "status": json.loads(status_json), "owner_pid": int(owner_pid or 0),\n'
        '        "owner_started": int(owner_started or 0), "updated_at": float(updated_at or 0),\n'
        '        "retention_until": float(retention_until or 0)}\n',
        'def _record(run_id, status_json, owner_pid, owner_started, updated_at,\n'
        '            retention_until=0, dispatch_request_sha256=None) -> dict[str, Any]:\n'
        '    return {\n'
        '        "run_id": run_id, "status": json.loads(status_json), "owner_pid": int(owner_pid or 0),\n'
        '        "owner_started": int(owner_started or 0), "updated_at": float(updated_at or 0),\n'
        '        "retention_until": float(retention_until or 0),\n'
        '        "dispatch_request_sha256": dispatch_request_sha256}\n'
        '\n'
        '\n'
        'def _valid_dispatch_request_sha256(value) -> bool:\n'
        '    return isinstance(value, str) and len(value) == 64 and all(\n'
        '        char in "0123456789abcdef" for char in value)\n', path)
    source = replace_once(source,
        '    def reserve(self, scope: str, key: str, fingerprint: str, run_id: str, status: Dict[str, Any], *,\n'
        '                owner_pid: int = 0, owner_started: int = 0, retention_until: float = 0):\n',
        '    def reserve(self, scope: str, key: str, fingerprint: str, run_id: str, status: Dict[str, Any], *,\n'
        '                owner_pid: int = 0, owner_started: int = 0, retention_until: float = 0,\n'
        '                dispatch_request_sha256: str = ""):\n', path)
    source = replace_once(source,
        '        if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1" and (\n'
        '                not self.durable or retention_until <= 0):\n'
        '            raise RuntimeError("phase4_durable_retention_required")\n'
        '        encoded = _encode_status(status)\n',
        '        if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1" and (\n'
        '                not self.durable or retention_until <= 0 or\n'
        '                not _valid_dispatch_request_sha256(dispatch_request_sha256)):\n'
        '            raise RuntimeError("phase4_durable_retention_required")\n'
        '        encoded = _encode_status(status)\n', path)
    source = replace_once(source,
        '        with self._immediate_txn():\n'
        '            self._prune_stale_terminal_locked(now)\n'
        '            row = self._conn.execute(_SELECT_BY_KEY, (scope, key)).fetchone()\n',
        '        with self._immediate_txn():\n'
        '            self._prune_stale_terminal_locked(now)\n'
        '            absent = self._conn.execute(\n'
        '                "SELECT dispatch_request_sha256, retention_until, sealed_at "\n'
        '                "FROM run_idempotency_absence WHERE scope=? AND idempotency_key=?",\n'
        '                (scope, key)).fetchone()\n'
        '            if absent is not None:\n'
        '                self._conn.commit()\n'
        '                if hmac.compare_digest(absent[0], dispatch_request_sha256):\n'
        '                    return "sealed_absent", {\n'
        '                        "dispatch_request_sha256": absent[0],\n'
        '                        "retention_until": float(absent[1]), "sealed_at": float(absent[2])}\n'
        '                return "conflict", None\n'
        '            row = self._conn.execute(_SELECT_BY_KEY, (scope, key)).fetchone()\n', path)
    source = replace_once(source,
        '            if row is not None:\n'
        '                if retention_until:\n'
        '                    self._conn.execute(_EXTEND_RETENTION_BY_KEY, (retention_until, scope, key, fingerprint))\n'
        '                self._conn.commit()\n'
        '                return _outcome(row, fingerprint)\n',
        '            if row is not None:\n'
        '                if retention_until:\n'
        '                    self._conn.execute(_EXTEND_RETENTION_BY_KEY, (retention_until, scope, key, fingerprint))\n'
        '                self._conn.commit()\n'
        '                if (os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1" and\n'
        '                        (not isinstance(row[-1], str) or not hmac.compare_digest(\n'
        '                            row[-1], dispatch_request_sha256))):\n'
        '                    return "conflict", None\n'
        '                return _outcome(row, fingerprint)\n', path)
    source = replace_once(source,
        '                "scope,idempotency_key,fingerprint,run_id,status_json,"\n'
        '                "owner_pid,owner_started,retention_until,created_at,updated_at"\n'
        '                ") VALUES(?,?,?,?,?,?,?,?,?,?)",\n'
        '                (scope, key, fingerprint, run_id, encoded, int(owner_pid or 0), int(owner_started or 0),\n'
        '                 retention_until, now, now))\n',
        '                "scope,idempotency_key,fingerprint,run_id,status_json,"\n'
        '                "owner_pid,owner_started,retention_until,dispatch_request_sha256,created_at,updated_at"\n'
        '                ") VALUES(?,?,?,?,?,?,?,?,?,?,?)",\n'
        '                (scope, key, fingerprint, run_id, encoded, int(owner_pid or 0), int(owner_started or 0),\n'
        '                 retention_until, dispatch_request_sha256 or None, now, now))\n', path)
    source = replace_once(source,
        '                run_id, encoded, owner_pid, owner_started, now, retention_until) | {"status": status}\n',
        '                run_id, encoded, owner_pid, owner_started, now, retention_until,\n'
        '                dispatch_request_sha256 or None) | {"status": status}\n', path)
    source = replace_once(source,
        '    def lookup(self, scope: str, key: str, fingerprint: str, *, retention_until: float = 0):\n',
        '    def lookup(self, scope: str, key: str, fingerprint: str, *, retention_until: float = 0,\n'
        '               dispatch_request_sha256: str = ""):\n', path)
    source = replace_once(source,
        '        if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1" and (\n'
        '                not self.durable or retention_until <= 0):\n'
        '            raise RuntimeError("phase4_durable_retention_required")\n'
        '        with self._immediate_txn():\n',
        '        if os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1" and (\n'
        '                not self.durable or retention_until <= 0 or\n'
        '                not _valid_dispatch_request_sha256(dispatch_request_sha256)):\n'
        '            raise RuntimeError("phase4_durable_retention_required")\n'
        '        with self._immediate_txn():\n', path)
    source = replace_once(source,
        '            row = self._conn.execute(_SELECT_BY_KEY, (scope, key)).fetchone()\n'
        '            self._conn.commit()\n'
        '        return ("missing", None) if row is None else _outcome(row, fingerprint)\n',
        '            absent = self._conn.execute(\n'
        '                "SELECT dispatch_request_sha256, retention_until, sealed_at "\n'
        '                "FROM run_idempotency_absence WHERE scope=? AND idempotency_key=?",\n'
        '                (scope, key)).fetchone()\n'
        '            row = None if absent is not None else self._conn.execute(\n'
        '                _SELECT_BY_KEY, (scope, key)).fetchone()\n'
        '            self._conn.commit()\n'
        '        if absent is not None:\n'
        '            if hmac.compare_digest(absent[0], dispatch_request_sha256):\n'
        '                return "sealed_absent", {\n'
        '                    "dispatch_request_sha256": absent[0],\n'
        '                    "retention_until": float(absent[1]), "sealed_at": float(absent[2])}\n'
        '            return "conflict", None\n'
        '        if (row is not None and os.environ.get("MERI_PHASE4_CLAIM_V1_ENABLED") == "1" and\n'
        '                (not isinstance(row[-1], str) or not hmac.compare_digest(\n'
        '                    row[-1], dispatch_request_sha256))):\n'
        '            return "conflict", None\n'
        '        return ("missing", None) if row is None else _outcome(row, fingerprint)\n'
        '\n'
        '    def lookup_or_seal_absent(self, scope: str, key: str, dispatch_request_sha256: str, *,\n'
        '                              not_before: float, retention_until: float):\n'
        '        """Atomically return a reservation or install a late-delivery tombstone."""\n'
        '        if (not self.durable or not _valid_dispatch_request_sha256(dispatch_request_sha256)\n'
        '                or not isinstance(not_before, (int, float))\n'
        '                or not isinstance(retention_until, (int, float))\n'
        '                or not_before <= 0 or retention_until <= not_before):\n'
        '            raise RuntimeError("phase4_absence_seal_material_invalid")\n'
        '        with self._immediate_txn():\n'
        '            now = time.time()\n'
        '            if retention_until <= now:\n'
        '                raise RuntimeError("phase4_absence_seal_material_expired")\n'
        '            absent = self._conn.execute(\n'
        '                "SELECT dispatch_request_sha256, retention_until, sealed_at "\n'
        '                "FROM run_idempotency_absence WHERE scope=? AND idempotency_key=?",\n'
        '                (scope, key)).fetchone()\n'
        '            if absent is not None:\n'
        '                self._conn.commit()\n'
        '                return (("sealed_absent", {"dispatch_request_sha256": absent[0],\n'
        '                    "retention_until": float(absent[1]), "sealed_at": float(absent[2])})\n'
        '                    if hmac.compare_digest(absent[0], dispatch_request_sha256)\n'
        '                    else ("conflict", None))\n'
        '            row = self._conn.execute(_SELECT_BY_KEY, (scope, key)).fetchone()\n'
        '            if row is not None:\n'
        '                self._conn.commit()\n'
        '                stored_digest = row[-1]\n'
        '                return (("reused", _record(*row[1:])) if isinstance(stored_digest, str) and\n'
        '                        hmac.compare_digest(stored_digest, dispatch_request_sha256)\n'
        '                        else ("conflict", None))\n'
        '            if now < not_before:\n'
        '                self._conn.commit()\n'
        '                return "too_early", None\n'
        '            self._conn.execute(\n'
        '                "INSERT INTO run_idempotency_absence("\n'
        '                "scope,idempotency_key,dispatch_request_sha256,retention_until,sealed_at"\n'
        '                ") VALUES(?,?,?,?,?)",\n'
        '                (scope, key, dispatch_request_sha256, retention_until, now))\n'
        '            self._conn.commit()\n'
        '            return "sealed_absent", {"dispatch_request_sha256": dispatch_request_sha256,\n'
        '                "retention_until": retention_until, "sealed_at": now}\n', path)
    return source


def patch_delegate_tool(source: str) -> str:
    path = "tools/delegate_tool.py"
    return replace_once(source,
        '                iteration_budget=None,  # fresh budget per subagent\n'
        '            )\n'
        '        except BaseException:\n',
        '                iteration_budget=None,  # fresh budget per subagent\n'
        '            )\n'
        '            parent_view = getattr(parent_agent, "_meri_tool_view_v1", None)\n'
        '            if parent_view is not None:\n'
        '                from meri_tool_view_v1 import apply_agent_tool_view\n'
        '                apply_agent_tool_view(\n'
        '                    child, {**parent_view, "required_tool_names": frozenset()})\n'
        '                from meri_claim_attestation_v1 import assert_phase4_launch_authorized\n'
        '                child._meri_phase4_claim_gate_v1 = getattr(\n'
        '                    parent_agent, "_meri_phase4_claim_gate_v1", None)\n'
        '                assert_phase4_launch_authorized(child)\n'
        '        except BaseException:\n', path)


PATCHERS = {
    "gateway/platforms/api_server_runs.py": patch_runs,
    "gateway/platforms/api_server_run_idempotency.py": patch_run_idempotency,
    "gateway/platforms/api_server.py": patch_api_server,
    "agent/tool_executor.py": patch_executor,
    "agent/turn_api_request.py": patch_request,
    "agent/background_review.py": patch_background_review,
    "agent/model_metadata.py": patch_model_metadata,
    "hermes_cli/plugins_dispatch.py": patch_plugins_dispatch,
    "agent/chat_completion_helpers.py": patch_chat_completion_helpers,
    "gateway/run.py": patch_gateway_run,
    "tools/delegate_tool.py": patch_delegate_tool,
}


def apply(root: pathlib.Path) -> None:
    prepared = {}
    for relative, expected in PINNED.items():
        path = root / relative
        data = path.read_bytes()
        actual = hashlib.sha256(data).hexdigest()
        if actual != expected:
            raise RuntimeError(f"{relative}: expected pinned sha256 {expected}, got {actual}")
        if relative in PATCHERS:
            prepared[path] = PATCHERS[relative](data.decode("utf-8"))
    # All checks passed before the first write.
    for path, text in prepared.items():
        path.write_text(text, encoding="utf-8")
    for helper_name in (
        "meri_tool_view_v1.py", "meri_claim_attestation_v1.py",
        "meri_recovery_receipt_v1.py", "meri_reservation_recovery_v1.py",
        "meri_recovery_runtime_v1.py",
    ):
        helper = pathlib.Path(__file__).with_name(helper_name)
        (root / helper_name).write_bytes(helper.read_bytes())


if __name__ == "__main__":
    apply(pathlib.Path(sys.argv[1]))
