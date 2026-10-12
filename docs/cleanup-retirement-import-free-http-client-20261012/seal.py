import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
packet = Path(__file__).resolve().parent
base = "d587441261fd356ee5144a8fc29cb2f771d062b8"
published = "d09429a509d5b3cc2501f3736e619723e4b2c4c0"
paths = [
    "apps/api/scripts/lib/meri-durable-research-contract-client.ts",
    "apps/api/scripts/meri-durable-controls.http.integration.spec.ts",
    "scripts/ci/meri-durable-http-client-contract.spec.mjs",
]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=root)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


rows = []
for path in paths:
    raw = (root / path).read_bytes()
    assert raw == git("show", f"{published}:{path}")
    rows.append({"path": path, "bytes": len(raw), "sha256": digest(raw), "publishedBlob": git("rev-parse", f"{published}:{path}").decode().strip()})
spec = paths[1]
before = git("show", f"{base}:{spec}")
after = (root / spec).read_bytes()
old_import = b"../../web/src/components/chat/meri-durable-research.js"
new_import = b"./lib/meri-durable-research-contract-client.js"
assert before.count(old_import) == 1
assert before.replace(old_import, new_import) == after
receipt = {
    "base": base, "publishedCandidate": published, "paths": rows,
    "integrationImportOnlyInverseExact": True,
    "commands": [
        {"command": "node --test scripts/ci/meri-durable-http-client-contract.spec.mjs", "exitCode": 0, "tests": 48, "skips": 0},
        {"command": "node /workspace/capirov2/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc --project docs/cleanup-retirement-import-free-http-client-20261012/tsconfig.client.json", "exitCode": 0},
    ],
    "nativeApiFixtureRun": False, "realTransportOrDatabase": False,
}
(packet / "RECEIPT.json").write_text(json.dumps(receipt, indent=2) + "\n")
all_paths = set(paths) | {str(p.relative_to(root)) for p in packet.rglob("*") if p.is_file()}
all_paths.discard(str((packet / "SHA256SUMS.json").relative_to(root)))
(packet / "SHA256SUMS.json").write_text(json.dumps({p: digest((root / p).read_bytes()) for p in sorted(all_paths)}, indent=2) + "\n")
print(json.dumps({"sourcePaths": len(paths), "indexed": len(all_paths), "importOnlyInverse": True}))
