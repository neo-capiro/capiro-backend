#!/usr/bin/env python3
"""Meri Promptfoo offline scorer - Python assertion function for Promptfoo GradingResult.

This module provides the `get_assert(output, context)` function that Promptfoo
calls for each test case. It validates the runner output against the expected
behavior for each mode (core, ga, plan, sequence, calibration).

Fail closed for any malformed/missing data.
"""

import json
import re
from typing import Any, Dict, Optional


def get_assert(output: Any, context: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate output against expected behavior based on caseId mode.

    Promptfoo passes output as a JSON string (the provider's output field).
    Returns GradingResult: {pass: bool, score: float, reason: str}
    Fails closed for any malformed/missing data.
    """
    # Parse output string to dict
    try:
        if isinstance(output, str):
            record = json.loads(output)
        elif isinstance(output, dict):
            record = output
        else:
            return {"pass": False, "score": 0.0, "reason": "output is neither string nor dict"}
    except (json.JSONDecodeError, TypeError) as e:
        return {"pass": False, "score": 0.0, "reason": f"Failed to parse output JSON: {e}"}

    # Get caseId from context.vars (authoritative) and record
    vars_ = context.get("vars", {}) if isinstance(context, dict) else {}
    context_case_id = vars_.get("caseId") if isinstance(vars_, dict) else None
    record_case_id = record.get("caseId") if isinstance(record, dict) else None

    case_id = context_case_id
    if not case_id:
        return {"pass": False, "score": 0.0, "reason": "Missing caseId in context.vars"}

    mode = _infer_mode(case_id)

    try:
        # Validate basic structure first (including caseId match)
        validation_result = _validate_basic_structure(record, case_id)
        if validation_result is not True:
            return validation_result

        # Mode-specific validation
        if mode == "core":
            return _validate_core_case(record, case_id)
        elif mode == "ga":
            return _validate_ga_case(record, case_id)
        elif mode == "plan":
            return _validate_plan_case(record, case_id, context)
        elif mode == "sequence":
            return _validate_sequence_case(record, case_id, context)
        elif mode == "calibration":
            return _validate_calibration_case(record, case_id, context)
        else:
            return {"pass": False, "score": 0.0, "reason": f"Unknown mode: {mode}"}

    except Exception as e:
        return {"pass": False, "score": 0.0, "reason": f"Scorer exception: {str(e)}"}


def _get_case_id(output: Any, context: Dict[str, Any]) -> Optional[str]:
    """Extract caseId from context.vars (authoritative) or output dict."""
    vars_ = context.get("vars", {}) if isinstance(context, dict) else {}
    if isinstance(vars_, dict):
        cid = vars_.get("caseId")
        if cid:
            return cid
    # Fallback: try output dict
    if isinstance(output, dict):
        return output.get("caseId")
    return None


def _infer_mode(case_id: Optional[str]) -> str:
    """Infer the test mode from caseId prefix."""
    if not case_id:
        return "unknown"
    if case_id.startswith("core/"):
        return "core"
    elif case_id.startswith("ga/"):
        return "ga"
    elif case_id.startswith("plan/"):
        return "plan"
    elif case_id.startswith("sequence/"):
        return "sequence"
    elif case_id.startswith("calibration/"):
        return "calibration"
    return "unknown"


def _validate_basic_structure(output: Any, case_id: str) -> Any:
    """Validate minimum required record structure. Returns True on success, failure dict otherwise."""
    if not isinstance(output, dict):
        return {"pass": False, "score": 0.0, "reason": "output is not a dict"}

    # Must have schemaVersion=1 and datasetVersion
    if output.get("schemaVersion") != 1:
        return {"pass": False, "score": 0.0, "reason": f"Invalid schemaVersion: {output.get('schemaVersion')}"}
    if output.get("datasetVersion") != "meri-offline-v1":
        return {"pass": False, "score": 0.0, "reason": f"Invalid datasetVersion: {output.get('datasetVersion')}"}

    # caseId in record must exactly match context caseId
    record_case_id = output.get("caseId")
    if record_case_id != case_id:
        return {"pass": False, "score": 0.0, "reason": f"caseId mismatch: record has '{record_case_id}', context has '{case_id}'"}

    # A present-but-null measurement cannot stand in for an observed result.
    if not isinstance(output.get("measurement"), dict):
        return {"pass": False, "score": 0.0, "reason": "Missing measurement object"}

    # Provenance must be present: missing provenance cannot prove offline execution.
    prov = output.get("provenance")
    if not isinstance(prov, dict) or prov.get("model") != "none":
        return {"pass": False, "score": 0.0, "reason": f"provenance.model must be 'none', got '{prov.get('model') if isinstance(prov, dict) else None}'"}

    return True


def _validate_core_case(output: Dict[str, Any], case_id: str) -> Dict[str, Any]:
    """Validate a core mechanism case."""
    result = output.get("result")
    if not isinstance(result, dict):
        return {"pass": False, "score": 0.0, "reason": "Missing result object"}
    if output["measurement"].get("status") != "pass":
        return {"pass": False, "score": 0.0, "reason": "Core measurement did not pass"}

    if result.get("pass") is not True:
        return {"pass": False, "score": 0.0, "reason": f"Core case failed: {result.get('detail', 'no detail')}"}

    return {"pass": True, "score": 1.0, "reason": f"PASS: {result.get('detail', 'core mechanism valid')}"}


def _validate_ga_case(output: Dict[str, Any], case_id: str) -> Dict[str, Any]:
    """Validate a government affairs reference-answer case."""
    if output["measurement"].get("status") != "pass":
        return {"pass": False, "score": 0.0, "reason": "GA reference measurement did not pass"}
    # GA requires answer, sources, requiredSourceIds, expect, and grade
    answer = output.get("answer")
    if not isinstance(answer, str) or not answer.strip():
        return {"pass": False, "score": 0.0, "reason": "Missing or empty answer"}

    sources = output.get("sources")
    if not isinstance(sources, list) or len(sources) == 0:
        return {"pass": False, "score": 0.0, "reason": "Missing or empty sources"}

    required_source_ids = output.get("requiredSourceIds")
    if not isinstance(required_source_ids, list):
        return {"pass": False, "score": 0.0, "reason": "Missing requiredSourceIds"}

    expect = output.get("expect")
    if not isinstance(expect, dict):
        return {"pass": False, "score": 0.0, "reason": "Missing expect"}

    grade = output.get("grade")
    if not isinstance(grade, dict):
        return {"pass": False, "score": 0.0, "reason": "Missing grade"}

    # GA grader must pass
    if grade.get("pass") is not True:
        failures = grade.get("failures", [])
        return {"pass": False, "score": 0.0, "reason": f"GA grader rejected answer: {failures}"}

    # Check the same observable fixture contract independently: a tampered
    # grade.pass=true must never mask fabricated or missing evidence.
    source_ids = {source.get("id") for source in sources if isinstance(source, dict)}
    if len(source_ids) != len(sources) or any(not isinstance(source_id, int) for source_id in source_ids):
        return {"pass": False, "score": 0.0, "reason": "Invalid or duplicate source IDs"}
    if any(not isinstance(source_id, int) for source_id in required_source_ids):
        return {"pass": False, "score": 0.0, "reason": "Invalid required source ID"}
    citations = {int(marker) for marker in re.findall(r"\[(\d+)\]", answer)}
    if expect.get("mustCite") is True and not citations:
        return {"pass": False, "score": 0.0, "reason": "Missing required citation markers"}
    if citations - source_ids:
        return {"pass": False, "score": 0.0, "reason": f"Unknown citation IDs: {sorted(citations - source_ids)}"}
    if set(required_source_ids) - citations:
        return {"pass": False, "score": 0.0, "reason": f"Missing required citation IDs: {sorted(set(required_source_ids) - citations)}"}
    must_include = expect.get("mustInclude")
    must_exclude = expect.get("mustNotInclude")
    if not isinstance(must_include, list) or not isinstance(must_exclude, list):
        return {"pass": False, "score": 0.0, "reason": "Missing GA reference text rules"}
    answer_lower = answer.lower()
    for phrase in must_include:
        if not isinstance(phrase, str) or phrase.lower() not in answer_lower:
            return {"pass": False, "score": 0.0, "reason": f"Missing required GA text: {phrase}"}
    for phrase in must_exclude:
        if not isinstance(phrase, str) or phrase.lower() in answer_lower:
            return {"pass": False, "score": 0.0, "reason": f"Forbidden GA text: {phrase}"}

    return {"pass": True, "score": 1.0, "reason": "PASS: GA grader verified answer and citations"}


def _parse_list_var(vars_: dict, key: str) -> Optional[list]:
    """Get a list var from vars, supporting both direct list and *_json string encoding."""
    val = vars_.get(key)
    if val is None:
        # Try *_json suffix (used to prevent Promptfoo matrix expansion)
        val = vars_.get(key + "_json")
    if val is None:
        return None
    if isinstance(val, list):
        return val
    if isinstance(val, str):
        try:
            parsed = json.loads(val)
            if isinstance(parsed, list):
                return parsed
        except (json.JSONDecodeError, ValueError):
            pass
        # Single string value (Promptfoo stringified single-item list)
        return [val]
    return None


def _validate_plan_case(output: Dict[str, Any], case_id: str, context: Dict[str, Any]) -> Dict[str, Any]:
    """Validate a planner scenario case."""
    if output["measurement"].get("status") != "complete":
        return {"pass": False, "score": 0.0, "reason": "Planner measurement did not complete"}
    plan = output.get("plan")
    if not isinstance(plan, dict):
        return {"pass": False, "score": 0.0, "reason": "Missing plan object"}

    # Extract expected values from context
    vars_ = context.get("vars", {})
    expected_recipe = vars_.get("expectedRecipeTool")
    expected_scope = vars_.get("expectedSubjectScope")
    expected_target = vars_.get("expectedTargetHint")
    expected_days = vars_.get("expectedWithinDays")
    # Promptfoo may expand list vars; accept *_json suffix as JSON-encoded string
    expected_domains = _parse_list_var(vars_, "expectedRequiredDomains")
    expected_tools = _parse_list_var(vars_, "expectedRecommendedTools")
    forbidden_tools = _parse_list_var(vars_, "forbiddenRecommendedTools")

    expected_active_clients = vars_.get("expectedActiveClientCount")

    # recipeTool validation
    if "expectedRecipeTool" in vars_:
        if expected_recipe == "__none__":
            expected_recipe = None
        actual_recipe = plan.get("recipeTool")
        if actual_recipe != expected_recipe:
            return {"pass": False, "score": 0.0, "reason": f"Expected recipeTool={expected_recipe}, got {actual_recipe}"}

    # subjectScope validation
    if expected_scope is not None:
        actual_scope = plan.get("subjectScope")
        if actual_scope != expected_scope:
            return {"pass": False, "score": 0.0, "reason": f"Expected subjectScope={expected_scope}, got {actual_scope}"}

    # targetHint validation
    if "expectedTargetHint" in vars_:
        if expected_target == "__none__":
            expected_target = None
        actual_target = plan.get("targetHint")
        if actual_target != expected_target:
            return {"pass": False, "score": 0.0, "reason": f"Expected targetHint={expected_target}, got {actual_target}"}

    # timeWindow.withinDays validation
    if expected_days is not None:
        time_window = plan.get("timeWindow", {})
        actual_days = time_window.get("withinDays")
        if actual_days != expected_days:
            return {"pass": False, "score": 0.0, "reason": f"Expected withinDays={expected_days}, got {actual_days}"}

    # requiredDomains validation
    if expected_domains is not None:
        actual_domains = plan.get("requiredDomains", [])
        # Check that all expected domains are present
        for domain in expected_domains:
            if domain not in actual_domains:
                return {"pass": False, "score": 0.0, "reason": f"Missing requiredDomain={domain}"}

    # Validate both the tools required by the scenario and forbidden tools.
    if expected_tools is not None:
        actual_tools = plan.get("recommendedTools")
        if not isinstance(actual_tools, list):
            return {"pass": False, "score": 0.0, "reason": "Missing recommendedTools list"}
        for tool in expected_tools:
            if tool not in actual_tools:
                return {"pass": False, "score": 0.0, "reason": f"Missing recommended tool {tool}"}

    if forbidden_tools is not None:
        actual_tools = plan.get("recommendedTools", [])
        for tool in forbidden_tools:
            if tool in actual_tools:
                return {"pass": False, "score": 0.0, "reason": f"Forbidden tool {tool} was recommended"}

    # activeClients count validation
    if expected_active_clients is not None:
        actual_clients = plan.get("activeClients", [])
        if len(actual_clients) != expected_active_clients:
            return {"pass": False, "score": 0.0, "reason": f"Expected {expected_active_clients} active clients, got {len(actual_clients)}"}

    return {"pass": True, "score": 1.0, "reason": "PASS: Planner output matches all expected fields"}


def _validate_sequence_case(output: Dict[str, Any], case_id: str, context: Dict[str, Any]) -> Dict[str, Any]:
    """Validate a multi-turn sequence scenario. Uses output.plan (second turn plan)."""
    if output["measurement"].get("status") != "complete":
        return {"pass": False, "score": 0.0, "reason": "Sequence measurement did not complete"}
    # plan holds the second turn plan; turns holds [firstPlan, secondPlan]
    plan = output.get("plan")
    if not isinstance(plan, dict):
        return {"pass": False, "score": 0.0, "reason": "Missing plan object for sequence case"}

    turns = output.get("turns")
    if not isinstance(turns, list) or len(turns) != 2 or not all(isinstance(turn, dict) for turn in turns):
        return {"pass": False, "score": 0.0, "reason": "Missing or insufficient turns array"}
    if turns[1] != plan:
        return {"pass": False, "score": 0.0, "reason": "Second turn does not match final plan"}

    # Extract expected values
    vars_ = context.get("vars", {})
    for expectation, actual in (
        ("expectedFirstTargetHint", turns[0].get("targetHint")),
        ("expectedSecondTargetHint", plan.get("targetHint")),
        ("expectedSecondRecipeTool", plan.get("recipeTool")),
        ("expectedSecondSubjectScope", plan.get("subjectScope")),
    ):
        if expectation in vars_:
            expected = vars_[expectation]
            if expected == "__none__":
                expected = None
            if actual != expected:
                return {"pass": False, "score": 0.0, "reason": f"{expectation}: got {actual!r}, expected {expected!r}"}

    return {"pass": True, "score": 1.0, "reason": "PASS: Sequence turns produce expected behavior"}


def _validate_calibration_case(output: Dict[str, Any], case_id: str, context: Dict[str, Any]) -> Dict[str, Any]:
    """Validate a calibration case - must fail when expected to fail."""
    case_id_lower = case_id.lower()

    # Calibration cases test that the underlying grader correctly rejects bad input
    # For calibration to PASS, the underlying check must FAIL (exit100 on failure)

    # calibration/bad-citation: GA grader must reject fabricated citation
    if "bad-citation" in case_id_lower:
        if output["measurement"].get("status") != "complete":
            return {"pass": False, "score": 0.0, "reason": "Bad-citation calibration did not complete"}
        grade = output.get("grade")
        if not isinstance(grade, dict):
            return {"pass": False, "score": 0.0, "reason": "Missing grade for bad-citation calibration"}

        if grade.get("pass"):
            return {"pass": False, "score": 0.0, "reason": "Bad-citation calibration: GA grader should have REJECTED fabricated citation"}

        failures = grade.get("failures", [])
        if not failures:
            return {"pass": False, "score": 0.0, "reason": "Bad-citation calibration: GA grader failures list should not be empty"}

        return {"pass": True, "score": 1.0, "reason": "PASS: GA grader correctly rejected bad citation"}

    # calibration/tenant-leak: Cross-tenant leak must be rejected
    if "tenant-leak" in case_id_lower:
        if output["measurement"].get("status") != "fail":
            return {"pass": False, "score": 0.0, "reason": "Tenant-leak calibration did not report failure"}
        result = output.get("result")
        if not isinstance(result, dict):
            return {"pass": False, "score": 0.0, "reason": "Missing result for tenant-leak calibration"}

        if result.get("pass"):
            return {"pass": False, "score": 0.0, "reason": "Tenant-leak calibration: Mechanism should have REJECTED cross-tenant leak"}

        detail = result.get("detail", "")
        if not detail or "LEAK" not in detail:
            return {"pass": False, "score": 0.0, "reason": "Tenant-leak calibration: detail should mention LEAK"}

        return {"pass": True, "score": 1.0, "reason": "PASS: Mechanism correctly rejected tenant leak"}

    return {"pass": False, "score": 0.0, "reason": f"Unknown calibration case: {case_id}"}
