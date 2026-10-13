#!/usr/bin/env python3
"""Read-only validation of the frozen split proposal against Git metadata.

Does not use network, inspect protected bodies, create refs, push, change settings,
or execute source scripts/workflows/migrations. Output is a bounded JSON receipt.
"""
import collections
import hashlib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
SOURCE = "b9da0ae2938821e08a3bfea563c6267608ae9909"
TREE = "91436b73ebff4c9807c5c877093e8502430a50c9"

def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()

def read(name):
    return json.loads((ROOT / "evidence" / name).read_text())

assert git("rev-parse", SOURCE + "^{tree}") == TREE
entries = {}
for line in git("ls-tree", "-r", SOURCE).splitlines():
    meta, path = line.split("\t", 1)
    mode, kind, blob = meta.split()
    entries[path] = {"mode": mode, "type": kind, "blob": blob}

boundary = read("source-boundary.json")
assert boundary["source_head"] == SOURCE and boundary["source_tree"] == TREE
assert len(entries) == boundary["source_tree_entry_count"]
assert boundary["repository_AGENTS_paths"] == []
assert not any(path.split("/")[-1] == "AGENTS.md" for path in entries)
for row in boundary["protected_published_entry_metadata_only"]:
    assert entries[row["path"]] == {k: row[k] for k in ("mode", "type", "blob")}

plan = read("automation-quarantine-plan.json")
assert plan["source_head"] == SOURCE and plan["source_tree"] == TREE
workflows = {p for p in entries if p.startswith(".github/workflows/")}
planned = {r["path"] for r in plan["rows"]}
assert planned == workflows | {".github/dependabot.yml"}
assert len(workflows) == plan["workflow_count"] == 73
assert len(plan["rows"]) == 74
assert len({r["proposed_quarantine"] for r in plan["rows"]}) == 74
for row in plan["rows"]:
    assert entries[row["path"]] == {k: row[k] for k in ("mode", "type", "blob")}
    assert row["proposed_quarantine"].startswith("docs/backend-repository-split-preparation-20261013/quarantine/")
    assert row["proposed_quarantine"].endswith(".disabled")
    assert row["proposed_quarantine"] not in entries

for filename, key in [("workspace-package-coupling.json", "packages"),
                      ("deployment-coupling.json", "records")]:
    document = read(filename)
    assert document["source_head"] == SOURCE
    for row in document[key]:
        assert entries[row["path"]]["blob"] == row["blob"]

inventory = read("candidate-reachability.json")
remote = read("open-pull-metadata.json")["pulls"]
assert inventory["receiving_head"] == SOURCE and inventory["receiving_tree"] == TREE
assert inventory["receiving_reachable_commit_count"] == int(git("rev-list", "--count", SOURCE)) == 9680
assert inventory["open_pull_count"] == len(remote) == len(inventory["open_pulls"]) == 301
assert {r["number"]: r["head"]["sha"] for r in remote} == {r["number"]: r["head"]["sha"] for r in inventory["open_pulls"]}
counts = collections.Counter("missing-local-object" if not r["local_object"] else
    "main-ancestor" if r["reachable_from_main"] else
    "receiving-ancestor" if r["reachable_from_receiving"] else
    "held-unmerged-candidate" for r in inventory["open_pulls"])
assert dict(counts) == inventory["counts"]
assert len(inventory["original_ledger_candidates"]) == 16
assert sum(r["reachable_from_receiving"] for r in inventory["original_ledger_candidates"]) == 15
for row in inventory["open_pulls"] + inventory["original_ledger_candidates"]:
    if row["local_object"]:
        sha = row.get("original_head") or row["head"]["sha"]
        assert git("rev-parse", sha + "^{tree}") == row["tree"]

changes = git("diff", "--name-only", SOURCE).splitlines()
assert all(p.startswith("docs/backend-repository-split-preparation-20261013/") for p in changes)
print(json.dumps({"status": "PASS", "source_head": SOURCE, "source_tree": TREE,
    "source_tree_entries": len(entries), "reachable_commits": 9680,
    "open_prs": len(remote), "original_ledger_heads": 16,
    "workflow_quarantine_rows": 74, "new_destination_operations": [],
    "protected_body_reads": [], "product_or_live_config_changes": [],
    "limit": "frozen metadata and proposal validation only; no final-source, destination-creation or deployment acceptance"}, indent=2))
