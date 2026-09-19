"""Meri broker tools for Hermes (Phase 0 compatibility harness).

Three adapters the pinned build (v2026.9.14) needs to fit Meri's product:

* ``meri_fetch_attachment`` — the Hermes API rejects file uploads
  (``400 unsupported_content_type``), so Meri-owned chat attachments are
  materialised into the worker workspace through the broker. Hermes then reads
  the file with its NATIVE ``read_file`` extraction (PDF/DOCX → Markdown), which
  is what "native file handling" means here; Meri's own application-side
  extraction (ClioAttachment.textContent) is returned alongside for comparison.
* ``meri_publish_artifact`` — files the agent produces live in the worker
  filesystem; publication through the broker is the ONLY way they reach a user
  (tenant + user scoped ClioArtifact row with sha256).
* ``meri_request_clarification`` — ``/v1/runs`` constructs the agent without a
  clarify callback, so the native ``clarify`` tool is unavailable there. This
  adapter registers a DURABLE pending interaction in Meri and instructs the
  model to end its turn; the answer arrives as the next user message.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
from pathlib import Path
from typing import Any, Dict

from .broker import MeriBrokerClient, broker_configured

_TEXT_TYPES = {".md", ".txt", ".csv", ".json", ".html", ".htm", ".yaml", ".yml", ".xml", ".tsv"}


def _workspace() -> Path:
    root = os.environ.get("MERI_WORKSPACE_DIR") or os.path.join(os.environ.get("HERMES_HOME", "/opt/data"), "workspace")
    path = Path(root)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _safe_name(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", name or "file").strip("._") or "file"
    return cleaned[:120]


def _available() -> bool:
    return broker_configured()


def _err(code: str, **extra: Any) -> str:
    return json.dumps({"error": code, **extra})


# Hermes invokes plugin tool handlers with extra keyword arguments (e.g. task_id);
# every handler must accept **kwargs (observed on v2026.9.14: "unexpected keyword argument 'task_id'").
def _fetch_attachment(args: Dict[str, Any], **_kwargs: Any) -> str:
    attachment_id = str((args or {}).get("attachment_id", "")).strip()
    if not attachment_id:
        return _err("attachment_id is required")
    client = MeriBrokerClient()
    response = client.call("GET", f"/attachments/{attachment_id}", None, timeout=30)
    if not response["ok"]:
        return _err("meri_broker_error", status=response["status"], detail=response.get("body"))
    body = response["body"] or {}
    target_dir = _workspace() / "attachments"
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = _safe_name(str(body.get("filename") or attachment_id))
    path = target_dir / f"{attachment_id[:8]}-{filename}"
    wrote = None
    if body.get("dataBase64"):
        path.write_bytes(base64.b64decode(body["dataBase64"]))
        wrote = "original_bytes"
    elif body.get("textContent"):
        path = path.with_suffix(path.suffix + ".meri-extracted.txt")
        path.write_text(str(body["textContent"]), encoding="utf-8")
        wrote = "meri_application_extraction_only"
    else:
        return _err("attachment_has_no_content", attachment_id=attachment_id, status=body.get("status"))
    return json.dumps(
        {
            "path": str(path),
            "filename": body.get("filename"),
            "kind": body.get("kind"),
            "media_type": body.get("mediaType"),
            "byte_size": body.get("byteSize"),
            "pages": body.get("pages"),
            "materialized": wrote,
            "meri_extracted_text_available": bool(body.get("textContent")),
            "next_step": "Use read_file on `path` to read the document natively.",
        }
    )


def _publish_artifact(args: Dict[str, Any], **_kwargs: Any) -> str:
    args = args or {}
    raw_path = str(args.get("path", "")).strip()
    title = str(args.get("title", "")).strip() or Path(raw_path).name
    kind = str(args.get("kind", "")).strip() or "hermes_file"
    if not raw_path:
        return _err("path is required")
    path = Path(raw_path)
    if not path.is_absolute():
        path = _workspace() / path
    try:
        path = path.resolve()
        if _workspace().resolve() not in path.parents and path != _workspace().resolve():
            return _err("path_outside_workspace", path=str(path))
        data = path.read_bytes()
    except OSError as exc:
        return _err("cannot_read_file", detail=str(exc))
    if len(data) > 2 * 1024 * 1024:
        return _err("artifact_too_large_for_phase0", bytes=len(data), limit=2 * 1024 * 1024)
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    body: Dict[str, Any] = {"title": title[:200], "kind": kind[:60], "contentType": content_type, "filename": path.name}
    if path.suffix.lower() in _TEXT_TYPES:
        body["bodyText"] = data.decode("utf-8", "replace")
    else:
        body["dataBase64"] = base64.b64encode(data).decode("ascii")
    response = MeriBrokerClient().call("POST", "/artifacts", body, timeout=60)
    if not response["ok"]:
        return _err("meri_broker_error", status=response["status"], detail=response.get("body"))
    return json.dumps({"published": True, **(response["body"] or {}), "bytes": len(data), "contentType": content_type})


def _request_clarification(args: Dict[str, Any], **_kwargs: Any) -> str:
    args = args or {}
    question = str(args.get("question", "")).strip()
    if not question:
        return _err("question is required")
    choices = [str(c).strip() for c in (args.get("choices") or []) if str(c).strip()][:4]
    body = {"question": question[:2000], "choices": choices, "multiSelect": bool(args.get("multi_select"))}
    response = MeriBrokerClient().call("POST", "/clarifications", body, timeout=20)
    if not response["ok"]:
        return _err("meri_broker_error", status=response["status"], detail=response.get("body"))
    payload = response["body"] or {}
    return json.dumps(
        {
            "request_id": payload.get("requestId"),
            "delivered": True,
            "instruction": payload.get(
                "instruction",
                "The question was delivered to the user. End your turn now and wait for their answer.",
            ),
        }
    )


_SCHEMAS = {
    "meri_fetch_attachment": {
        "name": "meri_fetch_attachment",
        "description": (
            "Materialise a Meri chat attachment (listed in the user message as attachment_id=…) into the "
            "workspace and return its local path so you can read_file it natively."
        ),
        "parameters": {
            "type": "object",
            "properties": {"attachment_id": {"type": "string", "description": "Meri attachment UUID."}},
            "required": ["attachment_id"],
        },
    },
    "meri_publish_artifact": {
        "name": "meri_publish_artifact",
        "description": (
            "Publish a file you created in the workspace to the user through Meri (authorized, tenant + user "
            "scoped). Returns an artifact id and download URL. Max 2 MiB in Phase 0."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path inside the workspace."},
                "title": {"type": "string", "description": "Human title for the artifact."},
                "kind": {"type": "string", "description": "Artifact kind, e.g. summary_markdown, csv_export, word_document."},
            },
            "required": ["path", "title"],
        },
    },
    "meri_request_clarification": {
        "name": "meri_request_clarification",
        "description": (
            "Ask the user a clarifying question through Meri. The question is delivered durably; END YOUR TURN "
            "after calling this. The answer arrives as the next user message."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "question": {"type": "string"},
                "choices": {"type": "array", "items": {"type": "string"}, "maxItems": 4},
                "multi_select": {"type": "boolean"},
            },
            "required": ["question"],
        },
    },
}

_HANDLERS = {
    "meri_fetch_attachment": (_fetch_attachment, "📎"),
    "meri_publish_artifact": (_publish_artifact, "📤"),
    "meri_request_clarification": (_request_clarification, "❓"),
}


def register(ctx) -> None:
    for name, (handler, emoji) in _HANDLERS.items():
        ctx.register_tool(
            name=name,
            toolset="meri",
            schema=_SCHEMAS[name],
            handler=handler,
            check_fn=_available,
            requires_env=["MERI_BROKER_URL", "MERI_WORKER_TOKEN"],
            description=_SCHEMAS[name]["description"],
            emoji=emoji,
        )
