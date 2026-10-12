import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
packet = Path(__file__).resolve().parent
base = "62d057b4a17b2c038920f10b93e83e51e46239bc"
published = "67fa9255b8a73f489d7a57c8fe270ed6d03fa016"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=root)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def write(name, data):
    (packet / name).write_text(json.dumps(data, indent=2) + "\n")


changed = git("diff", "--name-only", base, "HEAD").decode().splitlines()
source = [p for p in changed if not p.startswith("docs/")]
assert len(source) == 13, source
rows = []
for path in source:
    raw = (root / path).read_bytes()
    assert raw == git("show", f"{published}:{path}"), path
    rows.append({"path": path, "sha256": sha(raw), "bytes": len(raw), "publishedBlob": git("rev-parse", f"{published}:{path}").decode().strip()})
write("SOURCE-MANIFEST.json", {"base": base, "publishedSource": published, "paths": rows})
old_path = "docs/shared-newsletter-browser-handoff-20261012/SHA256SUMS.json"
old = json.loads(git("show", f"{base}:{old_path}"))
assert all(sha((root / p).read_bytes()) == h for p, h in old.items())
indices = [
    "docs/cleanup-memory-funding-static-fixture-adoption-20261012/SHA256-INDEX.json",
    "docs/cleanup-memory-funding-fixtures-independent-review-20261012/SHA256-INDEX.json",
    "docs/cleanup-retirement-http-client-independent-review-20261012/SHA256-INDEX.json",
    "docs/cleanup-retirement-import-free-http-client-20261012/SHA256SUMS.json",
]
checks = []
for path in indices:
    index = root / path
    data = json.loads(index.read_text())
    if "files" in data:
        rows = data["files"]
    elif "packet" in data:
        rows = data["packet"]
    else:
        rows = [{"path": p, "sha256": h} for p, h in data.items()]
    for row in rows:
        file = root / row["path"]
        if not file.is_file():
            file = index.parent / row["path"]
        assert sha(file.read_bytes()) == row["sha256"], row["path"]
    checks.append({"index": path, "entries": len(rows), "allPass": True})
before_tree = {line.split("\t", 1)[1]: line.split("\t", 1)[0].split()[2] for line in git("ls-tree", "-r", base).decode().splitlines()}
after_tree = {line.split("\t", 1)[1]: line.split("\t", 1)[0].split()[2] for line in git("ls-tree", "-r", "HEAD").decode().splitlines()}
protected = [p for p in before_tree if not p.startswith("docs/") and p not in source]
assert all(before_tree[p] == after_tree[p] for p in protected)
schema = [p for p in before_tree if p.endswith(".prisma") or "/migrations/" in p]
assert all(before_tree[p] == after_tree[p] for p in schema)
check = subprocess.run(["git", "diff", "--check", base, "HEAD", "--", *source], cwd=root, capture_output=True)
assert check.returncode == 0
write("COMPOSITION-RECEIPT.json", {"base": base, "sourcePaths": len(source), "otherNonDocsExact": len(protected), "schemaAndMigrationHistoryExact": len(schema), "inheritedIndexedFilesExact": len(old), "componentIndices": checks, "sourceWhitespaceExit": check.returncode, "fullWhitespaceFloor": "OPEN: physical raw evidence retained", "nativeApiIntegrationRun": False, "retirementReportCopied": False})
paths = set(old) | {old_path} | set(changed)
for folder in [packet, root / "docs/cleanup-retirement-import-free-http-client-20261012"]:
    paths |= {str(p.relative_to(root)) for p in folder.rglob("*") if p.is_file()}
paths.discard(str((packet / "SHA256SUMS.json").relative_to(root)))
write("SHA256SUMS.json", {p: sha((root / p).read_bytes()) for p in sorted(paths)})
print(json.dumps({"sourcePaths": len(source), "indexed": len(paths), "inherited": len(old), "schema": len(schema), "componentChecks": checks}))
