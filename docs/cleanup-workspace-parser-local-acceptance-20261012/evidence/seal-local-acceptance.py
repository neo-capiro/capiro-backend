from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
PACKET = ROOT / "docs/cleanup-workspace-parser-local-acceptance-20261012"
BASE = "61e9b467295235829e7d8097368ce41b0434818a"


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=ROOT)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write(name: str, value: object) -> None:
    (PACKET / name).write_text(json.dumps(value, indent=2) + "\n")


changed = git("diff", "--name-only", BASE, "HEAD").decode().splitlines()
source = [p for p in changed if not p.startswith("docs/")]
newsletter = "e2f04d1a0d0f035a4f2fbf6e502323915c4240ba"
python = "ab0fc946192f3f49ce9e94d66a3d3ac5cf7a94cf"
count = "5a3c73f0b626a0d659d1a4fbbdb1ef37040310e6"
reviews = {
    newsletter: "2c9192959662507302424f63eaa5f522876894e2",
    python: "96c1db880f1b8f8ed0edf65a0abf5073baeeb1f7",
    count: "96c1db880f1b8f8ed0edf65a0abf5073baeeb1f7",
}
assert len(source) == 9, source
rows = []
for path in source:
    owner = python if path.startswith("apps/defense-budget-parser/") else (
        count if path == "apps/workspace/test/cascade.spec.ts" else newsletter
    )
    before = git("show", f"{BASE}:{path}")
    accepted = git("show", f"{owner}:{path}")
    current = (ROOT / path).read_bytes()
    assert accepted == current
    rows.append({
        "path": path, "beforeSha256": sha(before), "sha256": sha(current),
        "acceptedSource": owner, "acceptedTree": git("rev-parse", f"{owner}^{{tree}}").decode().strip(),
        "independentReview": reviews[owner],
        "independentReviewTree": git("rev-parse", f"{reviews[owner]}^{{tree}}").decode().strip(),
    })
def tree(ref: str) -> dict[str, str]:
    return {
        line.split("\t", 1)[1]: line.split("\t", 1)[0].split()[2]
        for line in git("ls-tree", "-r", ref).decode().splitlines()
    }


before_tree = tree(BASE)
current_tree = tree("HEAD")
all_before = list(before_tree)
protected = [p for p in all_before if not p.startswith("docs/") and p not in source]
for path in protected:
    assert before_tree[path] == current_tree[path], path
schemas = [p for p in all_before if p.endswith(".prisma") or "/migrations/" in p]
assert all(before_tree[p] == current_tree[p] for p in schemas)
write("SOURCE-MANIFEST.json", {
    "base": BASE, "baseTree": git("rev-parse", f"{BASE}^{{tree}}").decode().strip(),
    "candidateSourceHead": git("rev-parse", "HEAD").decode().strip(),
    "candidateSourceTree": git("rev-parse", "HEAD^{tree}").decode().strip(),
    "changedSourcePaths": rows, "allOtherTrackedNonDocsUnchanged": len(protected),
    "preservedSchemaAndMigrationPaths": len(schemas),
    "schemaMigrationNonDocs": len([p for p in schemas if not p.startswith("docs/")]),
    "scope": "Three newsletter specs, five reviewed Python paths, one Cascade count literal; no package/lock/CI/contract/schema changes",
})
old_index_path = "docs/cleanup-retirement-bounded-verification-integration-20261012/SHA256SUMS.json"
old = json.loads(git("show", f"{BASE}:{old_index_path}"))
for path, digest in old.items():
    assert sha((ROOT / path).read_bytes()) == digest, path
write("PRESERVATION-RECEIPT.json", {
    "inheritedIndex": old_index_path, "inheritedFiles": len(old),
    "allInheritedEvidenceBytesPreserved": True,
    "candidateSourceChanges": len(source), "allOtherTrackedNonDocsUnchanged": len(protected),
    "sourceWhitespaceExit": subprocess.run(["git", "diff", "--check", BASE, "HEAD", "--", *source], cwd=ROOT, capture_output=True).returncode,
})
full = subprocess.run(["git", "diff", "--check", BASE, "HEAD"], cwd=ROOT, capture_output=True)
(PACKET / "evidence/full-new-range-whitespace.log").write_bytes(full.stdout + full.stderr)
write("WHITESPACE-RECEIPT.json", {
    "base": BASE, "to": git("rev-parse", "HEAD").decode().strip(), "exitCode": full.returncode,
    "qualification": "Full committed evidence range remains open; raw bytes are preserved without exclusions or waiver",
})
matrix = json.loads((ROOT / "docs/cleanup-backend-native-prerequisite-audit-20261012/CURRENT-GATE-MATRIX.json").read_text())
updates = {
    "pythonCI": (
        "Reviewed five-path correction closes all eight original Ruff and three mypy diagnostics. Final Ruff0, mypy0/37files and pytest283/283 with zero skips pass; original REDs and79percent coverage remain preserved.",
        ["Hosted supported Python3.11/3.12 frozen-install CI remains unexecuted; local acceptance is complete for installed base+dev dependencies."],
    ),
    "architectureCI": (
        "All four actual architecture guards pass against origin/main with raw receipts; current source wires all four. Hosted CI is unexecuted.",
        ["Same-source hosted CI output and status remain separate from local execution."],
    ),
    "baselineFailures": (
        "Current CI formatter scope passes. Existing Meri139 count passes unchanged; reviewed Cascade10-to11 correction passes all seven preserved cases. Full committed range still has preserved raw whitespace warnings; older formatter/Meri/pathname REDs are historical.",
        ["Full-suite current-floor acceptance; preserve Memory manual-command/operator provenance gaps and raw evidence; native Windows lifecycle remains unqualified."],
    ),
    "casePreservation": (
        "Only nine independently accepted source paths change; all newsletter and Cascade case identities/assertion scope remain bound, Python logical equivalence and original283 case identities are independently checked. Complete cross-runner multiset remains open.",
        ["Whole current cross-runner names/status/errors reconciled to authentic original/full coverage floors; no new skip/only/quarantine or manufactured passing baseline."],
    ),
    "cleanFullGate": (
        "Pinned pnpm9.12, Shared/Auth/MCore builds, full Workspace typecheck/build and all17 canonical Core typecheck segments pass on exact cached prerequisites. Current native-bearing Core/Workspace clients generated offline; no whole frozen install/full gate.",
        ["Clean isolated full frozen install and remaining CI projection contexts; verified disposable PG/roles/fixture history; pinned visual runtime; authentic complete coverage floor and whole runner receipts."],
    ),
}
for row in matrix["criteria"]:
    if row["id"] in updates:
        row["currentSourceQualification"], row["requiredCapabilitiesOrEvidence"] = updates[row["id"]]
matrix["source"] = git("rev-parse", "HEAD").decode().strip()
matrix["tree"] = git("rev-parse", "HEAD^{tree}").decode().strip()
matrix["historicalSnapshotUnmodified"] = "../cleanup-backend-native-prerequisite-audit-20261012/CURRENT-GATE-MATRIX.json"
write("CURRENT-GATE-MATRIX.json", matrix)
final_checks = []
for label, filename, code in [
    ("Workspace final spec typecheck", "workspace-final-spec-typecheck.log", 0),
    ("Python proposed format remaining E501", "python-ruff-repaired.log", 1),
    ("Python final Ruff", "python-ruff-final.log", 0),
    ("Python repaired mypy37", "python-mypy-repaired.log", 0),
    ("Python final pytest283", "python-pytest-final.log", 0),
    ("Current exact CI formatter scope", "ci-format-scope-current.log", 0),
]:
    path = PACKET / "evidence" / filename
    raw = path.read_bytes()
    final_checks.append({"label": label, "exitCode": code, "log": str(path.relative_to(ROOT)), "bytes": len(raw), "sha256": sha(raw)})
write("LOCAL-FINAL-CHECKS.json", {"originalLocalChecksUnmodified": "LOCAL-CHECKS.json", "checks": final_checks, "canonicalCoreTypecheck": "../cleanup-core-canonical-typechain-probe-20261012/evidence/result.json"})
paths = set(old) | set(changed) | {old_index_path}
component_results = []
indices = [
    "docs/cleanup-exact-parser-backend-acceptance-independent-review-20261012/SHA256-INDEX.json",
    "docs/cleanup-newsletter-mocked-local-acceptance-20261012/SHA256-INDEX.json",
    "docs/cleanup-runtime-characterization-61e9-20261012/SHA256.json",
    "docs/cleanup-newsletter-mocked-fixture-independent-review-20261012/SHA256-INDEX.json",
    "docs/cleanup-python-quality-independent-review-20261012/SHA256-INDEX.json",
    "docs/cleanup-core-canonical-typechain-probe-20261012/SHA256-INDEX.json",
]
for path in indices:
    data = json.loads((ROOT / path).read_text())
    entries = data.get("packet", data.get("entries", data.get("files")))
    assert isinstance(entries, list), path
    for row in entries:
        raw = (ROOT / row["path"]).read_bytes()
        assert sha(raw) == row["sha256"], row["path"]
    component_results.append({"index": path, "checkedEntries": len(entries), "allPass": True})
for path in [
    "docs/cleanup-backend-native-prerequisite-audit-20261012/SHA256SUMS",
    "docs/cleanup-stale-catalog-count-tests-20261012/SHA256SUMS",
]:
    entries = (ROOT / path).read_text().splitlines()
    for line in entries:
        digest, filename = line.split("  ", 1)
        assert sha((ROOT / filename).read_bytes()) == digest, filename
    component_results.append({"index": path, "checkedEntries": len(entries), "allPass": True})
write("COMPONENT-INDEX-VERIFICATION.json", component_results)
paths |= {str(p.relative_to(ROOT)) for p in PACKET.rglob("*") if p.is_file()}
paths.discard(str((PACKET / "SHA256SUMS.json").relative_to(ROOT)))
write("SHA256SUMS.json", {p: sha((ROOT / p).read_bytes()) for p in sorted(paths)})
print(json.dumps({"sourcePaths": len(source), "preservedNonDocs": len(protected), "schemasAndMigrations": len(schemas), "inheritedEvidence": len(old), "indexedFiles": len(paths), "newRangeWhitespaceExit": full.returncode}))
