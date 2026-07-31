from pathlib import Path

ROOT = Path('.')


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one exact match, found {count}: {old[:140]!r}')
    target.write_text(text.replace(old, new, 1), encoding='utf-8')


canonical = 'apps/api/src/memory/memory-canonical-activation.helpers.spec.ts'
replace_once(
    canonical,
    '''      visibility: item.visibility,
      status: item.status,
      expiresAt: item.expiresAt ?? null,''',
    '''      visibility: item.visibility,
      status: item.status,
      legacyStatus: item.status,
      governedStatus: item.governedStatus,
      expiresAt: item.expiresAt ?? null,''',
)
replace_once(
    canonical,
    '''      visibility: item.visibility,
      status: 'pending_review',
      sections: item.sections,''',
    '''      visibility: item.visibility,
      status: item.status,
      legacyStatus: item.status,
      governedStatus: 'pending_review',
      sections: item.sections,''',
)
replace_once(
    canonical,
    '''    expect(packet.exclusions).toEqual([expect.objectContaining({ id: ITEM, reason: 'revoked' })]);''',
    '''    expect(packet.exclusions).toEqual([
      expect.objectContaining({ id: ITEM, reason: 'unapproved' }),
    ]);''',
)

packet_view = 'apps/api/src/meri/meri-context-packet-view.spec.ts'
replace_once(
    packet_view,
    '''      packetId: 'packet-1',
      compiledAt: '2026-07-29T12:00:00.000Z',''',
    '''      packetId: 'packet-1',
      persisted: true,
      persistenceErrorCode: null,
      compiledAt: '2026-07-29T12:00:00.000Z',''',
)

print('PHASE9_REGRESSION_FIXES_OK')
