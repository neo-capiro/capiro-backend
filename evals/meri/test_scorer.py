#!/usr/bin/env python3
"""TDD unit tests for Meri Promptfoo offline scorer.

RED phase: Tests are written FIRST and MUST fail with current stub implementation.
This proves the tests actually validate the behavior we want.

 green phase: scorer.py is implemented to pass these tests.
"""

import json
import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from scorer import get_assert


class TestScorerRED(unittest.TestCase):
    """Test suite - first pass must fail (RED) with stub implementation."""

    def test_core_cross_tenant_leakage_should_pass(self):
        """core/leakage.cross-tenant.matrix - actual runner passes."""
        case_id = 'core/leakage.cross-tenant.matrix'
        vars = {'caseId': case_id}
        output = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'pass', 'durationMs': 10},
            'result': {'pass': True, 'detail': 'no cross-tenant rows'},
            'provenance': {'gitSha': '81c7c9c58a4fc3c1e34ab9714614882d74a60c9d', 'fixtureVersion': 'none', 'model': 'none'}
        }
        result = get_assert(output, {'vars': vars})
        self.assertTrue(result['pass'])
        self.assertEqual(result['score'], 1.0)

    def test_core_claim_grounding_should_pass(self):
        """core/grounding.claim-evidence - actual runner passes."""
        case_id = 'core/grounding.claim-evidence'
        vars = {'caseId': case_id}
        output = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'pass', 'durationMs': 10},
            'result': {'pass': True, 'detail': 'all evidence-backed'},
            'provenance': {'gitSha': '81c7c9c58a4fc3c1e34ab9714614882d74a60c9d', 'fixtureVersion': 'none', 'model': 'none'}
        }
        result = get_assert(output, {'vars': vars})
        self.assertTrue(result['pass'])
        self.assertEqual(result['score'], 1.0)

    def test_core_compliance_gate_should_pass(self):
        """core/compliance.gate.enforcement - actual runner passes."""
        case_id = 'core/compliance.gate.enforcement'
        vars = {'caseId': case_id}
        output = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'pass', 'durationMs': 10},
            'result': {'pass': True, 'detail': 'gate enforced'},
            'provenance': {'gitSha': '81c7c9c58a4fc3c1e34ab9714614882d74a60c9d', 'fixtureVersion': 'none', 'model': 'none'}
        }
        result = get_assert(output, {'vars': vars})
        self.assertTrue(result['pass'])
        self.assertEqual(result['score'], 1.0)

    def test_ga_budget_funding_should_pass(self):
        """ga/ga-budget-stage-and-units - actual grader passes."""
        case_id = 'ga/ga-budget-stage-and-units'
        vars = {'caseId': case_id}
        output = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'pass', 'durationMs': 10},
            'answer': 'FY2027 PE 0609001N / DEM-1 has a 25% committee reduction; recommend a technical follow-up, not secured funding. [1][2]',
            'sources': [
                {'id': 1, 'title': 'Client arbor', 'text': 'Record client:arbor...'},
                {'id': 2, 'title': 'Budget FY2027', 'text': 'Source eval://budget...'}
            ],
            'requiredSourceIds': [1, 2],
            'expect': {
                'mustInclude': ['0609001N', 'DEM-1', '2027', '25%'],
                'mustNotInclude': ['funding is secured', 'the enacted amount is $9 million'],
                'mustCite': True
            },
            'grade': {'pass': True, 'failures': []},
            'provenance': {'gitSha': '81c7c9c58a4fc3c1e34ab9714614882d74a60c9d', 'fixtureVersion': '2026-09-06.1', 'model': 'none'}
        }
        result = get_assert(output, {'vars': vars})
        self.assertTrue(result['pass'])
        self.assertEqual(result['score'], 1.0)

    def test_plan_portfolio_changes_correct_recipe(self):
        """plan/portfolio-changes - actual planner returns correct recipe."""
        case_id = 'plan/portfolio-changes'
        vars = {'caseId': case_id, 'request': 'What changed across my clients this week?'}
        output = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'complete', 'durationMs': 10},
            'plan': {
                'recipeTool': 'query_portfolio_changes',
                'timeWindow': {'expression': 'this week', 'withinDays': 7},
                'activeClients': [{'name': 'Aperture Defense Systems', 'status': 'active'}],
                'requiredDomains': ['clients', 'mail', 'meetings', 'tasks', 'legislation']
            },
            'provenance': {'gitSha': '81c7c9c58a4fc3c1e34ab9714614882d74a60c9d', 'fixtureVersion': 'none', 'model': 'none'}
        }
        result = get_assert(output, {'vars': vars})
        self.assertTrue(result['pass'])
        self.assertEqual(result['score'], 1.0)

    def test_sequence_second_turn_clears_prior_target(self):
        """sequence/cleared-prior-target - second plan clears prior unrelated target."""
        case_id = 'sequence/cleared-prior-target'
        vars = {'caseId': case_id, 'request': "What are this client's current priorities?", 'firstRequest': 'Research Overland AI', 'expectedSecondTargetHint': None}
        record = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'complete', 'durationMs': 10},
            'plan': {
                'targetHint': None,
                'subjectScope': 'client',
                'recipeTool': None
            },
            'turns': [
                {
                    'targetHint': 'Overland AI',
                    'recipeTool': 'research_external_company'
                },
                {
                    'targetHint': None,
                    'subjectScope': 'client',
                    'recipeTool': None
                }
            ],
            'provenance': {'gitSha': '81c7c9c58a4fc3c1e34ab9714614882d74a60c9d', 'fixtureVersion': 'none', 'model': 'none'}
        }
        # Scorer receives JSON string from Promptfoo
        output_str = json.dumps(record)
        result = get_assert(output_str, {'vars': vars})
        self.assertTrue(result['pass'])
        self.assertEqual(result['score'], 1.0)

    def test_calibration_bad_citation_should_fail(self):
        """calibration/bad-citation - GA grader REJECTS fabricated citation."""
        case_id = 'calibration/bad-citation'
        vars = {'caseId': case_id}
        # The fixture has requiredSourceIds=[1,2], but answer cites [999] which is fake
        output = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'complete', 'durationMs': 10},
            'answer': 'Recommend technical follow-up. [999]',  # FABRICATED citation
            'sources': [
                {'id': 1, 'title': 'Client arbor', 'text': '...'},
                {'id': 2, 'title': 'Budget', 'text': '...'}
            ],
            'requiredSourceIds': [1, 2],
            'expect': {'mustCite': True},
            'grade': {
                'pass': False,
                'failures': ['citation [999] has no supplied source', 'required client/task evidence [1] was not cited']
            },
            'provenance': {'gitSha': '81c7c9c58a4fc3c1e34ab9714614882d74a60c9d', 'fixtureVersion': '2026-09-06.1', 'model': 'none'}
        }
        result = get_assert(output, {'vars': vars})
        # Calibration should PASS only if the underlying GA grader REJECTS (pass=False)
        # This test asserts the grader correctly rejects the bad citation
        self.assertTrue(result['pass'])  # Test passes because grader REJECTED as expected

    def test_calibration_tenant_leak_should_fail(self):
        """calibration/tenant-leak - mechanism GRADER REJECTS cross-tenant leak."""
        case_id = 'calibration/tenant-leak'
        vars = {'caseId': case_id}
        output = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'fail', 'durationMs': 10},
            'result': {
                'pass': False,
                'detail': 'LEAK across matrix: caller←victim:secret'
            },
            'provenance': {'gitSha': '81c7c9c58a4fc3c1e34ab9714614882d74a60c9d', 'fixtureVersion': 'none', 'model': 'none'}
        }
        result = get_assert(output, {'vars': vars})
        # Calibration should PASS only if the underlying mechanism GRADER REJECTS (pass=False)
        self.assertTrue(result['pass'])


class TestScorerMalformed(unittest.TestCase):
    """Tests that must fail for malformed/invalid inputs (fail closed)."""

    def test_malformed_output_missing_case_id(self):
        """Missing caseId in output should fail closed."""
        case_id = 'core/leakage.cross-tenant.matrix'
        vars = {'caseId': case_id}
        output = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            # caseId missing!
            'measurement': {'status': 'success'},
        }
        result = get_assert(output, {'vars': vars})
        self.assertFalse(result['pass'])  # Fail closed

    def test_malformed_output_missing_result(self):
        """Missing result for core/GA mode should fail closed."""
        case_id = 'core/leakage.cross-tenant.matrix'
        vars = {'caseId': case_id}
        output = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'success'},
            # result missing!
            'provenance': {'gitSha': '81c7c9c58a4fc3c1e34ab9714614882d74a60c9d', 'fixtureVersion': 'none', 'model': 'none'}
        }
        result = get_assert(output, {'vars': vars})
        self.assertFalse(result['pass'])  # Fail closed

    def test_mismatched_case_id_mode(self):
        """Case ID mode mismatch should fail closed."""
        case_id = 'core/leakage.cross-tenant.matrix'
        vars = {'caseId': case_id}
        output = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': 'ga/fake-id',  # MISMATCH
            'measurement': {'status': 'success'},
            'result': {'pass': True, 'detail': 'fake'},
            'provenance': {'gitSha': '81c7c9c58a4fc3c1e34ab9714614882d74a60c9d', 'fixtureVersion': 'none', 'model': 'none'}
        }
        result = get_assert(output, {'vars': vars})
        self.assertFalse(result['pass'])  # Fail closed

    def test_missing_evidence_for_ga(self):
        """GA missing sources should fail closed."""
        case_id = 'ga/ga-budget-stage-and-units'
        vars = {'caseId': case_id}
        output = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'success'},
            'answer': 'Some answer',
            # sources and requiredSourceIds missing!
            'provenance': {'gitSha': '81c7c9c58a4fc3c1e34ab9714614882d74a60c9d', 'fixtureVersion': 'none', 'model': 'none'}
        }
        result = get_assert(output, {'vars': vars})
        self.assertFalse(result['pass'])  # Fail closed


class TestScorerStringInput(unittest.TestCase):
    """Tests verifying scorer handles JSON string input (as Promptfoo passes it)."""

    def test_string_output_core_passes(self):
        """Scorer must accept JSON string for core case."""
        case_id = 'core/grounding.claim-evidence'
        record = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'pass', 'durationMs': 5},
            'result': {'pass': True, 'detail': 'all evidence-backed'},
            'provenance': {'gitSha': '81c7c9c58a4fc3c1e34ab9714614882d74a60c9d', 'fixtureVersion': 'none', 'model': 'none'}
        }
        result = get_assert(json.dumps(record), {'vars': {'caseId': case_id}})
        self.assertTrue(result['pass'])
        self.assertEqual(result['score'], 1.0)

    def test_string_output_invalid_json_fails_closed(self):
        """Malformed JSON string must fail closed."""
        result = get_assert('{invalid json', {'vars': {'caseId': 'core/grounding.claim-evidence'}})
        self.assertFalse(result['pass'])
        self.assertIn('parse', result['reason'].lower())

    def test_mismatched_case_id_in_record_fails_closed(self):
        """Record caseId different from context caseId must fail closed."""
        case_id = 'core/grounding.claim-evidence'
        record = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': 'ga/ga-budget-stage-and-units',  # WRONG
            'measurement': {'status': 'pass'},
            'result': {'pass': True, 'detail': 'fake'},
            'provenance': {'model': 'none'}
        }
        result = get_assert(json.dumps(record), {'vars': {'caseId': case_id}})
        self.assertFalse(result['pass'])
        self.assertIn('mismatch', result['reason'].lower())

    def test_fabricated_citation_fails_ga(self):
        """GA case with fabricated citation [999] must fail scorer."""
        case_id = 'ga/ga-budget-stage-and-units'
        record = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'fail'},
            'answer': 'The answer with fake citation [999].',
            'sources': [{'id': 1, 'title': 'S1', 'text': 'text'}],
            'requiredSourceIds': [1],
            'expect': {'mustCite': True},
            'grade': {'pass': False, 'failures': ['citation [999] has no supplied source']},
            'provenance': {'model': 'none'}
        }
        result = get_assert(json.dumps(record), {'vars': {'caseId': case_id}})
        # GA grader rejected answer, so scorer should fail
        self.assertFalse(result['pass'])

    def test_forbidden_tool_fails_plan(self):
        """Plan case with forbidden recommended tool must fail scorer."""
        case_id = 'plan/overland-ai-profile'
        record = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'complete'},
            'plan': {
                'recipeTool': 'research_external_company',
                'subjectScope': 'external_entity',
                'targetHint': 'overland ai',
                'recommendedTools': ['research_external_company', 'research_federal_market_strategy'],  # FORBIDDEN
            },
            'provenance': {'model': 'none'}
        }
        vars_ = {
            'caseId': case_id,
            'request': 'what does overland ai do',
            'forbiddenRecommendedTools': ['research_federal_market_strategy'],
        }
        result = get_assert(json.dumps(record), {'vars': vars_})
        self.assertFalse(result['pass'])
        self.assertIn('research_federal_market_strategy', result['reason'])

    def test_wrong_target_hint_fails_plan(self):
        """Plan case with wrong targetHint must fail scorer."""
        case_id = 'plan/overland-ai-profile'
        record = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'complete'},
            'plan': {
                'recipeTool': 'research_external_company',
                'subjectScope': 'external_entity',
                'targetHint': 'some other company',  # WRONG
            },
            'provenance': {'model': 'none'}
        }
        vars_ = {
            'caseId': case_id,
            'request': 'what does overland ai do',
            'expectedTargetHint': 'overland ai',
        }
        result = get_assert(json.dumps(record), {'vars': vars_})
        self.assertFalse(result['pass'])

    def test_calibration_bad_citation_passes_when_grader_rejects(self):
        """calibration/bad-citation: scorer PASSES when grader correctly rejects."""
        case_id = 'calibration/bad-citation'
        record = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'complete'},
            'grade': {'pass': False, 'failures': ['citation [999] has no supplied source']},
            'provenance': {'model': 'none'}
        }
        result = get_assert(json.dumps(record), {'vars': {'caseId': case_id}})
        self.assertTrue(result['pass'], 'Calibration must PASS when grader rejects bad citation')

    def test_calibration_bad_citation_fails_when_grader_accepts(self):
        """calibration/bad-citation: scorer FAILS when grader incorrectly accepts."""
        case_id = 'calibration/bad-citation'
        record = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'complete'},
            'grade': {'pass': True, 'failures': []},  # WRONG: grader should have rejected
            'provenance': {'model': 'none'}
        }
        result = get_assert(json.dumps(record), {'vars': {'caseId': case_id}})
        self.assertFalse(result['pass'], 'Calibration must FAIL when grader accepts bad citation')

    def test_calibration_tenant_leak_passes_when_mechanism_rejects(self):
        """calibration/tenant-leak: scorer PASSES when mechanism correctly rejects."""
        case_id = 'calibration/tenant-leak'
        record = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'fail'},
            'result': {'pass': False, 'detail': 'LEAK across matrix: a→b:secret'},
            'provenance': {'model': 'none'}
        }
        result = get_assert(json.dumps(record), {'vars': {'caseId': case_id}})
        self.assertTrue(result['pass'], 'Calibration must PASS when mechanism rejects the leak')

    def test_calibration_tenant_leak_fails_when_mechanism_passes(self):
        """calibration/tenant-leak: scorer FAILS when mechanism incorrectly passes (no detection)."""
        case_id = 'calibration/tenant-leak'
        record = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'pass'},
            'result': {'pass': True, 'detail': 'all clean'},  # WRONG: seeded failure should have leaked
            'provenance': {'model': 'none'}
        }
        result = get_assert(json.dumps(record), {'vars': {'caseId': case_id}})
        self.assertFalse(result['pass'], 'Calibration must FAIL when mechanism passes (misses seeded leak)')

    def test_tampered_report_provenance_model_fails(self):
        """Record with provenance.model != 'none' must fail closed."""
        case_id = 'core/grounding.claim-evidence'
        record = {
            'schemaVersion': 1,
            'datasetVersion': 'meri-offline-v1',
            'caseId': case_id,
            'measurement': {'status': 'pass'},
            'result': {'pass': True, 'detail': 'ok'},
            'provenance': {'model': 'gpt-4'}  # TAMPERED: should be 'none'
        }
        result = get_assert(json.dumps(record), {'vars': {'caseId': case_id}})
        self.assertFalse(result['pass'])


class TestAdditionalContracts(unittest.TestCase):
    """Negative controls for claims the offline report must not overstate."""

    def record(self, case_id, **fields):
        return {'schemaVersion': 1, 'datasetVersion': 'meri-offline-v1',
                'caseId': case_id, 'measurement': {'status': 'complete'},
                'provenance': {'model': 'none'}, **fields}

    def score(self, record, **expectations):
        vars_ = {'caseId': record['caseId'], **expectations}
        return get_assert(json.dumps(record), {'vars': vars_})

    def test_missing_provenance_is_not_a_pass(self):
        record = self.record('core/grounding.claim-evidence',
                             result={'pass': True, 'detail': 'grounded'})
        del record['provenance']
        self.assertFalse(self.score(record)['pass'])

    def test_core_failure_status_is_not_a_success_despite_result_pass(self):
        record = self.record('core/grounding.claim-evidence',
                             measurement={'status': 'fail'},
                             result={'pass': True, 'detail': 'inconsistent'})
        self.assertFalse(self.score(record)['pass'])

    def test_core_truthy_string_is_not_a_boolean_pass(self):
        record = self.record('core/grounding.claim-evidence',
                             measurement={'status': 'pass'},
                             result={'pass': 'yes', 'detail': 'inconsistent'})
        self.assertFalse(self.score(record)['pass'])

    def test_ga_failure_status_cannot_become_a_reference_pass(self):
        record = self.record(
            'ga/ga-budget-stage-and-units', measurement={'status': 'fail'},
            answer='FY2027 appropriation context. [1]',
            sources=[{'id': 1, 'title': 'Synthetic', 'text': 'Synthetic'}],
            requiredSourceIds=[1],
            expect={'mustInclude': ['FY2027'], 'mustNotInclude': [], 'mustCite': True},
            grade={'pass': True, 'failures': []})
        self.assertFalse(self.score(record)['pass'])

    def test_planner_failure_status_cannot_pass_expected_recipe(self):
        record = self.record(
            'plan/portfolio-changes', measurement={'status': 'fail'},
            plan={'recipeTool': 'query_portfolio_changes', 'subjectScope': 'portfolio'})
        self.assertFalse(self.score(record, expectedRecipeTool='query_portfolio_changes',
                                    expectedSubjectScope='portfolio')['pass'])

    def test_sequence_failure_status_cannot_pass_target_clear(self):
        plan = {'recipeTool': None, 'subjectScope': 'client', 'targetHint': None}
        record = self.record(
            'sequence/cleared-prior-target', measurement={'status': 'fail'},
            plan=plan, turns=[{'targetHint': 'Overland AI'}, plan])
        self.assertFalse(self.score(record, expectedSecondTargetHint='__none__')['pass'])

    def test_bad_citation_calibration_requires_completed_measurement(self):
        record = self.record(
            'calibration/bad-citation', measurement={'status': 'fail'},
            grade={'pass': False, 'failures': ['citation [999] not supplied']})
        self.assertFalse(self.score(record)['pass'])

    def test_tenant_leak_calibration_requires_underlying_failure_status(self):
        record = self.record(
            'calibration/tenant-leak', measurement={'status': 'complete'},
            result={'pass': False, 'detail': 'LEAK detected in synthetic matrix'})
        self.assertFalse(self.score(record)['pass'])

    def test_forged_ga_grade_cannot_hide_unknown_citation(self):
        record = self.record(
            'ga/ga-budget-stage-and-units',
            answer='FY2027 0609001N DEM-1 is down 25%. [1][999]',
            sources=[{'id': 1, 'title': 'Synthetic', 'text': 'Synthetic source'}],
            requiredSourceIds=[1],
            expect={'mustInclude': ['FY2027'], 'mustNotInclude': [], 'mustCite': True},
            grade={'pass': True, 'failures': []})
        self.assertFalse(self.score(record)['pass'])

    def test_forged_ga_grade_cannot_hide_missing_required_evidence(self):
        record = self.record(
            'ga/ga-budget-stage-and-units',
            answer='FY2027 0609001N DEM-1 is down 25%. [1]',
            sources=[{'id': 1, 'title': 'Client', 'text': 'Synthetic'},
                     {'id': 2, 'title': 'Budget', 'text': 'Synthetic'}],
            requiredSourceIds=[1, 2],
            expect={'mustInclude': ['FY2027'], 'mustNotInclude': [], 'mustCite': True},
            grade={'pass': True, 'failures': []})
        self.assertFalse(self.score(record)['pass'])

    def test_forged_ga_grade_cannot_hide_forbidden_claim(self):
        record = self.record(
            'ga/ga-budget-stage-and-units',
            answer='FY2027 funding is secured. [1]',
            sources=[{'id': 1, 'title': 'Synthetic', 'text': 'Synthetic'}],
            requiredSourceIds=[1],
            expect={'mustInclude': [], 'mustNotInclude': ['funding is secured'],
                    'mustCite': True}, grade={'pass': True, 'failures': []})
        self.assertFalse(self.score(record)['pass'])

    def test_explicit_none_is_checked_for_client_recipe_and_target(self):
        record = self.record('plan/selected-client-priorities',
                             plan={'recipeTool': None, 'subjectScope': 'client',
                                   'targetHint': None})
        self.assertTrue(self.score(record, expectedRecipeTool='__none__',
                                   expectedSubjectScope='client',
                                   expectedTargetHint='__none__')['pass'])

    def test_expected_recommended_tool_cannot_be_omitted(self):
        record = self.record('plan/portfolio-changes',
                             plan={'recipeTool': 'query_portfolio_changes',
                                   'subjectScope': 'portfolio',
                                   'recommendedTools': []})
        result = self.score(record,
                            expectedRecommendedTools_json='["query_portfolio_changes"]')
        self.assertFalse(result['pass'])
        self.assertIn('query_portfolio_changes', result['reason'])

    def test_sequence_recipe_mismatch_fails_even_when_target_matches(self):
        second_plan = {'recipeTool': None, 'subjectScope': 'portfolio',
                       'targetHint': 'Kinetic Industries Inc'}
        record = self.record('sequence/portfolio-overlap-with-target',
                             plan=second_plan,
                             turns=[{'targetHint': 'Kinetic Industries Inc'},
                                    second_plan])
        result = self.score(
            record, expectedFirstTargetHint='Kinetic Industries Inc',
            expectedSecondTargetHint='Kinetic Industries Inc',
            expectedSecondRecipeTool='query_portfolio_overlap',
            expectedSecondSubjectScope='portfolio')
        self.assertFalse(result['pass'])
        self.assertIn('expectedSecondRecipeTool', result['reason'])

    def test_sequence_explicitly_cleared_target_passes(self):
        record = self.record('sequence/cleared-prior-target',
                             plan={'recipeTool': None, 'subjectScope': 'client',
                                   'targetHint': None},
                             turns=[{'targetHint': 'Overland AI'},
                                    {'recipeTool': None, 'subjectScope': 'client',
                                     'targetHint': None}])
        self.assertTrue(self.score(
            record, expectedFirstTargetHint='Overland AI',
            expectedSecondTargetHint='__none__',
            expectedSecondRecipeTool='__none__',
            expectedSecondSubjectScope='client')['pass'])

if __name__ == '__main__':
    unittest.main()
