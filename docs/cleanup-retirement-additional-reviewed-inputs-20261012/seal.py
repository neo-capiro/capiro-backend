import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
packet = Path(__file__).resolve().parent
base = "f76a101fd8b4fe9e1437a2d433924d1b81d82325"
published = "67fa9255b8a73f489d7a57c8fe270ed6d03fa016"
operating = "7a425df71ce2162bbfdfd430a10d285a179e2832"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=root)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def write(name, data):
    (packet / name).write_text(json.dumps(data, indent=2) + "\n")


changed = git("diff", "--name-only", base, "HEAD").decode().splitlines()
source = [p for p in changed if not p.startswith("docs/")]
contract = "docs/contracts/outreach-v3-verification-inputs-v1.md"
assert len(source) == 11, source
operating_paths = {"scripts/ci/outreach-operating-inputs.spec.mjs", "scripts/verify-outreach-v3-p1-architecture.mjs"}
rows = []
for path in source + [contract]:
    accepted = operating if path in operating_paths else published
    raw = (root / path).read_bytes()
    assert raw == git("show", f"{accepted}:{path}"), path
    rows.append({"path": path, "acceptedSource": accepted, "blob": git("rev-parse", f"{accepted}:{path}").decode().strip(), "mode": git("ls-tree", accepted, "--", path).decode().split()[0], "bytes": len(raw), "sha256": sha(raw)})
write("SOURCE-MANIFEST.json", {"base": base, "publishedCode": published, "nonDocumentPaths": len(source), "ownedContractDocuments": 1, "paths": rows, "operatingDifferences": "Preserve current smoke/Usage; inverse-baseline hash adaptation; bare-marker/LF refusal repair and seven controls"})
old_path = "docs/cleanup-retirement-reviewed-owner-inputs-20261012/SHA256SUMS.json"
old = json.loads(git("show", f"{base}:{old_path}"))
assert all(sha((root / p).read_bytes()) == h for p, h in old.items())
checks = []
for path in [
    "docs/cleanup-intelligence-meri-fixture-adoption-20261012/SHA256-INDEX.json",
    "docs/cleanup-outreach-skeleton-owned-input-adoption-20261012/SHA256-INDEX.json",
    "docs/cleanup-outreach-operating-inputs-adoption-20261012/SHA256-INDEX.json",
    "docs/cleanup-static-fixtures-independent-review-20261012/SHA256-INDEX.json",
    "docs/cleanup-outreach-operating-inputs-independent-review-20261012/SHA256-INDEX.json",
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
before = {line.split("\t", 1)[1]: line.split("\t", 1)[0].split()[2] for line in git("ls-tree", "-r", base).decode().splitlines()}
after = {line.split("\t", 1)[1]: line.split("\t", 1)[0].split()[2] for line in git("ls-tree", "-r", "HEAD").decode().splitlines()}
protected = [p for p in before if not p.startswith("docs/") and p not in source]
assert all(before[p] == after[p] for p in protected)
schema = [p for p in before if p.endswith(".prisma") or "/migrations/" in p]
assert all(before[p] == after[p] for p in schema)
for label, paths in [("selected-source", source), ("full-new-range", [])]:
    check = subprocess.run(["git", "diff", "--check", base, "HEAD", *( ["--", *paths] if paths else [] )], cwd=root, capture_output=True)
    (packet / f"{label}-whitespace.log").write_bytes(check.stdout + check.stderr)
    write(f"{label}-whitespace.json", {"base": base, "to": git("rev-parse", "HEAD").decode().strip(), "exitCode": check.returncode, "qualification": "OPEN: inherited exact snapshot/raw EOF bytes preserved without trimming, re-encoding or exclusions"})
reviews = ["27bc19ac6650bb4ca34c9e2bbcc8fa9fdae622aa", "d052234bed3b615c508dac6ce45962026de9e030"]
write("COMPOSITION-RECEIPT.json", {"base": base, "sourceNonDocs": len(source), "ownedContractDocuments": 1, "otherNonDocsExact": len(protected), "schemaMigrationHistoryExact": len(schema), "inheritedFilesExact": len(old), "componentChecks": checks, "independentReviews": [{"head": ref, "tree": git("rev-parse", f"{ref}^{{tree}}").decode().strip(), "ancestor": subprocess.run(["git", "merge-base", "--is-ancestor", ref, "HEAD"], cwd=root).returncode == 0} for ref in reviews], "fullFloorOrNativeAcceptance": False, "deniedReportReadOrRepublished": False})
paths = set(old) | {old_path} | set(changed)
paths |= {str(p.relative_to(root)) for p in packet.rglob("*") if p.is_file()}
paths.discard(str((packet / "SHA256SUMS.json").relative_to(root)))
write("SHA256SUMS.json", {p: sha((root / p).read_bytes()) for p in sorted(paths)})
print(json.dumps({"sourceNonDocs": len(source), "ownedContract": 1, "indexed": len(paths), "inherited": len(old), "schema": len(schema), "componentChecks": checks}))
