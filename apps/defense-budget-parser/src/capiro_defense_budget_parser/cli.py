"""Command-line boundary for the isolated defense-budget parser runtime."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from . import __version__
from .contracts import ParserRuntimeJobV1
from .engine_versions import ENGINE_VERSIONS
from .profile_contract import ParserProfileJobV1

EXIT_SUCCESS = 0
EXIT_CONTRACT = 2
EXIT_SOURCE_SHA = 3
EXIT_UNAVAILABLE = 4
EXIT_PARTIAL = 5
EXIT_TOTAL_FAILURE = 6


def _load_json(path: str | Path) -> dict[str, Any]:
    with open(path, encoding='utf-8') as file:
        value = json.load(file)
    if not isinstance(value, dict):
        raise ValueError('expected a JSON object')
    return value


def _load_validated_job(path: str | Path) -> dict[str, Any]:
    return ParserRuntimeJobV1.model_validate(_load_json(path)).model_dump()


def _load_validated_profile_job(path: str | Path) -> dict[str, Any]:
    return ParserProfileJobV1.model_validate(_load_json(path)).model_dump()


def _write_result(result: Any, output_path: str | Path) -> None:
    if hasattr(result, 'model_dump'):
        data = result.model_dump()
    elif isinstance(result, dict):
        data = result
    else:
        raise TypeError(f'unsupported result type: {type(result)}')
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with open(output, 'w', encoding='utf-8') as file:
        json.dump(data, file, indent=2, ensure_ascii=False)
        file.write('\n')


def _engine_versions() -> dict[str, str]:
    return dict(ENGINE_VERSIONS)


def _dispatch_engine(job: dict[str, Any]) -> Any:
    engine = job['engine']
    common = {
        'source_path': job['sourcePath'],
        'expected_sha256': job['sourceSha256'],
        'requested_pages': job['requestedPages'],
        'config': job.get('parserConfig', {}),
        'job_id': job['jobId'],
    }
    if engine == 'deterministic_pdfplumber':
        from .pdfplumber_engine import run_pdfplumber_engine

        return run_pdfplumber_engine(**common)
    if engine == 'camelot':
        from .camelot_engine import run_camelot_engine

        return run_camelot_engine(**common)
    if engine == 'docling':
        from .docling_engine import run_docling_engine

        return run_docling_engine(**common)
    if engine == 'paddleocr':
        from .paddleocr_engine import run_paddleocr_engine

        return run_paddleocr_engine(**common)
    raise ValueError(f'unsupported engine: {engine}')


def _exit_code_from_result(result: Any) -> int:
    data = result.model_dump() if hasattr(result, 'model_dump') else result
    if not isinstance(data, dict):
        return EXIT_TOTAL_FAILURE
    failed = len(data.get('failedPages', []))
    succeeded = len(data.get('succeededPages', []))
    if failed == 0 and succeeded > 0:
        return EXIT_SUCCESS
    if succeeded > 0 and failed > 0:
        return EXIT_PARTIAL
    return EXIT_TOTAL_FAILURE


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='capiro-defense-budget-parser',
        description='Isolated parser runtime for defense-budget PDFs',
    )
    commands = parser.add_subparsers(dest='command', required=True)
    validate = commands.add_parser('validate-job', help='Validate a job JSON file')
    validate.add_argument('--job', required=True)
    profile = commands.add_parser('profile', help='Profile requested pages or the full PDF')
    profile.add_argument('--job', required=True)
    profile.add_argument('--out', required=True)
    run = commands.add_parser('run', help='Run one strict parser job')
    run.add_argument('--job', required=True)
    run.add_argument('--out', required=True)
    version = commands.add_parser('version', help='Print runtime and engine versions')
    version.add_argument('--json', action='store_true', dest='as_json')
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.command == 'version':
        engines = _engine_versions()
        payload = {'runtimeVersion': __version__, 'engines': engines}
        if args.as_json:
            print(json.dumps(payload, sort_keys=True))
        else:
            print(f'capiro-defense-budget-parser {__version__}')
            for engine, version in sorted(engines.items()):
                print(f'{engine}: {version}')
        return EXIT_SUCCESS

    try:
        if args.command == 'validate-job':
            _load_validated_job(args.job)
            print('job is valid')
            return EXIT_SUCCESS

        if args.command == 'profile':
            job = _load_validated_profile_job(args.job)
            from .pdf_profile import profile_document, profile_pages

            result = (
                profile_document(job['sourcePath'], job['sourceSha256'])
                if job['allPages']
                else profile_pages(
                    job['sourcePath'],
                    job['sourceSha256'],
                    job['requestedPages'],
                )
            )
            _write_result(result, args.out)
            return EXIT_SUCCESS

        if args.command == 'run':
            raw_job = _load_json(args.job)
            engine_raw = raw_job.get('engine')
            versions = _engine_versions()
            if not isinstance(engine_raw, str) or engine_raw not in versions:
                print(f'parser unavailable: unsupported engine: {engine_raw}', file=sys.stderr)
                return EXIT_UNAVAILABLE
            engine = engine_raw
            job = ParserRuntimeJobV1.model_validate(raw_job).model_dump()
            actual_version = versions[engine]
            if job['parserVersion'] != actual_version:
                raise ValueError(
                    f'parserVersion mismatch for {engine}: '
                    f'job declares {job["parserVersion"]}, runtime is {actual_version}'
                )
            result = _dispatch_engine(job)
            _write_result(result, args.out)
            return _exit_code_from_result(result)
    except (OSError, json.JSONDecodeError, ValidationError, ValueError, KeyError) as error:
        message = str(error)
        if 'SHA mismatch' in message or 'source SHA mismatch' in message:
            print(f'source SHA mismatch: {message}', file=sys.stderr)
            return EXIT_SOURCE_SHA
        if 'not installed' in message or 'unsupported engine' in message:
            print(f'parser unavailable: {message}', file=sys.stderr)
            return EXIT_UNAVAILABLE
        print(f'contract/argument failure: {message}', file=sys.stderr)
        return EXIT_CONTRACT
    except RuntimeError as error:
        print(f'parser unavailable: {error}', file=sys.stderr)
        return EXIT_UNAVAILABLE
    except Exception as error:  # pragma: no cover
        print(f'parser error: {error}', file=sys.stderr)
        return EXIT_TOTAL_FAILURE

    return EXIT_CONTRACT


if __name__ == '__main__':
    sys.exit(main())
