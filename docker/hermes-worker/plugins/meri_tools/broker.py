"""Minimal HTTP client for the Meri agent tool broker (stdlib only).

Duplicated verbatim from plugins/meri_memory/broker.py on purpose: Hermes loads
user plugins as isolated packages, so cross-plugin imports are not portable.
Keep the two files identical.
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def broker_configured() -> bool:
    return bool(os.environ.get("MERI_BROKER_URL", "").strip() and os.environ.get("MERI_WORKER_TOKEN", "").strip())


def current_run_id() -> str:
    try:
        from tools.approval_context import get_current_session_key  # type: ignore

        key = get_current_session_key(default="")
        if key:
            return str(key)
    except Exception:  # pragma: no cover - defensive
        pass
    return os.environ.get("MERI_HERMES_RUN_ID", "")


class MeriBrokerClient:
    def __init__(self) -> None:
        self.base = os.environ.get("MERI_BROKER_URL", "").strip().rstrip("/")
        self.token = os.environ.get("MERI_WORKER_TOKEN", "").strip()

    def call(self, method: str, path: str, body: Optional[Dict[str, Any]] = None, *, timeout: float = 20) -> Dict[str, Any]:
        if not self.base or not self.token:
            return {"ok": False, "status": 0, "body": {"error": "meri_broker_not_configured"}}
        run_id = current_run_id()
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            f"{self.base}{path}",
            method=method,
            data=data,
            headers={
                "authorization": f"Bearer {self.token}",
                "content-type": "application/json",
                "accept": "application/json",
                "x-meri-hermes-run-id": run_id,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read()
                return {"ok": True, "status": response.status, "body": json.loads(raw) if raw else None}
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                parsed = json.loads(raw) if raw else None
            except ValueError:
                parsed = {"raw": raw[:500].decode("utf-8", "replace")}
            logger.warning("meri broker %s %s → %s", method, path, exc.code)
            return {"ok": False, "status": exc.code, "body": parsed}
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            logger.warning("meri broker %s %s unreachable: %s", method, path, exc)
            return {"ok": False, "status": 0, "body": {"error": "meri_broker_unreachable", "detail": str(exc)}}
