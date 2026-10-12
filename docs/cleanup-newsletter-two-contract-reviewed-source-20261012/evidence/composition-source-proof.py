"""Read-only Git/blob proof; no application, SQL, provider or native execution."""

import hashlib
import json
import re
import subprocess
from pathlib import Path


def git(*args):
    return subprocess.check_output(["git", *args])


def tree(ref):
    rows = {}
    for record in git("ls-tree", "-rz", ref).split(b"\0"):
        if record:
            metadata, path = record.split(b"\t", 1)
            rows[path.decode()] = metadata.decode()
    return rows


packet = Path(__file__).resolve().parents[1]
manifest = json.loads((packet / "SOURCE-MANIFEST.json").read_text())
base = manifest["publishedBase"]
frozen = manifest["frozenNewsletterSource"]
candidate = git("rev-parse", "HEAD").decode().strip()
base_tree, frozen_tree, current_tree = tree(base), tree(frozen), tree(candidate)
source_paths = {row["file"] for row in manifest["sourceFiles"]}
assert len(source_paths) == 76
changed = {
    path
    for path in set(base_tree) | set(current_tree)
    if base_tree.get(path) != current_tree.get(path) and not path.startswith("docs/")
}
assert changed == source_paths, sorted(changed ^ source_paths)
source_drift = {
    path
    for path in set(frozen_tree) | set(current_tree)
    if frozen_tree.get(path) != current_tree.get(path) and not path.startswith("docs/")
}
assert not source_drift, sorted(source_drift)
for row in manifest["sourceFiles"]:
    path = row["file"]
    assert current_tree[path] == row["git"], path
    assert hashlib.sha256(git("show", f"{candidate}:{path}")).hexdigest() == row["sha256"], path
outside = [path for path in base_tree if path not in source_paths]
assert all(current_tree.get(path) == base_tree[path] for path in outside)
schema_paths = [path for path in base_tree if re.search(r"(?:schema\.prisma$|/migrations/)", path)]
changed_schema = [path for path in schema_paths if base_tree[path] != current_tree.get(path)]
assert changed_schema == ["apps/api/prisma/schema.prisma", "apps/workspace/prisma/schema.prisma"]
new_schema = [
    path
    for path in current_tree
    if path not in base_tree and re.search(r"(?:schema\.prisma$|/migrations/)", path)
]
assert len(schema_paths) == 603 and len(new_schema) == 14
for ref in [
    base,
    frozen,
    manifest["authorFinalPacket"],
    manifest["runtimePublicationContinuityReview"],
    manifest["independentSchemaDependencyReview"],
    manifest["independentAuthorizationReplayReview"],
]:
    subprocess.run(["git", "merge-base", "--is-ancestor", ref, candidate], check=True)
print(json.dumps({
    "candidate": candidate,
    "tree": git("rev-parse", f"{candidate}^{{tree}}").decode().strip(),
    "publishedBase": base,
    "frozenSource": frozen,
    "sourceDelta": len(source_paths),
    "nonDocumentDriftFromFrozenSource": 0,
    "exactBaselinePathsOutsideSourceDeltaIncludingDocuments": len(outside),
    "exactBaselineDocuments": sum(path.startswith("docs/") for path in outside),
    "baselineSchemaMigrationPaths": len(schema_paths),
    "additiveSchemaOwners": changed_schema,
    "otherBaselineSchemaMigrationPathsExact": len(schema_paths) - len(changed_schema),
    "originalHistoricalMigrationSourcesAdded": len(new_schema),
    "candidateSourceBlobsAndModesExact": True,
    "publishedAuthorAndReviewAncestorsExact": True,
    "protectedReportingBodiesRead": False,
    "databaseSqlProviderNativeApplicationExecution": False,
    "passed": True,
}, indent=2))
