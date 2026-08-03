"""capiro_defense_budget_parser.canonical_json — canonical JSON serialization.

Mirrors apps/api/src/defense-budget/contracts/canonical-json.ts exactly.
- object keys sorted lexicographically (recursively)
- array order preserved
- no insignificant whitespace
- rejects non-JSON values
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json_stringify(value: Any) -> str:
    """Serialize a JSON-safe value to canonical form."""
    return json.dumps(
        _canonicalize(value), sort_keys=True, separators=(',', ':'), ensure_ascii=False
    )


def sha256_canonical_json(value: Any) -> str:
    """SHA-256 (lowercase hex) of the canonical JSON form of a value."""
    return hashlib.sha256(canonical_json_stringify(value).encode('utf-8')).hexdigest()


def sha256_hex(input_str: str) -> str:
    """SHA-256 (lowercase hex) of an arbitrary UTF-8 string."""
    return hashlib.sha256(input_str.encode('utf-8')).hexdigest()


def _canonicalize(value: Any) -> Any:
    """Recursively convert to canonical JSON-safe form with sorted keys."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if not isinstance(value, bool):
            import math

            if math.isnan(value) or math.isinf(value):
                raise ValueError(f'non-finite number is not JSON-safe: {value}')
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return [_canonicalize(item) for item in value]
    if isinstance(value, dict):
        return {k: _canonicalize(v) for k, v in sorted(value.items())}
    raise ValueError(f'value of type {type(value).__name__} is not JSON-safe')
