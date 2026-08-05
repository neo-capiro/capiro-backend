"""Tests for the isolated parser runtime CLI."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from capiro_defense_budget_parser import cli
from capiro_defense_budget_parser.cli import main
from capiro_defense_budget_parser.contracts import ParserRuntimeResultV1


def valid_job(tmp_path: Path, **overrides):
    source = tmp_path / 'input.pdf'
    source.write_bytes(b'%PDF-1.4\n%%EOF\n')
    value = {
        'schemaVersion': 'defense_budget_parser_job_v1',
        'jobId': 'job-test-001',
        'sourcePath': str(source),
        'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'engine': 'deterministic_pdfplumber',
        'requestedPages': [1],
        'parserVersion': 'pdfplumber-0.11.0',
        'parserConfig': {},
        'parserConfigSha256': 'b' * 64,
        'outputDirectory': str(tmp_path / 'out'),
        'includeDebugArtifacts': False,
    }
    value.update(overrides)
    return value


def valid_profile_job(tmp_path: Path, **overrides):
    source = tmp_path / 'input.pdf'
    source.write_bytes(b'%PDF-1.4\n%%EOF\n')
    value = {
        'schemaVersion': 'defense_budget_profile_job_v1',
        'jobId': 'profile-test-001',
        'sourcePath': str(source),
        'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'engine': 'deterministic_pdfplumber',
        'allPages': True,
        'requestedPages': [],
        'parserVersion': 'pdfplumber-0.11.0',
        'parserConfig': {},
        'parserConfigSha256': 'b' * 64,
        'outputDirectory': str(tmp_path / 'out'),
        'includeDebugArtifacts': False,
    }
    value.update(overrides)
    return value


class TestVersionCommand:
    def test_version_prints_runtime_and_engines(self, capsys):
        assert main(['version']) == 0
        out = capsys.readouterr().out
        assert 'capiro-defense-budget-parser' in out
        assert 'docling:' in out
        assert 'paddleocr:' in out

    def test_version_json_is_machine_readable(self, capsys):
        assert main(['version', '--json']) == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload['runtimeVersion']
        assert payload['engines']['deterministic_pdfplumber'] == 'pdfplumber-0.11.0'
        assert payload['engines']['docling']


class TestValidateJobCommand:
    def test_valid_job_exits_0(self, tmp_path: Path, capsys):
        job_path = tmp_path / 'job.json'
        job_path.write_text(json.dumps(valid_job(tmp_path)))
        assert main(['validate-job', '--job', str(job_path)]) == 0
        assert 'valid' in capsys.readouterr().out.lower()

    def test_invalid_job_exits_2(self, tmp_path: Path):
        job_path = tmp_path / 'job.json'
        job_path.write_text(json.dumps({'schemaVersion': 'wrong', 'jobId': 'x'}))
        assert main(['validate-job', '--job', str(job_path)]) == 2

    def test_missing_job_file_exits_2(self):
        assert main(['validate-job', '--job', '/nonexistent/job.json']) == 2


class TestProfileCommand:
    def test_source_sha_mismatch_exits_3(self, tmp_path: Path):
        job = valid_profile_job(tmp_path, sourceSha256='a' * 64)
        job_path = tmp_path / 'job.json'
        job_path.write_text(json.dumps(job))
        assert (
            main(['profile', '--job', str(job_path), '--out', str(tmp_path / 'result.json')]) == 3
        )

    def test_explicit_all_pages_profiles_the_full_document(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        job = valid_profile_job(tmp_path)
        job_path = tmp_path / 'job.json'
        result_path = tmp_path / 'profile.json'
        job_path.write_text(json.dumps(job))
        called = {'full': 0, 'partial': 0}

        def profile_document(source_path, expected_sha256):
            called['full'] += 1
            return {
                'schemaVersion': 'defense_budget_page_profile_v1',
                'sourceSha256': expected_sha256,
                'pages': [{'page': 1}],
                'summary': {'pageCount': 1},
                'profileConfigSha256': 'c' * 64,
                'contentSha256': 'd' * 64,
            }

        def profile_pages(*args, **kwargs):
            called['partial'] += 1
            raise AssertionError('profile_pages must not handle profile-all')

        import capiro_defense_budget_parser.pdf_profile as profile_module

        monkeypatch.setattr(profile_module, 'profile_document', profile_document)
        monkeypatch.setattr(profile_module, 'profile_pages', profile_pages)
        assert main(['profile', '--job', str(job_path), '--out', str(result_path)]) == 0
        assert called == {'full': 1, 'partial': 0}
        assert json.loads(result_path.read_text())['pages'][0]['page'] == 1

    def test_explicit_page_subset_uses_profile_pages(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        job = valid_profile_job(tmp_path, allPages=False, requestedPages=[2, 4])
        job_path = tmp_path / 'job.json'
        result_path = tmp_path / 'profile.json'
        job_path.write_text(json.dumps(job))
        called = {'full': 0, 'partial': []}

        def profile_document(*args, **kwargs):
            called['full'] += 1
            raise AssertionError('profile_document must not handle a page subset')

        def profile_pages(source_path, expected_sha256, requested_pages):
            called['partial'] = list(requested_pages)
            return {
                'schemaVersion': 'defense_budget_page_profile_v1',
                'sourceSha256': expected_sha256,
                'pages': [{'page': page} for page in requested_pages],
                'summary': {'pageCount': len(requested_pages)},
                'profileConfigSha256': 'c' * 64,
                'contentSha256': 'd' * 64,
            }

        import capiro_defense_budget_parser.pdf_profile as profile_module

        monkeypatch.setattr(profile_module, 'profile_document', profile_document)
        monkeypatch.setattr(profile_module, 'profile_pages', profile_pages)
        assert main(['profile', '--job', str(job_path), '--out', str(result_path)]) == 0
        assert called == {'full': 0, 'partial': [2, 4]}

    def test_profile_contract_rejects_ambiguous_scope(self, tmp_path: Path):
        job = valid_profile_job(tmp_path, allPages=True, requestedPages=[1])
        job_path = tmp_path / 'job.json'
        job_path.write_text(json.dumps(job))
        assert main(['profile', '--job', str(job_path), '--out', str(tmp_path / 'out.json')]) == 2


class TestRunCommand:
    def test_unsupported_engine_exits_4(self, tmp_path: Path):
        job = valid_job(tmp_path, engine='nonexistent_engine', parserVersion='test')
        job_path = tmp_path / 'job.json'
        result_path = tmp_path / 'result.json'
        job_path.write_text(json.dumps(job))
        assert main(['run', '--job', str(job_path), '--out', str(result_path)]) == 4

    def test_missing_job_file_exits_2(self):
        assert main(['run', '--job', '/nonexistent.json', '--out', '/tmp/out.json']) == 2

    def test_docling_is_dispatched_as_a_supported_engine(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        job = valid_job(tmp_path, engine='docling', parserVersion='docling-2-test-cpu')
        job_path = tmp_path / 'job.json'
        result_path = tmp_path / 'result.json'
        job_path.write_text(json.dumps(job))

        def run_docling_engine(**kwargs):
            return ParserRuntimeResultV1(
                schemaVersion='defense_budget_parser_result_v1',
                jobId=kwargs['job_id'],
                engine='docling',
                parserVersion='docling-2-test-cpu',
                parserConfigSha256=job['parserConfigSha256'],
                inputSourceSha256=job['sourceSha256'],
                requestedPages=[1],
                succeededPages=[1],
                failedPages=[],
                pages=[],
                warnings=[],
                metrics={
                    'durationMillis': 1,
                    'pagesProcessed': 1,
                    'pagesSucceeded': 1,
                    'pagesFailed': 0,
                    'engineVersion': 'docling-2-test-cpu',
                },
                contentSha256='e' * 64,
            )

        fake_module = SimpleNamespace(
            ENGINE_VERSION='docling-2-test-cpu', run_docling_engine=run_docling_engine
        )
        monkeypatch.setitem(sys.modules, 'capiro_defense_budget_parser.docling_engine', fake_module)
        monkeypatch.setattr(
            cli,
            '_engine_versions',
            lambda: {
                'deterministic_pdfplumber': 'pdfplumber-0.11.0',
                'camelot': 'camelot-0.11.0',
                'docling': 'docling-2-test-cpu',
                'paddleocr': 'paddleocr-pp-structure-v3-cpu',
            },
        )
        assert main(['run', '--job', str(job_path), '--out', str(result_path)]) == 0
        assert json.loads(result_path.read_text())['engine'] == 'docling'


class TestExitCodes:
    def test_success_and_contract_failures(self):
        assert main(['version']) == 0
        assert main(['validate-job', '--job', '/nonexistent.json']) == 2

    def test_missing_command_uses_argparse_exit_2(self):
        with pytest.raises(SystemExit) as exc_info:
            main([])
        assert exc_info.value.code == 2
