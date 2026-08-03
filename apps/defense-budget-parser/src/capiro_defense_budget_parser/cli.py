"""capiro_defense_budget_parser.cli — command-line interface for the parser runtime.

Usage:
    capiro-defense-budget-parser run --job /work/job.json --out /work/result.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog='capiro-defense-budget-parser',
        description='Isolated Python parser runtime for defense-budget PDFs',
    )
    sub = parser.add_subparsers(dest='command', required=True)

    run_parser = sub.add_parser('run', help='Run a parser job')
    run_parser.add_argument('--job', required=True, help='Path to job JSON file')
    run_parser.add_argument('--out', required=True, help='Path to write result JSON')

    args = parser.parse_args(argv)

    if args.command == 'run':
        job = _load_job(args.job)
        result = _dispatch_engine(job)
        _write_result(result, args.out)
        return 0

    return 1


if __name__ == '__main__':
    sys.exit(main())
