"""Tests for the CLI (Workstream E)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from capiro_defense_budget_parser.cli import main


class TestVersionCommand:
    def test_version_prints_and_exits_0(self, capsys):
        exit_code = main(['version'])
        out = capsys.readouterr().out
        assert exit_code == 0
        assert 'capiro-defense-budget-parser' in out

    def test_version_includes_version_number(self, capsys):
        from capiro_defense_budget_parser import __version__

        exit_code = main(['version'])
        out = capsys.readouterr().out
        assert exit_code == 0
        assert __version__ in out


class TestValidateJobCommand:
    def test_valid_job_exits_0(self, tmp_path: Path, capsys):
        job = {
            'schemaVersion': 'defense_budget_parser_job_v1',
            'jobId': 'job-test-001',
            'sourcePath': '/work/input.pdf',
            'sourceSha256': 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
            'engine': 'deterministic_pdfplumber',
            'requestedPages': [1, 2, 3],
            'parserVersion': 'pdfplumber-0.11.0',
            'parserConfig': {'tableStrategy': 'lines'},
            'parserConfigSha256':
                'e3d0f0c1a2b3e4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9',
            'outputDirectory': '/work/output',
            'includeDebugArtifacts': False,
        }
        job_path = tmp_path / 'job.json'
        job_path.write_text(json.dumps(job))

        exit_code = main(['validate-job', '--job', str(job_path)])
        assert exit_code == 0
        assert 'valid' in capsys.readouterr().out.lower()

    def test_invalid_job_exits_2(self, tmp_path: Path, capsys):
        job = {'schemaVersion': 'wrong', 'jobId': 'x'}
        job_path = tmp_path / 'job.json'
        job_path.write_text(json.dumps(job))

        exit_code = main(['validate-job', '--job', str(job_path)])
        assert exit_code == 2

    def test_missing_job_file_exits_2(self, capsys):
        exit_code = main(['validate-job', '--job', '/nonexistent/job.json'])
        assert exit_code == 2


class TestProfileCommand:
    def test_source_sha_mismatch_exits_3(self, tmp_path: Path, capsys):
        job = {
            'schemaVersion': 'defense_budget_parser_job_v1',
            'jobId': 'job-test-001',
            'sourcePath': str(tmp_path / 'input.pdf'),
            'sourceSha256': 'a' * 64,
            'engine': 'deterministic_pdfplumber',
            'requestedPages': [1],
            'parserVersion': 'pdfplumber-0.11.0',
            'parserConfig': {},
            'parserConfigSha256': 'b' * 64,
            'outputDirectory': '/work/output',
            'includeDebugArtifacts': False,
        }
        job_path = tmp_path / 'job.json'
        job_path.write_text(json.dumps(job))

        # Create a minimal PDF
        (tmp_path / 'input.pdf').write_bytes(b'%PDF-1.0\n%%EOF\n')

        exit_code = main([
            'profile', '--job', str(job_path),
            '--out', str(tmp_path / 'result.json'),
        ])
        assert exit_code == 3


class TestRunCommand:
    def test_unsupported_engine_exits_4(self, tmp_path: Path):
        job = {
            'schemaVersion': 'defense_budget_parser_job_v1',
            'jobId': 'job-test-001',
            'sourcePath': '/work/input.pdf',
            'sourceSha256': 'a' * 64,
            'engine': 'nonexistent_engine',
            'requestedPages': [1],
            'parserVersion': 'test',
            'parserConfig': {},
            'parserConfigSha256': 'b' * 64,
            'outputDirectory': '/work/output',
            'includeDebugArtifacts': False,
        }
        job_path = tmp_path / 'job.json'
        job_path.write_text(json.dumps(job))

        exit_code = main(['run', '--job', str(job_path), '--out', str(tmp_path / 'result.json')])
        assert exit_code == 4

    def test_missing_job_file_exits_2(self):
        exit_code = main(['run', '--job', '/nonexistent.json', '--out', '/tmp/out.json'])
        assert exit_code == 2


class TestExitCodes:
    """E5: exit codes 0, 2, 3, 4, 5, 6."""

    def test_exit_code_0_success(self):
        assert main(['version']) == 0

    def test_exit_code_2_contract_failure(self):
        assert main(['validate-job', '--job', '/nonexistent.json']) == 2

    def test_exit_code_2_missing_command(self):
        with pytest.raises(SystemExit) as exc_info:
            main([])
        # argparse exits with 2 on missing required subcommand
        assert exc_info.value.code == 2
