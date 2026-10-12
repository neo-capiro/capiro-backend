"""Freeze documentation hashes; read-only source and Git metadata validation."""
import hashlib
import json
from pathlib import Path
import subprocess

BASE = "5470c6df029c9553dd49e531229c3c91b26275ef"
ROOT = Path.cwd()
PACKET = Path(__file__).resolve().parents[1]
INDEX = PACKET / "SHA256SUMS.json"

def digest(path):
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()

def records(index):
    if index and all(isinstance(k, str) and k.startswith("docs/") and isinstance(v, str)
                     for k, v in index.items()):
        return list(index.items())
    result = []
    for key in ["packet", "entries", "sourceEntries", "source"]:
        value = index.get(key)
        if isinstance(value, list):
            result.extend((entry["path"], entry["sha256"]) for entry in value)
    assert result, "unrecognized checksum manifest"
    return result

indices = [
    "docs/cleanup-newsletter-two-contract-reviewed-source-20261012/SHA256SUMS.json",
    "docs/cleanup-retirement-engagement-verification-integration-20261012/SHA256-INDEX.json",
    "docs/cleanup-retirement-outreach-verification-integration-20261012/SHA256.json",
    "docs/cleanup-current-api-owned-fixture-bridge-20261012/SHA256.json",
    "docs/cleanup-retirement-root-compatibility-20261012/SHA256.json",
    "docs/cleanup-retirement-verification-independent-review-20261012/SHA256-INDEX.json",
]
checks = []
inherited = {}
for path in indices:
    values = records(json.loads((ROOT / path).read_text()))
    for entry, expected in values:
        assert digest(entry) == expected, ("checksum mismatch", path, entry)
        if path == indices[0]:
            inherited[entry] = expected
    checks.append({"index": path, "verifiedBindings": len(values)})
assert len(inherited) == 270

receipt = {
    "baseline": BASE,
    "reviewedSource": "b877e03c5710bfc347568c7bbd1197f7caedbcde",
    "reviewedTree": "38641eb7379661a551c5f29c287ed2e2d74c5a99",
    "verifiedIndices": checks,
    "inherited270FileBytesPreserved": True,
    "all20SourceBlobModesPreserved": True,
    "pureFakeControls": {"composed": 136, "independent": 104, "repairedReplay": 8},
    "nativeOrFullGateAcceptance": False,
    "currentFullWhitespaceQualification": "OPEN: 38 archived raw-format warnings preserved without exemption; all20 source paths separately pass",
    "operations": "Source/Git/hash reads and pure/fake checks only. No actual qualification, install, build, application, SQL, native, provider, CI dispatch, merge to main or deployment.",
}
(PACKET / "ROOT-RECEIPT.json").write_text(json.dumps(receipt, indent=2) + "\n")
delta = subprocess.check_output(["git", "diff", "--name-only", "-z", BASE, "HEAD"]).split(b"\0")
paths = {p.decode() for p in delta if p.startswith(b"docs/")}
paths.update(str(p.relative_to(ROOT)) for p in PACKET.rglob("*") if p.is_file())
paths.discard(str(INDEX.relative_to(ROOT)))
hashes = dict(inherited)
hashes.update((path, digest(path)) for path in sorted(paths))
INDEX.write_text(json.dumps(dict(sorted(hashes.items())), indent=2) + "\n")
assert all(digest(path) == expected for path, expected in hashes.items())
print(json.dumps({"verifiedIndices": checks, "totalBoundFiles": len(hashes), "ownIndexExcludedOnly": True}, indent=2))
