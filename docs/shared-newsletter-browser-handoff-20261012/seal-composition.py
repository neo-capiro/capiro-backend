import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
packet = Path(__file__).resolve().parent
base = "d587441261fd356ee5144a8fc29cb2f771d062b8"
producer = "0180fd0b6564444cf029446cce56da652b1644fb"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=root)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


changed = git("diff", "--name-only", base, "HEAD").decode().splitlines()
assert all(p.startswith("docs/") for p in changed), changed
old_index = "docs/cleanup-workspace-parser-local-acceptance-20261012/SHA256SUMS.json"
inherited = json.loads(git("show", f"{base}:{old_index}"))
for path, digest in inherited.items():
    assert sha((root / path).read_bytes()) == digest, path
checks = []
for path in [
    "docs/shared-newsletter-packed-distribution-20261012/SHA256-INDEX.json",
    "docs/cleanup-outreach-metadata-retirement-contract-audit-20261012/SHA256-INDEX.json",
    "docs/cleanup-shared-packed-newsletter-independent-review-20261012/SHA256-INDEX.json",
]:
    index = root / path
    data = json.loads(index.read_text())
    entries = data.get("files", data.get("packet", data.get("entries")))
    assert isinstance(entries, list), path
    for row in entries:
        file = root / row["path"]
        if not file.is_file():
            file = index.parent / row["path"]
        assert sha(file.read_bytes()) == row["sha256"], row["path"]
    checks.append({"index": path, "entries": len(entries), "allPass": True})
source = "fe50dc1c2de1660a036e338cf81acdcf0f2fb26a"
shared = git("ls-tree", "-r", "--name-only", source, "packages/shared").decode().splitlines()
shared.append("tsconfig.base.json")
for path in shared:
    assert git("show", f"{source}:{path}") == git("show", f"{base}:{path}") == (root / path).read_bytes(), path
receipt = {
    "base": base, "producer": producer,
    "independentReview": "49036163736497f15e395005b90c0880e10e223d",
    "independentReviewTree": "e8d00f7a9baeedd2bb748aec74ebdcad8cc5e422",
    "producerTree": git("rev-parse", f"{producer}^{{tree}}").decode().strip(),
    "artifactSource": source, "sharedAndCompilerFilesExact": len(shared),
    "nonDocumentSourceChanges": 0,
    "inheritedIndexedFilesExact": len(inherited), "componentChecks": checks,
    "receivingContractSha256": sha((root / "docs/contracts/newsletter-outreach-response-routing.md").read_bytes()),
    "frontendConsumptionOrDispatchClaim": False, "nativeRlsOrDeploymentClaim": False,
}
(packet / "COMPOSITION-RECEIPT.json").write_text(json.dumps(receipt, indent=2) + "\n")
paths = set(inherited) | {old_index} | set(changed)
paths |= {str(p.relative_to(root)) for p in packet.rglob("*") if p.is_file()}
paths.discard(str((packet / "SHA256SUMS.json").relative_to(root)))
(packet / "SHA256SUMS.json").write_text(json.dumps({p: sha((root / p).read_bytes()) for p in sorted(paths)}, indent=2) + "\n")
print(json.dumps({"indexed": len(paths), "inherited": len(inherited), "sharedAndCompilerExact": len(shared), "sourceChanges": 0, "componentChecks": checks}))
