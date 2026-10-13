"""Read-only finite packet verification; no service/database/network imports."""
from pathlib import Path
import hashlib
import json
import subprocess

packet = Path(__file__).resolve().parent
repo = packet.parent.parent
index = json.loads((packet / "EVIDENCE-SHA256.json").read_text())
rows = index["files"]
paths = [row["path"] for row in rows]
assert len(paths) == len(set(paths)) and 1 <= len(paths) <= 100
allowed = set(paths) | {"EVIDENCE-SHA256.json", "evidence/final-packet-checks.json"}
observed = {str(f.relative_to(packet)) for f in packet.rglob("*") if f.is_file()}
assert observed <= allowed and set(paths) <= observed
for row in rows:
    relative = Path(row["path"])
    assert not relative.is_absolute() and ".." not in relative.parts
    target = packet / relative
    assert not target.is_symlink()
    raw = target.read_bytes()
    assert len(raw) == row["bytes"]
    assert hashlib.sha256(raw).hexdigest() == row["sha256"]
envelope = json.loads((packet / "evidence/attempt1-source-tests.log.lossless.json").read_text())
assert envelope["encoding"] == "utf8-json-string"
assert envelope["rawCommit"] == "b14e14f04148e5afa9f1f6f8a21ff3a4562297b9"
assert envelope["rawPath"] == "docs/preview-backend-isolation-source-20261013/evidence/attempt1-source-tests.log"
raw = envelope["text"].encode("utf-8")
assert len(raw) == envelope["bytes"]
assert hashlib.sha256(raw).hexdigest() == envelope["sha256"]
assert subprocess.check_output(["git", "show", envelope["rawCommit"] + ":" + envelope["rawPath"]], cwd=repo) == raw
blob = subprocess.check_output(["git", "rev-parse", envelope["rawCommit"] + ":" + envelope["rawPath"]], cwd=repo).decode().strip()
assert blob == envelope["rawGitBlob"]
print(json.dumps({"result": "PASS", "finiteSha256Rows": len(rows), "losslessRawLogEnvelopes": 1}))
