"""Contract tests for the independent Meri Promptfoo report verifier.

Synthetic reports are intentionally NOT benchmark evidence; they only exercise the
verification logic. All temporary files live under ignored workspace artifacts.
"""

import json
import hashlib
import subprocess
import tempfile
import unittest
from unittest import mock
from copy import deepcopy
from pathlib import Path

import verify_report as verifier_module
from verify_report import verify_report

EVAL_DIR = Path(__file__).resolve().parent
CONTRACT = json.loads((EVAL_DIR / 'suite-contract.json').read_text(encoding='utf-8'))
ARTIFACT_DIR = EVAL_DIR.parents[1] / '.artifacts' / 'meri-promptfoo' / 'verifier-tests'

def current_checkout_sha():
    return subprocess.check_output(
        ['git', '-C', str(EVAL_DIR.parents[1]), 'rev-parse', 'HEAD'],
        text=True, stderr=subprocess.DEVNULL, timeout=3,
    ).strip()

def current_input_hashes():
    paths = {**verifier_module.INPUT_PATHS, 'ga_fixture': verifier_module.FIXTURE_PATH}
    return {name: hashlib.sha256(file.read_bytes()).hexdigest()
            for name, file in paths.items()}


def synthetic_report():
    rows = []
    source_sha = current_checkout_sha()
    for case_ids in CONTRACT['caseIds'].values():
        for case_id in case_ids:
            record = {'schemaVersion': CONTRACT['schemaVersion'],
                      'datasetVersion': CONTRACT['version'], 'caseId': case_id,
                      'measurement': {'status': 'complete'},
                      'provenance': {'model': 'none', 'gitSha': source_sha,
                                     'fixtureVersion': CONTRACT['fixtureVersion'],
                                     'inputSha256': current_input_hashes()}}
            rows.append({'vars': {'caseId': case_id}, 'success': True, 'score': 1,
                         'gradingResult': {'pass': True, 'score': 1,
                                           'componentResults': [
                                               {'pass': True, 'score': 1,
                                                'assertion': {'type': 'python',
                                                              'value': 'file://./scorer.py',
                                                              'threshold': 1}}]},
                         'response': {'output': json.dumps(record)}})
    return {'config': {'defaultTest': {'assert': [
                {'type': 'python', 'value': 'file://./scorer.py', 'threshold': 1}]}},
            'runtimeOptions': {'cache': False}, 'shareableUrl': None,
            'results': {'results': rows,
                        'stats': {'successes': len(rows), 'failures': 0, 'errors': 0,
                                  'tokenUsage': {'total': 0}}}}


class VerifyReportContractTests(unittest.TestCase):
    def setUp(self):
        ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
        temp = tempfile.TemporaryDirectory(prefix='report-', dir=ARTIFACT_DIR)
        self.addCleanup(temp.cleanup)
        self.report_path = Path(temp.name) / 'report.json'
        self.summary_path = Path(temp.name) / 'summary.json'
        self.report = synthetic_report()

    def check(self):
        self.report_path.write_text(json.dumps(self.report), encoding='utf-8')
        return verify_report(str(self.report_path), str(self.summary_path))

    def test_suite_contract_base_sha_is_immutable_initial_snapshot(self):
        self.assertEqual(CONTRACT['baseSha'], '81c7c9c58a4fc3c1e34ab9714614882d74a60c9d')
        self.assertEqual(CONTRACT['provenance']['baseGitSha'], CONTRACT['baseSha'])

    def test_complete_report_passes(self):
        result = self.check()
        self.assertTrue(result['success'], result)
        self.assertEqual(result['pass_count'], CONTRACT['totalCases'])
        self.assertTrue(self.summary_path.is_file())

    def test_inconsistent_stats_cannot_hide_missing_successes(self):
        self.report['results']['stats']['successes'] = 0
        self.assertFalse(self.check()['success'])

    def test_zero_scored_assertion_cannot_hide_behind_success_true(self):
        row = self.report['results']['results'][0]
        row['score'] = 0
        row['gradingResult']['score'] = 0
        row['gradingResult']['componentResults'][0]['score'] = 0
        self.assertFalse(self.check()['success'])

    def test_nonfinite_score_cannot_count_as_a_pass(self):
        self.report['results']['results'][0]['score'] = float('nan')
        self.assertFalse(self.check()['success'])

    def test_missing_python_assertion_cannot_pass(self):
        self.report['results']['results'][0]['gradingResult']['componentResults'] = []
        self.assertFalse(self.check()['success'])

    def test_wrong_payload_id_cannot_hide_behind_correct_vars(self):
        row = self.report['results']['results'][0]
        record = json.loads(row['response']['output'])
        record['caseId'] = 'core/not-the-expected-case'
        row['response']['output'] = json.dumps(record)
        self.assertFalse(self.check()['success'])

    def test_claimed_live_model_is_rejected(self):
        row = self.report['results']['results'][0]
        record = json.loads(row['response']['output'])
        record['provenance']['model'] = 'live-model'
        row['response']['output'] = json.dumps(record)
        self.assertFalse(self.check()['success'])

    def test_uniform_but_stale_source_sha_is_rejected(self):
        for row in self.report['results']['results']:
            record = json.loads(row['response']['output'])
            record['provenance']['gitSha'] = 'f' * 40
            row['response']['output'] = json.dumps(record)
        self.assertFalse(self.check()['success'])

    def test_changed_fixture_bytes_do_not_pass_at_the_same_version(self):
        fake_fixture = self.report_path.parent / 'changed-fixtures.ts'
        fake_fixture.write_text('synthetic mutated fixture', encoding='utf-8')
        with mock.patch.object(verifier_module, 'FIXTURE_PATH', fake_fixture, create=True):
            self.assertFalse(self.check()['success'])

    def test_stale_scorer_bytes_cannot_validate_a_previous_report(self):
        self.assertTrue(self.check()['success'])
        fake_scorer = self.report_path.parent / 'changed-scorer.py'
        fake_scorer.write_text('# synthetic scorer change', encoding='utf-8')
        with mock.patch.dict(verifier_module.INPUT_PATHS, {'scorer': fake_scorer}):
            self.assertFalse(self.check()['success'])

    def test_summary_records_hashes_of_actual_harness_inputs(self):
        result = self.check()
        self.assertTrue(result['success'])
        self.assertIn('input_sha256', result)
        expected_paths = {
            'config': EVAL_DIR / 'promptfooconfig.yaml',
            'scorer': EVAL_DIR / 'scorer.py',
            'provider': EVAL_DIR / 'runtime' / 'provider.cjs',
            'runner': EVAL_DIR / 'runtime' / 'runner.mjs',
            'ga_fixture': EVAL_DIR.parents[1] / 'apps' / 'api' / 'src' / 'meri' / 'evals' / 'government-affairs-fixtures.ts',
        }
        for name, file in expected_paths.items():
            self.assertEqual(result['input_sha256'][name], hashlib.sha256(file.read_bytes()).hexdigest())

    def test_cached_run_is_not_offline_reproducible_evidence(self):
        self.report['runtimeOptions']['cache'] = True
        self.assertFalse(self.check()['success'])

    def test_shared_run_is_not_offline_private_evidence(self):
        self.report['shareableUrl'] = 'https://example.invalid/a-share'
        self.assertFalse(self.check()['success'])

    def test_duplicate_case_id_is_rejected(self):
        self.report['results']['results'].append(deepcopy(self.report['results']['results'][0]))
        self.report['results']['stats']['successes'] += 1
        self.assertFalse(self.check()['success'])


if __name__ == '__main__':
    unittest.main()
