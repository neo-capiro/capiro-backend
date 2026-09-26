"""Local-only fake provider, broker, and TLS claim service for Phase 4.

This is mounted into a disposable worker-image container on a Docker internal
network. It has no proxying or outbound HTTP behavior and records only schema
names, synthetic case markers, and broker method/path counters.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import pathlib
import ssl
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

CASE_A = "PHASE4_CASE_A_7F2C"
CASE_B = "PHASE4_CASE_B_91D4"
CASE_C = "PHASE4_CASE_C_UNKNOWN_4A8E"
CASE_D = "PHASE4_CASE_D_REJECTED_2B6F"
CASE_E = "PHASE4_CASE_E_STOP_RACE_5C3A"
TOOL_A = "meri_request_clarification"
TOOL_B = "meri_fetch_attachment"
CLAIM_PATH = "/api/internal/meri/hermes/phase4/claim"
BEARER_DOMAIN = b"capiro.meri.phase4.dispatch-gate-bearer/v1\0"
ATTESTATION_DOMAIN = "capiro.meri.phase4.claim-tool-view-attestation/v1"
condition = threading.Condition()
first_cases: set[str] = set()
provider_calls: list[dict] = []
broker_calls: list[dict] = []
claim_calls: list[dict] = []
memory_calls: list[dict] = []
events: list[dict] = []
unexpected_network_calls: list[dict] = []
turn_counts: dict[str, int] = {}
worker_run_markers: dict[str, str] = {}
sequence = 0


def _b64decode(value: str) -> bytes:
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if not decoded or base64.urlsafe_b64encode(decoded).decode().rstrip("=") != value:
        raise ValueError("noncanonical base64url")
    return decoded


def _record(kind: str, marker: str, **fields: object) -> int:
    global sequence
    with condition:
        sequence += 1
        events.append({"sequence": sequence, "kind": kind, "marker": marker, **fields})
        return sequence


def _json(handler: BaseHTTPRequestHandler, status: int, value: object) -> None:
    payload = json.dumps(value, separators=(",", ":")).encode()
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def _marker(value: object) -> str | None:
    encoded = json.dumps(value, ensure_ascii=True)
    if CASE_A in encoded:
        return CASE_A
    if CASE_B in encoded:
        return CASE_B
    if CASE_C in encoded:
        return CASE_C
    if CASE_D in encoded:
        return CASE_D
    if CASE_E in encoded:
        return CASE_E
    return None


def _verify_claim(handler: BaseHTTPRequestHandler, raw: bytes, body: object) -> tuple[str, dict]:
    if handler.headers.get("x-meri-dispatch-claim-service-secret") != os.environ["PHASE4_CLAIM_SERVICE_SECRET"]:
        raise ValueError("wrong claim service secret")
    if not isinstance(body, dict) or tuple(body) != (
        "version", "receivedMethod", "receivedPath", "receivedContentType",
        "tenantId", "runId", "requestSha256", "workerRunId", "bearer",
        "toolViewAttestation", "bodyBase64url", "sessionHeaderValue",
        "idempotencyKeyHeaderValue",
    ) or body["version"] != 2 or body["receivedMethod"] != "POST" or \
            body["receivedPath"] != "/v1/runs" or body["receivedContentType"] != "application/json":
        raise ValueError("noncanonical claim wire")

    request_body = _b64decode(body["bodyBase64url"])
    if base64.urlsafe_b64encode(request_body).decode().rstrip("=") != body["bodyBase64url"]:
        raise ValueError("body encoding drift")
    parsed_request = json.loads(request_body)
    marker = _marker(parsed_request.get("input"))
    if marker not in {CASE_A, CASE_B, CASE_C, CASE_D, CASE_E}:
        raise ValueError("missing synthetic claim marker")

    bearer_parts = body["bearer"].split(".")
    if len(bearer_parts) != 3 or bearer_parts[0] != "mdgb1":
        raise ValueError("bad dispatch bearer")
    bearer_key = _b64decode(os.environ["PHASE4_DISPATCH_BEARER_KEY_B64URL"])
    expected_bearer_signature = hmac.new(
        bearer_key, BEARER_DOMAIN + f"mdgb1.{bearer_parts[1]}".encode("ascii"), hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(_b64decode(bearer_parts[2]), expected_bearer_signature):
        raise ValueError("bad dispatch bearer signature")
    bearer_claims = json.loads(_b64decode(bearer_parts[1]))
    if (json.dumps(bearer_claims, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            != _b64decode(bearer_parts[1])):
        raise ValueError("noncanonical dispatch bearer")
    for wire_name, claim_name in (
        ("tenantId", "tenantId"), ("runId", "runId"),
        ("requestSha256", "requestSha256"),
    ):
        if body[wire_name] != bearer_claims[claim_name]:
            raise ValueError("wire/bearer mismatch")
    bindings = {
        "tenantId": "PHASE4_TENANT_ID", "scopeId": "PHASE4_SCOPE_ID",
        "workerAudience": "PHASE4_WORKER_AUDIENCE",
        "workerIngressId": "PHASE4_WORKER_INGRESS_ID",
        "workerGeneration": "PHASE4_WORKER_GENERATION",
        "workerCredentialId": "PHASE4_WORKER_CREDENTIAL_ID",
    }
    if any(bearer_claims.get(field) != os.environ[env] for field, env in bindings.items()):
        raise ValueError("bearer route mismatch")

    encoded, signature = body["toolViewAttestation"].split(".")
    attestation_key = _b64decode(os.environ["PHASE4_ATTESTATION_KEY_B64URL"])
    expected_signature = hmac.new(attestation_key, encoded.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected_signature):
        raise ValueError("bad claim attestation signature")
    fields = json.loads(_b64decode(encoded))
    view_token = parsed_request.get("meri_tool_view_v1") or {}
    view_payload = json.loads(_b64decode(view_token.get("payload", "")))
    expected_fields = [
        ATTESTATION_DOMAIN, "1", body["tenantId"], body["runId"], body["requestSha256"],
        body["workerRunId"], bearer_claims["workerAudience"], bearer_claims["workerIngressId"],
        bearer_claims["workerGeneration"], bearer_claims["workerCredentialId"],
        view_payload["worker_catalog_sha256"], view_payload["applied_tool_view_sha256"],
        fields[12], fields[13],
    ]
    if fields != expected_fields or not body["sessionHeaderValue"] or not body["idempotencyKeyHeaderValue"]:
        raise ValueError("claim attestation mismatch")
    return marker, bearer_claims


def _tool_call(name: str, arguments: dict, call_id: str) -> dict:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments, separators=(",", ":"))},
    }


def _completion(handler: BaseHTTPRequestHandler, body: dict, marker: str, call: int) -> None:
    # Force the first model-visible request from each run to overlap before
    # either can proceed. A missing second run fails closed after 15 seconds.
    if call == 1:
        with condition:
            first_cases.add(marker)
            condition.notify_all()
            deadline = time.monotonic() + 15
            while first_cases != {CASE_A, CASE_B}:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    _json(handler, 503, {"error": {"message": "Phase 4 overlap barrier timed out"}})
                    return
                condition.wait(remaining)

    allowed = TOOL_A if marker == CASE_A else TOOL_B
    denied = TOOL_B if marker == CASE_A else TOOL_A
    if call == 1:
        selected = allowed
        args = {"question": "Synthetic Phase 4 contract probe"} if selected == TOOL_A else {
            "attachment_id": "phase4-synthetic-attachment"
        }
    elif call == 2:
        selected = denied
        args = {"attachment_id": "phase4-cross-view-denial"} if selected == TOOL_B else {
            "question": "This cross-view request must never reach the broker"
        }
    else:
        selected = None
        args = None

    request_id = f"phase4-{marker[-4:]}-{call}"
    model = body.get("model") or "phase4-fake-model"
    created = int(time.time())
    stream = body.get("stream") is True
    if selected is not None:
        message = {
            "role": "assistant",
            "content": None,
            "tool_calls": [_tool_call(selected, args or {}, request_id)],
        }
        finish = "tool_calls"
    else:
        message = {"role": "assistant", "content": "Synthetic Phase 4 run finished.", "tool_calls": None}
        finish = "stop"

    if not stream:
        _json(handler, 200, {
            "id": request_id, "object": "chat.completion", "created": created, "model": model,
            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        })
        return

    # Minimal OpenAI-compatible SSE, including a complete function call in one
    # delta. Streaming is supported so the test exercises default Hermes mode.
    handler.send_response(200)
    handler.send_header("content-type", "text/event-stream")
    handler.send_header("cache-control", "no-cache")
    handler.send_header("connection", "close")
    handler.end_headers()
    if selected is not None:
        delta = {"tool_calls": [{"index": 0, **_tool_call(selected, args or {}, request_id)}]}
    else:
        delta = {"content": "Synthetic Phase 4 run finished."}
    chunk = {
        "id": request_id, "object": "chat.completion.chunk", "created": created, "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
    }
    handler.wfile.write(b"data: " + json.dumps(chunk, separators=(",", ":")).encode() + b"\n\n")
    final = {
        "id": request_id, "object": "chat.completion.chunk", "created": created, "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
    }
    handler.wfile.write(b"data: " + json.dumps(final, separators=(",", ":")).encode() + b"\n\n")
    handler.wfile.write(b"data: [DONE]\n\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args) -> None:
        # Never echo request bodies, auth headers, or model-visible content.
        return

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/__phase4/state":
            with condition:
                state = {
                    "providerCalls": list(provider_calls), "brokerCalls": list(broker_calls),
                    "claimCalls": list(claim_calls), "events": list(events),
                    "memoryCalls": list(memory_calls),
                    "unexpectedNetworkCalls": list(unexpected_network_calls),
                }
            _json(self, 200, state)
            return
        if path.startswith("/attachments/"):
            with condition:
                broker_calls.append({"method": "GET", "path": path})
            if self.headers.get("authorization") != "Bearer phase4-dummy-worker-token":
                _json(self, 401, {"error": "wrong synthetic token"})
            else:
                _json(self, 200, {
                    "filename": "phase4-synthetic.txt", "kind": "text",
                    "textContent": "Synthetic attachment fixture; no customer data.",
                })
            return
        if self.server.server_port in {8000, 8001}:
            with condition:
                unexpected_network_calls.append({
                    "method": "GET", "port": self.server.server_port, "path": path,
                })
        _json(self, 404, {"error": "not found"})

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        raw = self.rfile.read(int(self.headers.get("content-length", "0")))
        try:
            body = json.loads(raw or b"{}")
        except (ValueError, UnicodeDecodeError):
            _json(self, 400, {"error": "bad JSON"})
            return

        if path == "/v1/chat/completions":
            marker = _marker(body.get("messages"))
            if marker not in {CASE_A, CASE_B, CASE_C, CASE_D, CASE_E}:
                _json(self, 400, {"error": {"message": "Missing synthetic test marker"}})
                return
            schemas = body.get("tools") or []
            names = []
            for schema in schemas:
                name = ((schema or {}).get("function") or {}).get("name")
                if not isinstance(name, str):
                    _json(self, 400, {"error": {"message": "Malformed tool schema"}})
                    return
                names.append(name)
            with condition:
                turn_counts[marker] = turn_counts.get(marker, 0) + 1
                turn = turn_counts[marker]
                event_sequence = _record("provider", marker)
                provider_calls.append({
                    "marker": marker, "schemaNames": sorted(names), "sequence": event_sequence,
                })
            _completion(self, body, marker, turn)
            return

        if path == CLAIM_PATH and self.server.server_port == 8443:
            try:
                marker, _claims = _verify_claim(self, raw, body)
            except Exception:
                _json(self, 400, {"version": 2, "kind": "rejected", "launchAuthorized": False})
                return
            disposition = "transitioned"
            if marker == CASE_C:
                disposition = "UNKNOWN"
            elif marker == CASE_D:
                disposition = "rejected"
            claim_sequence = _record("claim", marker, disposition=disposition)
            with condition:
                claim_calls.append({
                    "marker": marker, "disposition": disposition, "sequence": claim_sequence,
                })
                worker_run_markers[str(body["workerRunId"])] = marker
            if marker == CASE_E:
                time.sleep(1.5)
            if disposition == "transitioned":
                _json(self, 200, {"version": 2, "kind": "transitioned", "launchAuthorized": True})
            elif disposition == "UNKNOWN":
                _json(self, 200, {
                    "version": 2, "kind": "UNKNOWN", "reason": "commit_unconfirmed",
                    "launchAuthorized": False,
                })
            else:
                _json(self, 200, {"version": 2, "kind": "rejected", "launchAuthorized": False})
            return

        if path == "/clarifications":
            with condition:
                broker_calls.append({"method": "POST", "path": path})
            if self.headers.get("authorization") != "Bearer phase4-dummy-worker-token":
                _json(self, 401, {"error": "wrong synthetic token"})
            else:
                _json(self, 200, {"requestId": "phase4-synthetic-clarification", "instruction": "End your turn."})
            return

        if path in {"/memory/recall", "/turns"} and self.server.server_port == 8001:
            if self.headers.get("authorization") != "Bearer phase4-dummy-worker-token":
                _json(self, 401, {"error": "wrong synthetic token"})
                return
            marker = (_marker(body) if path == "/memory/recall" else
                      worker_run_markers.get(self.headers.get("x-meri-hermes-run-id", "")))
            if marker not in {CASE_A, CASE_B, CASE_C, CASE_D, CASE_E}:
                with condition:
                    unexpected_network_calls.append({
                        "method": "POST", "port": self.server.server_port, "path": path,
                    })
                _json(self, 400, {"error": "missing synthetic memory marker"})
                return
            memory_sequence = _record("memory", marker, path=path)
            with condition:
                memory_calls.append({
                    "marker": marker, "path": path, "sequence": memory_sequence,
                })
            if path == "/memory/recall":
                _json(self, 200, {"items": [], "coverage": {
                    "returned": 0, "total": 0, "complete": True,
                    "sourceStatus": "synthetic",
                }})
            else:
                _json(self, 200, {"receipt": "phase4-synthetic-turn"})
            return

        if self.server.server_port in {8000, 8001}:
            with condition:
                unexpected_network_calls.append({
                    "method": "POST", "port": self.server.server_port, "path": path,
                })

        _json(self, 404, {"error": "not found"})


def serve(port: int) -> None:
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    if port == 8443:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain("/tmp/phase4-certs/server.crt", "/tmp/phase4-certs/server.key")
        server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


def create_test_certificate() -> None:
    directory = pathlib.Path("/tmp/phase4-certs")
    directory.mkdir(parents=True, exist_ok=True)
    cert = directory / "server.crt"
    key = directory / "server.key"
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=phase4-fakes", "-addext", "subjectAltName=DNS:phase4-fakes",
        "-keyout", str(key), "-out", str(cert),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.chmod(cert, 0o444)
    os.chmod(key, 0o400)


if __name__ == "__main__":
    create_test_certificate()
    threading.Thread(target=serve, args=(8000,), daemon=True).start()
    threading.Thread(target=serve, args=(8001,), daemon=True).start()
    threading.Thread(target=serve, args=(8443,), daemon=True).start()
    serve(8002)
