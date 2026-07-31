from pathlib import Path

ROOT = Path('.')


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one exact match, found {count}: {old[:120]!r}')
    target.write_text(text.replace(old, new, 1), encoding='utf-8')


replace_once(
    'packages/meriv2-core/src/context/context-rollout.ts',
    '''  const requiredSourceFailureCount = packet.exclusions.filter(
    (item) =>
      requiredLayerSet.has(item.layer) && ['source-missing', 'unavailable'].includes(item.reason),
  ).length;

  const reasons = packet.health.reasons.filter(''',
    '''  const requiredSourceFailureCount = packet.exclusions.filter(
    (item) =>
      requiredLayerSet.has(item.layer) && ['source-missing', 'unavailable'].includes(item.reason),
  ).length;
  const staleCount = packet.items.filter((item) => item.status === 'stale').length;

  const reasons = packet.health.reasons.filter(''',
)
replace_once(
    'packages/meriv2-core/src/context/context-rollout.ts',
    '''      : requiredSourceFailureCount > 0 || missingRequiredLayers.length > 0
        ? 'degraded'
        : 'healthy';''',
    '''      : requiredSourceFailureCount > 0 || missingRequiredLayers.length > 0 || staleCount > 0
        ? 'degraded'
        : 'healthy';''',
)
replace_once(
    'packages/meriv2-core/src/context/context-rollout.spec.ts',
    '''  visibility: 'tenant',
  status: 'active',
  expiresAt: null,''',
    '''  visibility: 'tenant',
  status: 'active',
  legacyStatus: 'active',
  governedStatus: 'active',
  expiresAt: null,''',
)
anchor = '''  it('missing required context degrades and identifies the required layer', async () => {'''
test = '''  it('keeps stale governed context degraded after the rollout finalizer', async () => {
    const h = harness([approvedFirm({ governedStatus: 'stale' })]);
    const packet = await h.compiler.compile(request(), 'enforce');
    expect(packet.version).toBe(2);
    if (packet.version !== 2) throw new Error('expected v2');
    expect(packet.items).toEqual([
      expect.objectContaining({
        status: 'stale',
        legacyStatus: 'active',
      }),
    ]);
    expect(packet.health.status).toBe('degraded');
    expect(packet.health.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('stale context item')]),
    );
    expect(packet.incomplete).toBe(true);
  });

'''
replace_once(
    'packages/meriv2-core/src/context/context-rollout.spec.ts',
    anchor,
    test + anchor,
)

print('PHASE9_FOLLOWUP_OK')
