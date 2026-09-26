"""One-shot local HTTP bridge for the isolated Phase 4 image contract test.

Executed with ``docker exec`` inside the worker/fake container. This does not
listen on a port, proxy requests, or connect outside the container's network.
The harness allows only loopback origins and mounts this file read-only.
"""
from __future__ import annotations

import base64
import json
import re
import sys
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from urllib.parse import urlsplit


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("expected one encoded synthetic request")
    raw = sys.argv[1]
    request = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    url = request["url"]
    parsed = urlsplit(url)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
            or parsed.port not in (8002, 8642) or parsed.query or parsed.fragment):
        raise SystemExit("bridge request must target a local test port")
    body = request.get("body")
    data = body.encode("utf-8") if isinstance(body, str) else None
    method = request.get("method") or "GET"
    worker_allowed = (
        (method == "GET" and parsed.path in ("/v1/capabilities", "/v1/toolsets"))
        or (method == "POST" and parsed.path == "/v1/runs")
        or (method == "GET" and re.fullmatch(r"/v1/runs/[A-Za-z0-9_-]+", parsed.path))
        or (method == "POST" and re.fullmatch(r"/v1/runs/[A-Za-z0-9_-]+/stop", parsed.path))
    )
    fake_allowed = method == "GET" and parsed.path == "/__phase4/state"
    if not ((parsed.port == 8642 and worker_allowed) or (parsed.port == 8002 and fake_allowed)):
        raise SystemExit("bridge method/path is outside the local test allowlist")
    headers = request.get("headers") or {}
    if not isinstance(headers, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in headers.items()):
        raise SystemExit("invalid synthetic headers")
    outbound = Request(url, data=data, headers=headers, method=method)
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        response = opener.open(outbound, timeout=8)
    except HTTPError as error:
        response = error
    with response:
        response_headers = {
            "content-type": response.headers.get("content-type", "application/json"),
        }
        recovery_receipt = response.headers.get(
            "x-meri-dispatch-recovery-receipt")
        if recovery_receipt is not None:
            response_headers["x-meri-dispatch-recovery-receipt"] = recovery_receipt
        payload = {
            "status": response.status,
            "headers": response_headers,
            "bodyBase64": base64.b64encode(response.read(1024 * 1024)).decode("ascii"),
        }
    print(json.dumps(payload, separators=(",", ":")))


if __name__ == "__main__":
    main()
