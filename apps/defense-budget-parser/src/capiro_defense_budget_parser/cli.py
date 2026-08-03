"""capiro_defense_budget_parser.cli — command-line interface for the parser runtime.

Commands:
    validate-job  — validate a job JSON file against the contract
    profile       — run page profiling on a source PDF
    run           — run a parser engine on a source PDF
    version       — print version information

Exit codes:
    0 success
    2 contract/argument failure
    3 source SHA mismatch
    4 parser unavailable
    5 partial page failure
    6 total parser failure

Usage:
    capiro-defense-budget-parser validate-job --job <job.json>
    capiro-defense-budget-parser profile --job <job.json> --out <result.json>
    capiro-defense-budget-parser run --job <job.json> --out <result.json>
    capiro-defense-budget-parser version
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from . import __version__


def _load_job(job_path: str | Path) -> dict[str, Any]:
    with open(job_path, encoding='utf-8') as f:
        data: dict[str, Any] = json.load(f)
        return data


def _write_result(result: Any, output_path: str | Path) -> None:
    if hasattr(result, 'model_dump'):
        data = result.model_dump()
    elif isinstance(result, dict):
        data = result
    else:
        raise TypeError(f'unsupported result type: {type(result)}')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _dispatch_engine(job: dict[str, Any]) -> Any:
    """Dispatch to the correct engine based on the job's engine field."""
    engine = job.get('engine', '')

    if engine == 'deterministic_pdfplumber':
        from .pdfplumber_engine import run_pdfplumber_engine

        config = job.get('parserConfig', {})
        return run_pdfplumber_engine(
            source_path=job['sourcePath'],
            expected_sha256=job['sourceSha256'],
            requested_pages=job['requestedPages'],
            config=config,
            job_id=job.get('jobId', 'pdfplumber-job'),
        )

    if engine == 'camelot':
        from .camelot_engine import run_camelot_engine

        config = job.get('parserConfig', {})
        return run_camelot_engine(
            source_path=job['sourcePath'],
            expected_sha256=job['sourceSha256'],
            requested_pages=job['requestedPages'],
            config=config,
            job_id=job.get('jobId', 'camelot-job'),
        )

    if engine == 'paddleocr':
        from .paddleocr_engine import run_paddleocr_engine

        config = job.get('parserConfig', {})
        return run_paddleocr_engine(
            source_path=job['sourcePath'],
            expected_sha256=job['sourceSha256'],
            requested_pages=job['requestedPages'],
            config=config,
            job_id=job.get('jobId', 'paddleocr-job'),
        )

    raise ValueError(f'unsupported engine: {engine}')


def _exit_code_from_result(result: Any) -> int:
    """Determine exit code from a parser result."""
    if hasattr(result, 'failed_pages') and hasattr(result, 'pages'):
        len(result.requested_pages) if hasattr(result, 'requested_pages') else 0
        failed = len(result.failed_pages)
        succeeded = len(result.pages)
    elif isinstance(result, dict):
        len(result.get('requestedPages', []))
        failed = len(result.get('failedPages', []))
        succeeded = len(result.get('pages', []))
    else:
        return 0

    if failed == 0 and succeeded > 0:
        return 0
    if succeeded > 0 and failed > 0:
        return 5  # partial failure
    if failed > 0 and succeeded == 0:
        return 6  # total failure
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog='capiro-defense-budget-parser',
        description='Isolated Python parser runtime for defense-budget PDFs',
    )
    sub = parser.add_subparsers(dest='command', required=True)

    # validate-job
    vj = sub.add_parser('validate-job', help='Validate a job JSON file')
    vj.add_argument('--job', required=True, help='Path to job JSON file')

    # profile
    prof = sub.add_parser('profile', help='Run page profiling on a source PDF')
    prof.add_argument('--job', required=True, help='Path to job JSON file')
    prof.add_argument('--out', required=True, help='Path to write result JSON')

    # run
    run_p = sub.add_parser('run', help='Run a parser job')
    run_p.add_argument('--job', required=True, help='Path to job JSON file')
    run_p.add_argument('--out', required=True, help='Path to write result JSON')

    # version
    sub.add_parser('version', help='Print version information')

    args = parser.parse_args(argv)

    if args.command == 'version':
        print(f'capiro-defense-budget-parser {__version__}')
        return 0

    if args.command == 'validate-job':
        try:
            job = _load_job(args.job)
        except (OSError, json.JSONDecodeError) as e:
            print(f'error: cannot read job file: {e}', file=sys.stderr)
            return 2

        try:
            from .contracts import ParserRuntimeJobV1

            ParserRuntimeJobV1.model_validate(job)
            print('job is valid')
            return 0
        except Exception as e:
            print(f'job validation failed: {e}', file=sys.stderr)
            return 2

    if args.command == 'profile':
        try:
            job = _load_job(args.job)
        except (OSError, json.JSONDecodeError) as e:
            print(f'error: cannot read job file: {e}', file=sys.stderr)
            return 2

        try:
            from .pdf_profile import profile_pages

            result = profile_pages(
                source_path=job['sourcePath'],
                expected_sha256=job['sourceSha256'],
                requested_pages=job['requestedPages'],
            )
            _write_result(result, args.out)
            return 0
        except ValueError as e:
            if 'SHA mismatch' in str(e):
                print(f'source SHA mismatch: {e}', file=sys.stderr)
                return 3
            print(f'profiling error: {e}', file=sys.stderr)
            return 2
        except Exception as e:
            print(f'profiling error: {e}', file=sys.stderr)
            return 6

    if args.command == 'run':
        try:
            job = _load_job(args.job)
        except (OSError, json.JSONDecodeError) as e:
            print(f'error: cannot read job file: {e}', file=sys.stderr)
            return 2

        try:
            result = _dispatch_engine(job)
            _write_result(result, args.out)
            return _exit_code_from_result(result)
        except ValueError as e:
            if 'SHA mismatch' in str(e):
                print(f'source SHA mismatch: {e}', file=sys.stderr)
                return 3
            if 'unsupported engine' in str(e):
                print(f'parser unavailable: {e}', file=sys.stderr)
                return 4
            print(f'contract failure: {e}', file=sys.stderr)
            return 2
        except RuntimeError as e:
            print(f'parser unavailable: {e}', file=sys.stderr)
            return 4
        except Exception as e:
            print(f'parser error: {e}', file=sys.stderr)
            return 6

    return 1


if __name__ == '__main__':
    sys.exit(main())
