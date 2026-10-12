"""Read-only Git/object evidence. Never execute application or qualification code."""
import hashlib
import json
from pathlib import Path
import subprocess

BASE = "5470c6df029c9553dd49e531229c3c91b26275ef"
FROZEN = "b877e03c5710bfc347568c7bbd1197f7caedbcde"
ROOT = "27755f153efc5b027eb37687540b428f910e8f11"
ENGAGEMENT = "e35d37ec080bbfbc5fccc0affe543af5b31fc1e2"
OUTREACH = "4060915ebfa55db4a8fb805c1e25281359c46a5d"
FIXTURE = "133c868ea596cccb05525d1249ddf32c97fe1a54"
PACKET = Path(__file__).resolve().parents[1]

def git(*args):
    return subprocess.check_output(["git", *args])

def tree(ref):
    return {entry.split(b"\t", 1)[1].decode(): entry.split(b"\t", 1)[0].decode()
            for entry in git("ls-tree", "-r", "-z", ref).split(b"\0") if entry}

def source_delta(ref):
    return [p.decode() for p in git("diff", "--name-only", "-z", BASE, ref).split(b"\0")
            if p and not p.startswith(b"docs/")]

current = tree("HEAD")
baseline = tree(BASE)
frozen = tree(FROZEN)
owners = {}
for owner in [ROOT, ENGAGEMENT, OUTREACH, FIXTURE]:
    for path in source_delta(owner):
        assert path not in owners, ("overlapping component", path)
        owners[path] = owner
assert len(owners) == 20
assert set(source_delta("HEAD")) == set(owners)
entries = []
for path, owner in sorted(owners.items()):
    authoritative = tree(owner)[path]
    assert current[path] == authoritative == frozen[path], ("component drift", path)
    blob = git("show", "HEAD:" + path)
    entries.append({"path": path, "owner": owner, "git": authoritative,
                    "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest()})

protected = {p: v for p, v in baseline.items() if p not in owners}
assert all(current.get(p) == v for p, v in protected.items()), "baseline preservation failure"
assert not (set(current) - set(baseline) - set(owners) - {p for p in current if p.startswith("docs/")})
schema = [p for p in baseline if p.endswith("schema.prisma") or "/migrations/" in p]
assert all(current[p] == baseline[p] for p in schema)
newsletter_manifest = json.loads(git("show", BASE + ":docs/cleanup-newsletter-two-contract-reviewed-source-20261012/SOURCE-MANIFEST.json"))
newsletter = newsletter_manifest["sourceFiles"]
assert len(newsletter) == 76
assert all(current[e["file"]] == baseline[e["file"]] for e in newsletter)
prior_master = "docs/cleanup-newsletter-two-contract-reviewed-source-20261012/SHA256SUMS.json"
assert prior_master in baseline
assert current[prior_master] == baseline[prior_master]

result = {
    "baseline": BASE, "baselineTree": git("rev-parse", BASE + "^{tree}").decode().strip(),
    "reviewedSource": FROZEN, "reviewedTree": git("rev-parse", FROZEN + "^{tree}").decode().strip(),
    "compositionChecked": git("rev-parse", "HEAD").decode().strip(),
    "sourcePaths": len(entries), "protectedBaselineEntries": len(protected),
    "schemaMigrationPathsExact": len(schema), "newsletterSourcePathsExact": len(newsletter),
    "baselineDocsExact": sum(p.startswith("docs/") for p in protected),
    "entries": entries,
    "qualification": "Git blob/mode and SHA-256 source evidence only. No application, SQL, native, verifier, provider or CI execution."
}
(PACKET / "SOURCE-MANIFEST.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({k: v for k, v in result.items() if k != "entries"}, indent=2))
