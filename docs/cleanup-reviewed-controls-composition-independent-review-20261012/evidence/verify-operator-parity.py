import hashlib
import json
from pathlib import Path

rows = []
for name in ['phase6-stage-cycle.ts', 'plan-defense-budget-promotion-v1.ts', 'status-defense-budget-promotion-v1.ts']:
    canonical = Path('apps/api/scripts') / name
    mirror = Path('apps/defense-api/runtime-source/operators') / name
    before, after = canonical.read_bytes(), mirror.read_bytes()
    assert before == after, name
    rows.append({'canonical': str(canonical), 'mirror': str(mirror), 'sha256': hashlib.sha256(before).hexdigest(), 'exactByteParity': True})
result = {'source': 'fc7ef349e49a943b7020ab78ee9d2b8bdb02f9ed', 'tree': 'ef854c0670db309d396ca2f4e8131b35581c6d81', 'operatorPairs': rows, 'filesExecuted': 0}
Path('docs/cleanup-reviewed-controls-composition-independent-review-20261012/evidence/operator-parity.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
