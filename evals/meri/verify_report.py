#!/usr/bin/env python3
"""Verify Promptfoo report JSON - check case IDs, stats, and no-duplicate IDs.

This verifier:
1. Reads the report JSON from the given path
2. Validates exactly the expected case IDs exist (no missing, no extra duplicates)
3. Reports machine-readable summary (exit code, stats, pass/fail counts)
4. Does NOT overwrite any baseline (no accepted baseline exists yet)
"""

import hashlib
import json
import math
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Set


EXPECTED_CORE_IDS = {
    "core/leakage.cross-tenant.matrix",
    "core/grounding.claim-evidence",
    "core/compliance.gate.enforcement",
    "core/entity.grounding.canonical-ids",
    "core/legislation.bill-status.hr8800-rule-failed",
    "core/legislation.state-bill-status.crossover-dead",
    "core/legislation.state-rule-status.no-fabrication",
    "core/legislation.committee-roster.never-guess",
    "core/legislation.multi-state-comparison.order-independent",
    "core/legislation.federal-state-mixed.no-cross-contamination",
    "core/government-affairs-assurance-ga-goldens-v1.0.0",
}

EXPECTED_GA_IDS = {
    "ga/ga-budget-stage-and-units",
    "ga/ga-funding-eligibility-and-forecast",
    "ga/ga-meeting-history-and-role",
    "ga/ga-hearing-statement-versus-decision",
    "ga/ga-legislation-current-version",
    "ga/ga-executive-consistent-deliverable",
}

EXPECTED_PLAN_IDS = {
    "plan/portfolio-changes",
    "plan/overland-ai-profile",
    "plan/c2-strategies-mail-history",
    "plan/kindetic-industries-research",
    "plan/selected-client-priorities",
}

EXPECTED_SEQUENCE_IDS = {
    "sequence/portfolio-overlap-with-target",
    "sequence/cleared-prior-target",
}

EXPECTED_CALIBRATION_IDS = {
    "calibration/bad-citation",
    "calibration/tenant-leak",
}

ALL_EXPECTED_IDS = (
    EXPECTED_CORE_IDS |
    EXPECTED_GA_IDS |
    EXPECTED_PLAN_IDS |
    EXPECTED_SEQUENCE_IDS |
    EXPECTED_CALIBRATION_IDS
)
CONTRACT_PATH = Path(__file__).with_name('suite-contract.json')
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding='utf-8'))
CONTRACT_IDS = [case_id for ids in CONTRACT['caseIds'].values() for case_id in ids]
REQUIRED_ASSERTION = 'file://./scorer.py'
EVAL_DIR = Path(__file__).resolve().parent
FIXTURE_PATH = EVAL_DIR.parents[1] / 'apps' / 'api' / 'src' / 'meri' / 'evals' / 'government-affairs-fixtures.ts'
INPUT_PATHS = {
    'config': EVAL_DIR / 'promptfooconfig.yaml',
    'scorer': EVAL_DIR / 'scorer.py',
    'provider': EVAL_DIR / 'runtime' / 'provider.cjs',
    'runner': EVAL_DIR / 'runtime' / 'runner.mjs',
}


def load_report(path: str) -> Dict[str, Any]:
    """Load report JSON from path."""
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def _row_error(row: Any, threshold: float) -> str | None:
    """Reason why a row cannot support a deterministic Python 1.0 pass."""
    if not isinstance(row, dict) or row.get('success') is not True:
        return 'Promptfoo marked the case unsuccessful'
    if row.get('error'):
        return 'Provider error despite a successful flag'
    grading = row.get('gradingResult')
    if not isinstance(grading, dict) or grading.get('pass') is not True:
        return 'Missing or failed gradingResult'
    for part in (row, grading):
        value = part.get('score')
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value) or not threshold <= value <= 1.0):
            return 'Score below deterministic threshold'
    components = grading.get('componentResults')
    if not isinstance(components, list) or len(components) != 1:
        return 'Expected exactly one Python assertion component'
    component = components[0]
    if not isinstance(component, dict) or component.get('pass') is not True:
        return 'Missing or failed Python assertion component'
    assertion = component.get('assertion')
    component_score = component.get('score')
    if (isinstance(component_score, bool) or not isinstance(component_score, (int, float))
            or not math.isfinite(component_score) or not threshold <= component_score <= 1.0
            or not isinstance(assertion, dict)
            or assertion.get('type') != 'python' or assertion.get('value') != REQUIRED_ASSERTION
            or assertion.get('threshold') != threshold):
        return 'Python assertion missing, changed, or below threshold'
    response = row.get('response')
    if not isinstance(response, dict) or not isinstance(response.get('output'), str):
        return 'Missing JSON provider output'
    try:
        record = json.loads(response['output'])
    except (TypeError, ValueError):
        return 'Invalid JSON provider output'
    if not isinstance(record, dict) or not isinstance(row.get('vars'), dict):
        return 'Invalid record or scenario variables'
    if (record.get('caseId') != row['vars'].get('caseId')
            or record.get('schemaVersion') != CONTRACT['schemaVersion']
            or record.get('datasetVersion') != CONTRACT['version']
            or not isinstance(record.get('measurement'), dict)):
        return 'Record case ID, schema, dataset, or measurement mismatch'
    provenance = record.get('provenance')
    if (not isinstance(provenance, dict) or provenance.get('model') != 'none'
            or provenance.get('fixtureVersion') != CONTRACT['fixtureVersion']
            or not isinstance(provenance.get('gitSha'), str)
            or not re.fullmatch(r'[0-9a-f]{40}', provenance['gitSha'])):
        return 'Invalid offline model, source SHA, or fixture provenance'
    return None


def verify_report(report_path: str, summary_path: str) -> Dict[str, Any]:
    """Verify report and write machine-readable summary."""
    try:
        report = load_report(report_path)
    except FileNotFoundError:
        return {
            "success": False,
            "error": f"Report not found: {report_path}",
            "exit_code": 1
        }
    except json.JSONDecodeError as e:
        return {
            "success": False,
            "error": f"Invalid JSON: {e}",
            "exit_code": 1
        }
    if not isinstance(report, dict) or not isinstance(report.get('results'), dict):
        return {"success": False, "error": "Missing report.results object", "exit_code": 1}

    # Stats are under report.results.stats in Promptfoo 0.123.x
    results_obj = report.get("results", {})
    test_cases = results_obj.get("results", [])
    stats = results_obj.get("stats", {})
    if not isinstance(test_cases, list) or not isinstance(stats, dict):
        return {"success": False, "error": "Missing result rows or stats", "exit_code": 1}

    # Extract case IDs from results
    found_ids: List[str] = []
    for tc in test_cases:
        vars_ = tc.get("vars") if isinstance(tc, dict) else None
        case_id = vars_.get("caseId") if isinstance(vars_, dict) else None
        if isinstance(case_id, str):
            found_ids.append(case_id)

    found_set: Set[str] = set(found_ids)
    expected_set: Set[str] = set(CONTRACT_IDS)

    # Check for missing IDs
    missing_ids = expected_set - found_set
    # Check for duplicate IDs
    seen: Set[str] = set()
    duplicate_ids: List[str] = []
    for id_ in found_ids:
        if id_ in seen:
            duplicate_ids.append(id_)
        seen.add(id_)

    # Check for extra IDs (not in expected)
    extra_ids = found_set - expected_set

    threshold = CONTRACT['threshold']
    try:
        input_sha256 = {name: hashlib.sha256(path.read_bytes()).hexdigest()
                        for name, path in {**INPUT_PATHS, 'ga_fixture': FIXTURE_PATH}.items()}
    except OSError as exc:
        return {"success": False, "exit_code": 1, "error": f"Missing evaluation input: {exc}"}
    errors: List[Dict[str, Any]] = []
    source_shas: Set[str] = set()
    matching_inputs = 0
    for tc in test_cases:
        reason = _row_error(tc, threshold)
        if not reason:
            record = json.loads(tc['response']['output'])
            if record['provenance'].get('inputSha256') != input_sha256:
                reason = 'Evaluated harness input SHA-256 differs from current files'
            else:
                matching_inputs += 1
        if reason:
            vars_ = tc.get('vars') if isinstance(tc, dict) else None
            errors.append({'caseId': vars_.get('caseId') if isinstance(vars_, dict) else None,
                           'reason': reason})
        else:
            source_shas.add(json.loads(tc['response']['output'])['provenance']['gitSha'])
    pass_count = len(test_cases) - len(errors)
    fail_count = len(errors)
    stats_ok = (stats.get('successes') == pass_count and stats.get('failures') == fail_count
                and stats.get('errors') == 0 and isinstance(stats.get('tokenUsage'), dict)
                and stats['tokenUsage'].get('total') == 0)
    config = report.get('config')
    default_test = config.get('defaultTest') if isinstance(config, dict) else None
    assertions = default_test.get('assert') if isinstance(default_test, dict) else None
    config_ok = (isinstance(assertions, list) and len(assertions) == 1
                 and isinstance(assertions[0], dict)
                 and assertions[0].get('type') == 'python'
                 and assertions[0].get('value') == REQUIRED_ASSERTION
                 and assertions[0].get('threshold') == threshold)
    options = report.get('runtimeOptions')
    private_uncached = (isinstance(options, dict) and options.get('cache') is False
                        and report.get('shareableUrl') is None)
    contract_ok = (len(CONTRACT_IDS) == len(expected_set) == CONTRACT['totalCases']
                   and expected_set == ALL_EXPECTED_IDS)
    try:
        checkout_sha = subprocess.check_output(
            ['git', '-C', str(CONTRACT_PATH.parent.parent.parent), 'rev-parse', 'HEAD'],
            text=True, stderr=subprocess.DEVNULL, timeout=3).strip()
    except (OSError, subprocess.SubprocessError):
        checkout_sha = None
    fixture_hash_ok = input_sha256['ga_fixture'] == CONTRACT['fixtureSha256']
    current_harness_inputs = matching_inputs == len(test_cases)
    current_source_sha = len(source_shas) == 1 and checkout_sha in source_shas
    success = bool(not missing_ids and not duplicate_ids and not extra_ids
                   and fail_count == 0 and len(test_cases) == CONTRACT['totalCases']
                   and stats_ok and config_ok and private_uncached and contract_ok
                   and current_source_sha and fixture_hash_ok and current_harness_inputs)

    summary = {
        "success": success,
        "exit_code": 0 if success else 1,
        "report_path": report_path,
        "report_sha256": hashlib.sha256(Path(report_path).read_bytes()).hexdigest(),
        "suite_contract_sha256": hashlib.sha256(CONTRACT_PATH.read_bytes()).hexdigest(),
        "input_sha256": input_sha256,
        "expected_count": len(expected_set),
        "found_count": len(found_set),
        "evaluated_rows": len(test_cases),
        "pass_count": pass_count,
        "fail_count": fail_count,
        "error_count": stats.get('errors'),
        "threshold": threshold,
        "category_counts": {name: sum(cid in set(ids) for cid in found_ids)
                            for name, ids in CONTRACT['caseIds'].items()},
        "checks": {"aggregate_stats": stats_ok, "config_assertion": config_ok,
                   "private_uncached": private_uncached, "contract_ids": contract_ok,
                   "uniform_source_sha": len(source_shas) == 1,
                   "current_source_sha": current_source_sha,
                   "fixture_hash": fixture_hash_ok,
                   "current_harness_inputs": current_harness_inputs},
        "stats": stats,
        "missing_ids": sorted(list(missing_ids)),
        "duplicate_ids": duplicate_ids,
        "extra_ids": sorted(list(extra_ids)),
        "errors": errors,
        "provenance": {
            "baseSha": CONTRACT['baseSha'],
            "checkoutGitSha": checkout_sha,
            "sourceGitSha": next(iter(source_shas)) if len(source_shas) == 1 else None,
            "fixtureVersion": CONTRACT['fixtureVersion'],
            "datasetVersion": CONTRACT['version'],
            "suiteContractIds": sorted(list(expected_set)),
            "evaluatorVersion": CONTRACT['provenance']['evaluatorVersion'],
            "baseline": "not accepted; offline mechanisms only",
        },
    }

    # Write machine-readable summary
    with open(summary_path, 'w', encoding='utf-8') as f:
        json.dump(summary, f, indent=2)

    return summary


def main():
    """Main entry point."""
    if len(sys.argv) < 3:
        print("Usage: python verify_report.py <report.json> <summary.json>")
        print("Example: python verify_report.py .artifacts/meri-promptfoo/report.json .artifacts/meri-promptfoo/report.summary.json")
        sys.exit(1)

    report_path = sys.argv[1]
    summary_path = sys.argv[2]

    summary = verify_report(report_path, summary_path)

    if summary["success"]:
        print(f"REPORT VERIFIED: {summary['pass_count']}/{summary['expected_count']} cases passed")
        print(f"Summary written to: {summary_path}")
        sys.exit(0)
    else:
        print("REPORT VERIFICATION FAILED")
        if summary.get("error"):
            print(f"  Error: {summary['error']}")
        if summary.get("missing_ids"):
            print(f"  Missing IDs: {summary['missing_ids']}")
        if summary.get("duplicate_ids"):
            print(f"  Duplicate IDs: {summary['duplicate_ids']}")
        if summary.get("extra_ids"):
            print(f"  Extra IDs: {summary['extra_ids']}")
        if summary.get("fail_count", 0) > 0:
            print(f"  Failures: {summary['fail_count']}")
        print(f"Summary written to: {summary_path}")
        sys.exit(1)


if __name__ == "__main__":
    main()
