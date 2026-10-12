#!/usr/bin/env python3
"""Read-only report/source receipt audit; never invokes a runner or package manager."""
import collections
import hashlib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(sys.argv[1]).resolve()
OUT = pathlib.Path(__file__).resolve().parent
START = "07d0e0b9ab62513a83e665aa67efcc54283a2382"
REVIEWED = "ed1cb70cad206949ee27657d5748e2832952a0f1"
COMPLETION = "b2b7f2f5d50b894d895325d50b833776cea33390"
INPUTS = {}
CHECKS = []


def require(value, label):
    CHECKS.append({"check": label, "passed": bool(value)})
    if not value:
        raise AssertionError(label)


def read(relative):
    raw = (ROOT / relative).read_bytes()
    INPUTS[relative] = {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
    return json.loads(raw)


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args], text=True).strip()


def file_name(suite):
    # Worktree prefixes differ; preserve all path content beneath apps/web.
    pieces = suite["name"].split("/apps/web/", 1)
    if len(pieces) != 2:
        raise AssertionError("report file is not beneath apps/web: " + suite["name"])
    return pieces[1]


def summarize(report):
    cases = collections.Counter()
    files = collections.Counter()
    statuses = collections.Counter()
    failed_cases = []
    failure_messages = 0
    for suite in report["testResults"]:
        path = file_name(suite)
        files[path] += 1
        for assertion in suite["assertionResults"]:
            cases[(path, assertion["fullName"])] += 1
            statuses[assertion["status"]] += 1
            failure_messages += len(assertion.get("failureMessages", []))
            if assertion["status"] != "passed":
                failed_cases.append({"file": path, "fullName": assertion["fullName"], "status": assertion["status"]})
    aggregate = {k: report.get(k) for k in (
        "numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests",
        "numTotalTestSuites", "numPassedTestSuites", "numFailedTestSuites", "numPendingTestSuites", "success")}
    require(len(files) == len(report["testResults"]), "every report file normalizes beneath apps/web without collisions")
    require(sum(cases.values()) == aggregate["numTotalTests"], "leaf aggregate equals physical report cases")
    return cases, files, {"aggregate": aggregate, "physicalTestFiles": len(files), "physicalFileRecords": sum(files.values()),
                          "leafStatuses": dict(statuses), "failureMessageCount": failure_messages, "nonPassingCases": failed_cases}


paths = {
    "corrected": "docs/cleanup-executable-prereqs-20261012/evidence/web-full-corrected-runner-long-budget",
    "originalMain": "docs/cleanup-source-gates-20261012/evidence/web-full-main-baseline",
    "originalCandidate": "docs/cleanup-source-gates-20261012/evidence/web-full-source-unit",
}
reports = {name: read(path + ".json") for name, path in paths.items()}
commands = {name: read(path + ".command.json") for name, path in paths.items()}
first_command = read("docs/cleanup-executable-prereqs-20261012/evidence/web-full-corrected-runner.command.json")
budget = read("docs/cleanup-executable-prereqs-20261012/evidence/web-run-budget-reconciliation.json")
protection = read("docs/cleanup-executable-prereqs-20261012/evidence/web-long-run-source-family-protection.json")
for path in (paths["corrected"] + ".log", "docs/cleanup-executable-prereqs-20261012/evidence/web-full-corrected-runner.log"):
    raw = (ROOT / path).read_bytes()
    INPUTS[path] = {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}

summaries = {name: summarize(report) for name, report in reports.items()}
old, old_files, old_summary = summaries["originalMain"]
candidate, candidate_files, candidate_summary = summaries["originalCandidate"]
new, new_files, new_summary = summaries["corrected"]
require(old == candidate, "both original 6435-case multisets are identical")
require(old_files == candidate_files == new_files, "all 701 physical file records retained without additions or deletions")
require(len(new_files) == 701 and all(n == 1 for n in new_files.values()), "701 distinct physical test files")
require(sum(old.values()) == 6435 and sum(new.values()) == 6437, "original 6435 and corrected 6437 leaf cases")

path = "src/vnext/pages/program-elements/profile/PeProfileVNext.test.tsx"
prefix = "PeProfileVNext canonical pathname and explicit legacy override "
old_name = (path, prefix + "a lowercase pathname is not claimed and does not request a profile")
new_name = (path, prefix + "an ASCII-lowercase pathname is claimed, requests the canonical uppercase id and keeps the original URL")
negatives = [(path, prefix + "a static-segment or malformed pathname (" + segment + ") is not claimed as a line profile")
             for segment in ("reconciliation", "whatever")]
require(old[old_name] == 1 and new[new_name] == 1, "single explicit PE lowercase test rename")
expected = old.copy()
expected.subtract({old_name: 1})
expected += collections.Counter({new_name: 1, **{negative: 1 for negative in negatives}})
require(new == expected, "6435 prior cases retained under exactly one rename plus two specified negatives")
require(new_summary["leafStatuses"] == {"passed": 6437} and new_summary["failureMessageCount"] == 0,
        "every corrected leaf passed with no skips, pending, todo, failures or failure messages")
require(all(suite["status"] == "passed" for suite in reports["corrected"]["testResults"]), "all 701 physical file statuses passed")
require(new_summary["aggregate"] == {"numTotalTests": 6437, "numPassedTests": 6437, "numFailedTests": 0,
        "numPendingTests": 0, "numTodoTests": 0, "numTotalTestSuites": 1963, "numPassedTestSuites": 1963,
        "numFailedTestSuites": 0, "numPendingTestSuites": 0, "success": True}, "successful complete aggregate including 1963 nested suite records")

command = commands["corrected"]
expected_argv = ["node", "node_modules/vitest/vitest.mjs", "run", "--pool=threads", "--no-file-parallelism",
                 "--testTimeout=20000", "--hookTimeout=20000", "--reporter=json", "--outputFile",
                 str(ROOT / (paths["corrected"] + ".json"))]
require(command["argv"] == expected_argv, "exact serial source runner argv has no case selectors or skip flags")
require(command["exitCode"] == 0 and command["timedOut"] is False and command["nativeAcceptance"] is False,
        "completed source command exit zero, not timeout, not native acceptance")
require(command["seconds"] == 2173.6 and command["commandBudgetSeconds"] == 3600,
        "2173.6-second completion within separate 3600-second whole-command budget")
for name, previous in commands.items():
    require("--testTimeout=20000" in previous["argv"] and "--hookTimeout=20000" in previous["argv"],
            name + " retains 20-second case and hook timeouts")
require(first_command["timedOut"] is True and first_command["exitCode"] is None and first_command["measuredSource"] == START,
        "prior 1800-second timeout remains a distinct failed receipt")
require(command["measuredSource"] == REVIEWED and protection["startCommit"] == START,
        "completion receipt and author source-lineage receipt use exact reviewed/start pins")

pins = {label: {"commit": pin, "tree": git("rev-parse", pin + "^{tree}")} for label, pin in
        (("authorStartInputPin", START), ("reviewedSourceAndSuccessfulReceiptPin", REVIEWED), ("completionDocumentationPin", COMPLETION))}
tracked_inputs = ["apps/web", "packages/shared", "packages/meriv2-core", "pnpm-lock.yaml", "package.json", "pnpm-workspace.yaml"]
oids = {}
for tracked_path in tracked_inputs:
    oids[tracked_path] = {label: git("rev-parse", pin["commit"] + ":" + tracked_path) for label, pin in pins.items()}
    require(len(set(oids[tracked_path].values())) == 1, "identical tracked tree/blob across start/review/completion: " + tracked_path)
require(not git("diff", "--name-only", START, COMPLETION, "--", *tracked_inputs), "no tracked source/dependency input deltas during protected interval")
require(git("merge-base", "--is-ancestor", START, REVIEWED) == "", "start input pin is reviewed-source ancestor")
require(git("merge-base", "--is-ancestor", REVIEWED, COMPLETION) == "", "reviewed-source pin is completion-docs ancestor")
web_package = json.loads(subprocess.check_output(["git", "-C", str(ROOT), "show", REVIEWED + ":apps/web/package.json"]))
require(web_package["scripts"]["test"] == "vitest run --pool=threads --no-file-parallelism --testTimeout=20000 --hookTimeout=20000",
        "receipt runner flags match canonical reviewed Web test script")

result = {"accepted": True, "scope": "Read-only completed Web report, case identity and tracked source/dependency input audit",
          "sourcePins": pins, "trackedInputGitObjects": oids, "inputSha256": INPUTS,
          "reports": {name: value[2] for name, value in summaries.items()},
          "caseIdentity": {"comparison": "Counter over normalized physical file path and fullName, retaining multiplicity",
                           "allOriginalCasesRetainedAfterExplicitRename": True, "rename": {"file": path, "from": old_name[1], "to": new_name[1]},
                           "newNegativeCases": [negative[1] for negative in negatives], "newCaseCount": 2,
                           "physicalFiles": 701, "nestedSuiteRecords": 1963},
          "successfulCommand": command, "priorTimeout": first_command, "budgetReconciliation": budget,
          "checks": CHECKS, "limitations": [
              "No suite, CI, package manager, native engine, database, browser, provider or full gate invoked by reviewer.",
              "6437 is the completed source-unit report; 1963 nested suite records are not 1963 physical files.",
              "Both original red full reports and the first 1800-second timeout retain their original bytes and statuses.",
              "07d is the author's source-lineage start pin and the earlier timeout receipt pin; the successful receipt labels ed1. Identical tracked inputs prove source continuity, not an independently observed process launch timestamp.",
              "Git equality covers tracked source and dependency bindings; it does not independently attest ignored node_modules/generated files, mutable process state or OS containment.",
              "No native/Postgres/RLS/full-Cleanup acceptance or proof of the earlier artifact timing cause is inferred."]}
(OUT / "WEB-COMPLETION-REVIEW.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"accepted": True, "correctedCases": 6437, "priorCasesRetained": 6435, "explicitRenames": 1,
                  "newNegativeCases": 2, "physicalTestFiles": 701, "nestedSuiteRecords": 1963,
                  "sourceInputEquivalence": True, "checks": len(CHECKS), "failedChecks": 0}, indent=2))
