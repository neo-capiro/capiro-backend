"""Tests for cross-language contract conformance."""

import hashlib
import json
import os
from pathlib import Path

import pytest

from capiro_defense_budget_parser.contracts import (
    DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION,
    DEFENSE_BUDGET_PARSER_RESULT_SCHEMA_VERSION,
    DEFENSE_BUDGET_PARSE_PLAN_SCHEMA_VERSION,
    ParserRuntimeJobV1,
    ParserRuntimeResultV1,
    ParserPageFailureV1,
    is_terminal_state,
    is_valid_transition,
    PARSER_STATE_TRANSITIONS,
    compute_parser_run_cache_key,
    compute_parser_run_id,
    compute_parser_config_sha256,
    compute_result_content_sha256,
    page_range_key,
)
from capiro_defense_budget_parser.canonical_json import (
    canonical_json_stringify,
    sha256_canonical_json,
    sha256_hex,
)


FIXTURES_DIR = Path(__file__).parent / "fixtures"
FIXTURES_PATH = FIXTURES_DIR / "conformance-fixtures.json"


@pytest.fixture
def fixtures():
    with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


# A1: Schema version constants
class TestSchemaVersionConstants:
    def test_job_schema_version(self):
        assert DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION == "defense_budget_parser_job_v1"

    def test_result_schema_version(self):
        assert DEFENSE_BUDGET_PARSER_RESULT_SCHEMA_VERSION == "defense_budget_parser_result_v1"

    def test_plan_schema_version(self):
        assert DEFENSE_BUDGET_PARSE_PLAN_SCHEMA_VERSION == "defense_budget_parse_plan_v1"


# A2: Job contract validation
class TestJobContract:
    def test_accepts_valid_job(self, fixtures):
        job = ParserRuntimeJobV1(**fixtures["valid_job"])
        assert job.jobId == "job-test-001"
        assert job.requestedPages == [1, 2, 3]

    def test_rejects_unsorted_pages(self, fixtures):
        with pytest.raises(Exception):
            ParserRuntimeJobV1(**fixtures["invalid_unsorted_pages"])

    def test_rejects_duplicate_pages(self, fixtures):
        with pytest.raises(Exception):
            ParserRuntimeJobV1(**fixtures["invalid_duplicate_pages"])

    def test_rejects_unknown_fields(self, fixtures):
        with pytest.raises(Exception):
            ParserRuntimeJobV1(**fixtures["invalid_unknown_field"])

    def test_rejects_llamaparse_engine(self, fixtures):
        bad = dict(fixtures["valid_job"])
        bad["engine"] = "llamaparse"
        with pytest.raises(Exception):
            ParserRuntimeJobV1(**bad)

    def test_rejects_empty_pages(self, fixtures):
        bad = dict(fixtures["valid_job"])
        bad["requestedPages"] = []
        with pytest.raises(Exception):
            ParserRuntimeJobV1(**bad)

    def test_rejects_non_positive_pages(self, fixtures):
        bad = dict(fixtures["valid_job"])
        bad["requestedPages"] = [0, 1]
        with pytest.raises(Exception):
            ParserRuntimeJobV1(**bad)


# A3: Result contract validation
class TestResultContract:
    def test_accepts_valid_result(self, fixtures):
        result = dict(fixtures["valid_result"])
        # Recompute content SHA
        rest = {k: v for k, v in result.items() if k != "contentSha256"}
        real_sha = compute_result_content_sha256(rest)
        result["contentSha256"] = real_sha
        parsed = ParserRuntimeResultV1(**result)
        assert parsed.jobId == "job-test-001"
        assert len(parsed.pages) == 2

    def test_rejects_unknown_fields(self, fixtures):
        result = dict(fixtures["valid_result"])
        rest = {k: v for k, v in result.items() if k != "contentSha256"}
        real_sha = compute_result_content_sha256(rest)
        result["contentSha256"] = real_sha
        result["extraField"] = "bad"
        with pytest.raises(Exception):
            ParserRuntimeResultV1(**result)

    def test_rejects_invalid_engine(self, fixtures):
        result = dict(fixtures["valid_result"])
        result["engine"] = "invalid_engine"
        rest = {k: v for k, v in result.items() if k != "contentSha256"}
        real_sha = compute_result_content_sha256(rest)
        result["contentSha256"] = real_sha
        with pytest.raises(Exception):
            ParserRuntimeResultV1(**result)


# A4: Page failure contract
class TestPageFailure:
    def test_accepts_valid_failure(self, fixtures):
        failure = ParserPageFailureV1(**fixtures["page_failure"])
        assert failure.code == "no_embedded_text"

    def test_rejects_invalid_code(self):
        with pytest.raises(Exception):
            ParserPageFailureV1(page=1, code="invalid_code", message="test")


# A5: State machine
class TestStateMachine:
    def test_has_11_states(self):
        # All 11 states defined in transitions
        assert len(PARSER_STATE_TRANSITIONS) == 11

    def test_planned_to_running_local(self):
        assert is_valid_transition("PLANNED", "RUNNING_LOCAL")

    def test_running_local_to_local_complete(self):
        assert is_valid_transition("RUNNING_LOCAL", "LOCAL_COMPLETE")

    def test_local_complete_to_verifying(self):
        assert is_valid_transition("LOCAL_COMPLETE", "VERIFYING")

    def test_verifying_to_escalation_planned(self):
        assert is_valid_transition("VERIFYING", "ESCALATION_PLANNED")

    def test_verifying_to_terminal_passed(self):
        assert is_valid_transition("VERIFYING", "TERMINAL_PASSED")

    def test_escalation_planned_to_running_paid(self):
        assert is_valid_transition("ESCALATION_PLANNED", "RUNNING_PAID")

    def test_running_paid_to_paid_complete(self):
        assert is_valid_transition("RUNNING_PAID", "PAID_COMPLETE")

    def test_paid_complete_to_verifying(self):
        assert is_valid_transition("PAID_COMPLETE", "VERIFYING")

    def test_planned_to_terminal_passed_invalid(self):
        assert not is_valid_transition("PLANNED", "TERMINAL_PASSED")

    def test_terminal_states_have_no_outgoing(self):
        terminal = {"TERMINAL_PASSED", "TERMINAL_REVIEW", "TERMINAL_REJECTED", "FAILED"}
        for state in terminal:
            assert is_terminal_state(state)
            assert PARSER_STATE_TRANSITIONS[state] == ()

    def test_running_local_to_running_paid_invalid(self):
        assert not is_valid_transition("RUNNING_LOCAL", "RUNNING_PAID")


# A6: Parser-run identity
class TestParserRunIdentity:
    IDENTITY = {
        "source_sha256": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        "method": "deterministic_pdfplumber",
        "parser_version": "0.11.0",
        "parser_config_sha256": "e3d0f0c1a2b3e4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9",
        "pages": [1, 2, 3],
        "runtime_contract_version": DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION,
    }

    def test_deterministic_cache_key(self):
        key1 = compute_parser_run_cache_key(**self.IDENTITY)
        key2 = compute_parser_run_cache_key(**self.IDENTITY)
        assert key1 == key2
        assert len(key1) == 64

    def test_different_pages_different_keys(self):
        key1 = compute_parser_run_cache_key(**self.IDENTITY)
        id2 = dict(self.IDENTITY)
        id2["pages"] = [1, 2]
        key2 = compute_parser_run_cache_key(**id2)
        assert key1 != key2

    def test_different_method_different_keys(self):
        key1 = compute_parser_run_cache_key(**self.IDENTITY)
        id2 = dict(self.IDENTITY)
        id2["method"] = "camelot"
        key2 = compute_parser_run_cache_key(**id2)
        assert key1 != key2

    def test_unsorted_pages_same_key(self):
        key1 = compute_parser_run_cache_key(**self.IDENTITY)
        id2 = dict(self.IDENTITY)
        id2["pages"] = [3, 1, 2]
        key2 = compute_parser_run_cache_key(**id2)
        assert key1 == key2

    def test_deterministic_run_id(self):
        id1 = compute_parser_run_id(
            self.IDENTITY["source_sha256"],
            self.IDENTITY["method"],
            self.IDENTITY["parser_version"],
            self.IDENTITY["parser_config_sha256"],
            self.IDENTITY["pages"],
        )
        id2 = compute_parser_run_id(
            self.IDENTITY["source_sha256"],
            self.IDENTITY["method"],
            self.IDENTITY["parser_version"],
            self.IDENTITY["parser_config_sha256"],
            self.IDENTITY["pages"],
        )
        assert id1 == id2
        assert id1.startswith("pr1_")
        assert len(id1) == 68  # "pr1_" + 64 hex chars


# A7: Config SHA
class TestConfigSha:
    def test_deterministic_config_sha(self):
        config = {"tableStrategy": "lines", "minChars": 40}
        sha1 = compute_parser_config_sha256(config)
        sha2 = compute_parser_config_sha256(config)
        assert sha1 == sha2
        assert len(sha1) == 64

    def test_different_configs_different_sha(self):
        sha1 = compute_parser_config_sha256({"a": 1})
        sha2 = compute_parser_config_sha256({"a": 2})
        assert sha1 != sha2

    def test_key_order_does_not_matter(self):
        sha1 = compute_parser_config_sha256({"a": 1, "b": 2})
        sha2 = compute_parser_config_sha256({"b": 2, "a": 1})
        assert sha1 == sha2


# A8: Page range key
class TestPageRangeKey:
    def test_contiguous(self):
        assert page_range_key([1, 2, 3]) == "1-3"

    def test_non_contiguous(self):
        assert page_range_key([1, 2, 3, 7, 8]) == "1-3,7-8"

    def test_single_page(self):
        assert page_range_key([5]) == "5"

    def test_unsorted(self):
        assert page_range_key([3, 1, 2]) == "1-3"

    def test_non_contiguous_individual(self):
        assert page_range_key([1, 3, 5]) == "1,3,5"

    def test_empty(self):
        assert page_range_key([]) == "none"


# A9: Cross-language canonical JSON parity
class TestCanonicalJsonParity:
    def test_simple_object(self):
        obj = {"b": 2, "a": 1, "c": [3, 2, 1]}
        h = sha256_canonical_json(obj)
        assert len(h) == 64
        assert sha256_canonical_json(obj) == h

    def test_nested_object(self):
        obj = {"outer": {"z": 1, "a": 2}, "list": [{"y": 1, "x": 2}]}
        h = sha256_canonical_json(obj)
        assert len(h) == 64
        assert sha256_canonical_json(obj) == h

    def test_known_hash_value(self):
        """Verify a known canonical JSON string produces the expected hash."""
        # canonical: {"a":1,"b":2}
        canonical_str = '{"a":1,"b":2}'
        expected = hashlib.sha256(canonical_str.encode("utf-8")).hexdigest()
        assert sha256_canonical_json({"b": 2, "a": 1}) == expected