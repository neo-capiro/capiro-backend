from pathlib import Path
import re

ROOT = Path(".")

def read(path):
    return (ROOT / path).read_text(encoding="utf-8")

def write(path, text):
    (ROOT / path).write_text(text, encoding="utf-8")

def replace_once(path, old, new):
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one exact match, found {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))

def regex_once(path, pattern, replacement, flags=0):
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{path}: expected one regex match, found {count}: {pattern[:120]!r}")
    write(path, updated)

replace_once(
    "packages/meriv2-core/src/context/governed-columns.ts",
    '''               memory_authority AS "governedAuthority",
               source_type AS "sourceType", source_id AS "sourceId",''',
    '''               memory_authority AS "governedAuthority",
               status AS "legacyStatus",
               governed_status AS "governedStatus",
               source_type AS "sourceType", source_id AS "sourceId",''',
)

replace_once(
    "packages/meriv2-core/src/context/contract.ts",
    '''  visibility?: string | null;
  status: string;
  expiresAt?: string | Date | null;''',
    '''  visibility?: string | null;
  status: string;
  legacyStatus?: string | null;
  governedStatus?: GovernedMemoryStatus | string | null;
  expiresAt?: string | Date | null;''',
)
replace_once(
    "packages/meriv2-core/src/context/contract.ts",
    '''  authority: MemoryAuthority;
  status: GovernedMemoryStatus;
  sourceType: string;''',
    '''  authority: MemoryAuthority;
  status: GovernedMemoryStatus;
  legacyStatus: string | null;
  sourceType: string;''',
)

replace_once(
    "packages/meriv2-core/src/memory/governance.ts",
    '''export const TERMINAL_GOVERNED_STATUSES = ['revoked', 'superseded', 'rejected', 'expired'] as const;
export type TerminalGovernedStatus = (typeof TERMINAL_GOVERNED_STATUSES)[number];

/**''',
    '''export const TERMINAL_GOVERNED_STATUSES = ['revoked', 'superseded', 'rejected', 'expired'] as const;
export type TerminalGovernedStatus = (typeof TERMINAL_GOVERNED_STATUSES)[number];

export const RECALLABLE_GOVERNED_STATUSES = ['active', 'stale', 'conflicted'] as const;

/**
 * The single in-memory lifecycle predicate for v2 and direct governed recall.
 * A conflicted row is usable only when it is the explicitly designated
 * controlling item for the unresolved group. Noncontrolling claims are withheld.
 */
export function governedRecallEligible(
  record: Pick<
    GovernedMemoryRecord,
    'id' | 'status' | 'conflictStatus' | 'controllingItemId'
  >,
): boolean {
  const unresolved =
    record.conflictStatus === 'open' || record.conflictStatus === 'controlling';
  const controls = record.controllingItemId === record.id;

  if (record.status === 'active' || record.status === 'stale') {
    return !unresolved || controls;
  }
  if (record.status === 'conflicted') {
    return unresolved && controls;
  }
  return false;
}

/**''',
)
replace_once(
    "packages/meriv2-core/src/memory/governance.ts",
    '''const TERMINAL_SQL_LIST = TERMINAL_GOVERNED_STATUSES.map((s) => `'${s}'`).join(',');
const SAFE_SQL_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;''',
    '''const SAFE_SQL_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;''',
)
regex_once(
    "packages/meriv2-core/src/memory/governance.ts",
    r'''export function governedRecallSuppressionSql\(enabled: boolean, alias = ''\): string \{
  if \(!enabled\) return '';
  if \(alias !== '' && !SAFE_SQL_ALIAS\.test\(alias\)\) \{
    throw new Error\(`governedRecallSuppressionSql: unsafe alias \$\{JSON\.stringify\(alias\)\}`\);
  \}
  const column = alias \? `\$\{alias\}\.governed_status` : 'governed_status';
  return `\\n            AND \$\{column\} NOT IN \(\$\{TERMINAL_SQL_LIST\}\)`;
\}''',
    '''export function governedRecallEligibilitySql(alias = ''): string {
  if (alias !== '' && !SAFE_SQL_ALIAS.test(alias)) {
    throw new Error(`governedRecallEligibilitySql: unsafe alias ${JSON.stringify(alias)}`);
  }
  const prefix = alias ? `${alias}.` : '';
  const status = `${prefix}governed_status`;
  const conflict = `${prefix}conflict_status`;
  const controlling = `${prefix}controlling_item_id`;
  const id = `${prefix}id`;

  return `(
              (
                ${status} IN ('active', 'stale')
                AND (
                  COALESCE(${conflict}, 'none') NOT IN ('open', 'controlling')
                  OR ${controlling} = ${id}
                )
              )
              OR (
                ${status} = 'conflicted'
                AND COALESCE(${conflict}, 'none') IN ('open', 'controlling')
                AND ${controlling} = ${id}
              )
            )`;
}

export function governedRecallSuppressionSql(enabled: boolean, alias = ''): string {
  if (!enabled) return '';
  return `\n            AND ${governedRecallEligibilitySql(alias)}`;
}''',
)
replace_once(
    "packages/meriv2-core/src/memory/governance.ts",
    '''  if (!['active', 'stale'].includes(record.status)) {
    return { include: false, reason: 'inactive_status' };
  }''',
    '''  if (!governedRecallEligible(record)) {
    if (
      record.status === 'conflicted' ||
      record.conflictStatus === 'open' ||
      record.conflictStatus === 'controlling'
    ) {
      return { include: false, reason: 'conflict_unresolved' };
    }
    return { include: false, reason: 'inactive_status' };
  }''',
)
replace_once(
    "packages/meriv2-core/src/memory/governance.ts",
    '''  if (
    record.conflictStatus === 'open' &&
    (!record.controllingItemId || record.controllingItemId !== record.id)
  ) {
    return { include: false, reason: 'conflict_unresolved' };
  }
''',
    '',
)
replace_once(
    "packages/meriv2-core/src/memory/governance.ts",
    '''  const conflictPenalty = record.conflictStatus === 'open' ? 1 : 0;''',
    '''  const conflictPenalty =
    record.status === 'conflicted' ||
    record.conflictStatus === 'open' ||
    record.conflictStatus === 'controlling'
      ? 1
      : 0;''',
)

replace_once(
    "packages/meriv2-core/src/context/compiler.ts",
    '''    const now = req.now ?? new Date();

    for (const layer of req.layers) {''',
    '''    const now = req.now ?? new Date();
    let staleCount = 0;
    let conflictCount = 0;

    for (const layer of req.layers) {''',
)
replace_once(
    "packages/meriv2-core/src/context/compiler.ts",
    '''        if (!decision.include) {
          exclusions.push(exclusionFor(row, layer, suppressionToExclusion(decision.reason)));
          continue;
        }
        const tier = selectionTier(record);''',
    '''        if (!decision.include) {
          if (decision.reason === 'conflict_unresolved') conflictCount += 1;
          exclusions.push(
            exclusionFor(row, layer, suppressionToExclusion(decision.reason, record.status)),
          );
          continue;
        }
        if (record.status === 'stale') staleCount += 1;
        if (
          record.status === 'conflicted' ||
          record.conflictStatus === 'open' ||
          record.conflictStatus === 'controlling'
        ) {
          conflictCount += 1;
        }
        const tier = selectionTier(record);''',
)
replace_once(
    "packages/meriv2-core/src/context/compiler.ts",
    '''        authority: record.authority,
        status: record.status,
        sourceType: record.sourceType,''',
    '''        authority: record.authority,
        status: record.status,
        legacyStatus: row.legacyStatus ?? row.status ?? null,
        sourceType: record.sourceType,''',
)
replace_once(
    "packages/meriv2-core/src/context/compiler.ts",
    '''    const conflictCount = exclusions.filter((item) => item.reason === 'conflicted').length;
    const sourceFailureCount = exclusions.filter((item) =>''',
    '''    const sourceFailureCount = exclusions.filter((item) =>''',
)
replace_once(
    "packages/meriv2-core/src/context/compiler.ts",
    '''      ...(conflictCount ? [`${conflictCount} unresolved conflict(s) withheld`] : []),
      ...(sourceFailureCount ? [`${sourceFailureCount} source failure(s)`] : []),''',
    '''      ...(conflictCount ? [`${conflictCount} governed conflict(s) present or withheld`] : []),
      ...(staleCount ? [`${staleCount} stale context item(s) included pending review`] : []),
      ...(sourceFailureCount ? [`${sourceFailureCount} source failure(s)`] : []),''',
)
replace_once(
    "packages/meriv2-core/src/context/compiler.ts",
    '''      : sourceFailureCount || missingRequiredLayers.length
        ? 'degraded' ''',
    '''      : sourceFailureCount || missingRequiredLayers.length || staleCount
        ? 'degraded' ''',
)
replace_once(
    "packages/meriv2-core/src/context/compiler.ts",
    '''  const status = isStatus(row.status) ? row.status : legacy.status;''',
    '''  // v2 lifecycle is governed_status only. Missing or invalid governed
  // state is quarantined instead of inheriting a permissive legacy status.
  const status = isStatus(row.governedStatus) ? row.governedStatus : 'pending_review';''',
)
regex_once(
    "packages/meriv2-core/src/context/compiler.ts",
    r'''function suppressionToExclusion\(reason: string\): ContextExclusion\['reason'\] \{
  const map: Record<string, ContextExclusion\['reason'\]> = \{
(?P<body>.*?)  \};
  return map\[reason\] \?\? 'unavailable';
\}''',
    lambda m: '''function suppressionToExclusion(
  reason: string,
  status: GovernedMemoryStatus,
): ContextExclusion['reason'] {
  if (reason === 'inactive_status') {
    if (status === 'suggested' || status === 'pending_review') return 'unapproved';
    if (status === 'rejected') return 'rejected';
    if (status === 'superseded') return 'superseded';
    if (status === 'revoked') return 'revoked';
    if (status === 'expired') return 'expired';
    if (status === 'conflicted') return 'conflicted';
    return 'unavailable';
  }
  const map: Record<string, ContextExclusion['reason']> = {
''' + m.group("body").replace("    inactive_status: 'revoked',\n", "") + '''  };
  return map[reason] ?? 'unavailable';
}''',
    flags=re.S,
)
replace_once(
    "packages/meriv2-core/src/context/compiler.ts",
    '''    `authority=${JSON.stringify(record.authority)}`,
    `scope=${JSON.stringify(record.scope)}`,''',
    '''    `authority=${JSON.stringify(record.authority)}`,
    `status=${JSON.stringify(record.status)}`,
    `scope=${JSON.stringify(record.scope)}`,''',
)
replace_once(
    "packages/meriv2-core/src/context/compiler.ts",
    '''    statusRank(a.status) - statusRank(b.status) ||''',
    '''    statusRank(a.governedStatus ?? a.status) -
      statusRank(b.governedStatus ?? b.status) ||''',
)

replace_once(
    "apps/api/src/memory/memory-recall-suppression.helpers.ts",
    '''import { governedRecallSuppressionSql, TERMINAL_GOVERNED_STATUSES } from '@capiro/meriv2-core';''',
    '''import {
  governedRecallEligibilitySql,
  governedRecallSuppressionSql,
  TERMINAL_GOVERNED_STATUSES,
} from '@capiro/meriv2-core';''',
)
replace_once(
    "apps/api/src/memory/memory-recall-suppression.helpers.ts",
    '''export { governedRecallSuppressionSql, TERMINAL_GOVERNED_STATUSES };

const TERMINAL_SQL_LIST = TERMINAL_GOVERNED_STATUSES.map((s) => `'${s}'`).join(',');''',
    '''export {
  governedRecallEligibilitySql,
  governedRecallSuppressionSql,
  TERMINAL_GOVERNED_STATUSES,
};''',
)
replace_once(
    "apps/api/src/memory/memory-recall-suppression.helpers.ts",
    '''               AND mi_sup.governed_status IN (${TERMINAL_SQL_LIST})''',
    '''               AND NOT ${governedRecallEligibilitySql('mi_sup')}''',
)

replace_once(
    "apps/api/src/meri/meri-context-packet-view.ts",
    '''  authority?: unknown;
  selectionTier?: unknown;''',
    '''  authority?: unknown;
  status?: unknown;
  legacyStatus?: unknown;
  selectionTier?: unknown;''',
)
replace_once(
    "apps/api/src/meri/meri-context-packet-view.ts",
    '''          authority: authorityOf(item.authority) ?? 'human-authored',
          ...(scope === 'client' && clientName ? { clientName } : {}),''',
    '''          authority: authorityOf(item.authority) ?? 'human-authored',
          ...(text(item.status) ? { status: String(item.status) } : {}),
          ...(scope === 'client' && clientName ? { clientName } : {}),''',
)
replace_once(
    "apps/web/src/components/trust/ContextInspector.tsx",
    '''  authority?: ContextAuthority | null;
  clientName?: string | null;''',
    '''  authority?: ContextAuthority | null;
  status?: string | null;
  clientName?: string | null;''',
)
replace_once(
    "apps/web/src/components/trust/ContextInspector.tsx",
    '''const AUTHORITY_LABELS: Record<string, string> = {''',
    '''const STATUS_LABELS: Record<string, string> = {
  suggested: 'Suggested',
  pending_review: 'Pending review',
  active: 'Active',
  stale: 'Stale — review due',
  conflicted: 'Conflicted — controlling item',
  rejected: 'Rejected',
  superseded: 'Superseded',
  revoked: 'Revoked',
  expired: 'Expired',
};

const AUTHORITY_LABELS: Record<string, string> = {''',
)
replace_once(
    "apps/web/src/components/trust/ContextInspector.tsx",
    '''                  {item.authority ? (
                    <span>Authority · {authorityLabel(item.authority)}</span>
                  ) : null}
                  {item.selection ? <span>{selectionLabel(item.selection)}</span> : null}''',
    '''                  {item.authority ? (
                    <span>Authority · {authorityLabel(item.authority)}</span>
                  ) : null}
                  {item.status ? (
                    <span>Lifecycle · {STATUS_LABELS[item.status] ?? 'Unknown'}</span>
                  ) : null}
                  {item.selection ? <span>{selectionLabel(item.selection)}</span> : null}''',
)

replace_once(
    "packages/meriv2-core/src/context/compiler-v2.spec.ts",
    '''  visibility: 'tenant',
  status: 'active',
  expiresAt: null,''',
    '''  visibility: 'tenant',
  status: 'active',
  legacyStatus: 'active',
  governedStatus: 'active',
  expiresAt: null,''',
)
replace_once(
    "packages/meriv2-core/src/context/compiler-v2.spec.ts",
    '''        status: 'active',
        sourceType: 'firm_playbook',''',
    '''        status: 'active',
        legacyStatus: 'active',
        sourceType: 'firm_playbook',''',
)
anchor = '''  it('records token budgeting, omitted sections and incomplete health', async () => {'''
matrix = '''  it('uses governed status for every lifecycle decision and never legacy status', async () => {
    const statuses = [
      'suggested',
      'pending_review',
      'active',
      'stale',
      'rejected',
      'superseded',
      'revoked',
      'expired',
    ] as const;
    const rows: SteeringRow[] = statuses.map((status) =>
      row({
        id: status,
        status: 'active',
        legacyStatus: 'active',
        governedStatus: status,
      }),
    );
    rows.push(
      row({
        id: 'conflicted-controlling',
        status: 'active',
        legacyStatus: 'active',
        governedStatus: 'conflicted',
        conflictStatus: 'open',
        conflictGroupId: 'group-1',
        controllingItemId: 'conflicted-controlling',
      }),
      row({
        id: 'conflicted-noncontrolling',
        status: 'active',
        legacyStatus: 'active',
        governedStatus: 'conflicted',
        conflictStatus: 'open',
        conflictGroupId: 'group-1',
        controllingItemId: 'conflicted-controlling',
      }),
    );
    const packet = v2(
      await compilerFor(rows).compiler.compile(
        request({ clientId: null, layers: ['firm-identity'] }),
      ),
    );
    expect(packet.items.map((item) => item.id)).toEqual([
      'active',
      'stale',
      'conflicted-controlling',
    ]);
    expect(packet.items.map((item) => item.status)).toEqual(['active', 'stale', 'conflicted']);
    expect(packet.items.every((item) => item.legacyStatus === 'active')).toBe(true);
    expect(Object.fromEntries(packet.exclusions.map((item) => [item.id, item.reason]))).toEqual({
      suggested: 'unapproved',
      pending_review: 'unapproved',
      rejected: 'rejected',
      superseded: 'superseded',
      revoked: 'revoked',
      expired: 'expired',
      'conflicted-noncontrolling': 'conflicted',
    });
    expect(packet.health.status).toBe('conflicted');
    expect(packet.health.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('governed conflict'),
        expect.stringContaining('stale context item'),
      ]),
    );
  });

'''
replace_once("packages/meriv2-core/src/context/compiler-v2.spec.ts", anchor, matrix + anchor)
replace_once(
    "packages/meriv2-core/src/context/compiler-v2.spec.ts",
    '''    expect(packet.rendered[0]?.body).toContain('instructions_allowed=false');''',
    '''    expect(packet.rendered[0]?.body).toContain('instructions_allowed=false');
    expect(packet.rendered[0]?.body).toContain('status="active"');''',
)

replace_once(
    "packages/meriv2-core/src/memory/governance.spec.ts",
    '''  InvalidMemoryTransitionError,
  TERMINAL_GOVERNED_STATUSES,''',
    '''  InvalidMemoryTransitionError,
  RECALLABLE_GOVERNED_STATUSES,
  TERMINAL_GOVERNED_STATUSES,''',
)
replace_once(
    "packages/meriv2-core/src/memory/governance.spec.ts",
    '''  fourEyesSatisfied,
  governedMemoryLifecycleEnabled,
  governedRecallSuppressionSql,''',
    '''  fourEyesSatisfied,
  governedMemoryLifecycleEnabled,
  governedRecallEligible,
  governedRecallEligibilitySql,
  governedRecallSuppressionSql,''',
)
replace_once(
    "packages/meriv2-core/src/memory/governance.spec.ts",
    '''  it('suppresses revoked, superseded, rejected, expired and invalid memories', () => {
    for (const status of ['revoked', 'superseded', 'rejected', 'expired'] as const) {''',
    '''  it('suppresses every non-recallable governed status and invalid memories', () => {
    for (const status of [
      'suggested',
      'pending_review',
      'revoked',
      'superseded',
      'rejected',
      'expired',
    ] as const) {''',
)
replace_once(
    "packages/meriv2-core/src/memory/governance.spec.ts",
    '''    expect(
      filterGovernedMemory(
        base({ conflictStatus: 'open', conflictGroupId: 'group-1', controllingItemId: 'memory-1' }),
        access,
      ),
    ).toEqual({ include: true });
  });
});''',
    '''    expect(
      filterGovernedMemory(
        base({ conflictStatus: 'open', conflictGroupId: 'group-1', controllingItemId: 'memory-1' }),
        access,
      ),
    ).toEqual({ include: true });
    expect(
      filterGovernedMemory(
        base({
          status: 'conflicted',
          conflictStatus: 'open',
          conflictGroupId: 'group-1',
          controllingItemId: 'memory-1',
        }),
        access,
      ),
    ).toEqual({ include: true });
    expect(
      filterGovernedMemory(
        base({
          id: 'memory-2',
          status: 'conflicted',
          conflictStatus: 'open',
          conflictGroupId: 'group-1',
          controllingItemId: 'memory-1',
        }),
        access,
      ),
    ).toEqual({ include: false, reason: 'conflict_unresolved' });
  });

  it('defines one exact in-memory recallability predicate', () => {
    expect(RECALLABLE_GOVERNED_STATUSES).toEqual(['active', 'stale', 'conflicted']);
    expect(governedRecallEligible(base({ status: 'active' }))).toBe(true);
    expect(governedRecallEligible(base({ status: 'stale' }))).toBe(true);
    expect(governedRecallEligible(base({ status: 'pending_review' }))).toBe(false);
  });
});''',
)
regex_once(
    "packages/meriv2-core/src/memory/governance.spec.ts",
    r'''  it\('suppresses exactly the four terminal statuses', \(\) => \{
.*?  it\('refuses an alias that is not a bare identifier', \(\) => \{''',
    '''  it('admits active/stale and only the controlling unresolved conflict', () => {
    const sql = governedRecallSuppressionSql(true, 'mi');
    expect(sql).toContain("mi.governed_status IN ('active', 'stale')");
    expect(sql).toContain("mi.governed_status = 'conflicted'");
    expect(sql).toContain('mi.controlling_item_id = mi.id');
    expect(sql).toContain('mi.conflict_status');
    for (const status of TERMINAL_GOVERNED_STATUSES) {
      expect(sql).not.toContain(`'${status}'`);
    }
  });

  it('supports an unaliased FROM memory_items', () => {
    expect(governedRecallSuppressionSql(true)).toContain(
      "governed_status IN ('active', 'stale')",
    );
    expect(governedRecallEligibilitySql()).toContain('controlling_item_id = id');
  });

  it('refuses an alias that is not a bare identifier', () => {''',
    flags=re.S,
)
replace_once(
    "packages/meriv2-core/src/memory/governance.spec.ts",
    '''    expect(() => governedRecallSuppressionSql(true, 'mi.client_id')).toThrow(/unsafe alias/);
  });''',
    '''    expect(() => governedRecallSuppressionSql(true, 'mi.client_id')).toThrow(/unsafe alias/);
    expect(() => governedRecallEligibilitySql('mi.client_id')).toThrow(/unsafe alias/);
  });''',
)

replace_once(
    "apps/api/src/memory/memory-recall-suppression.helpers.spec.ts",
    '''  governedClioSuppressionSql,
  governedRecallSuppressionEnabled,''',
    '''  governedClioSuppressionSql,
  governedRecallEligibilitySql,
  governedRecallSuppressionEnabled,''',
)
regex_once(
    "apps/api/src/memory/memory-recall-suppression.helpers.spec.ts",
    r'''  it\('suppresses exactly the four terminal statuses when armed', \(\) => \{
.*?  it\('refuses an alias that is not a bare identifier', \(\) => \{''',
    '''  it('uses the exact active/stale/controlling-conflict predicate when armed', () => {
    const sql = governedRecallSuppressionSql(true, 'mi');
    expect(sql).toContain("mi.governed_status IN ('active', 'stale')");
    expect(sql).toContain("mi.governed_status = 'conflicted'");
    expect(sql).toContain('mi.controlling_item_id = mi.id');
    for (const status of TERMINAL_GOVERNED_STATUSES) {
      expect(sql).not.toContain(`'${status}'`);
    }
  });

  it('supports an unaliased FROM memory_items', () => {
    expect(governedRecallSuppressionSql(true)).toContain(
      "governed_status IN ('active', 'stale')",
    );
    expect(governedRecallEligibilitySql()).toContain('controlling_item_id = id');
  });

  it('refuses an alias that is not a bare identifier', () => {''',
    flags=re.S,
)
replace_once(
    "apps/api/src/memory/memory-recall-suppression.helpers.spec.ts",
    '''    for (const status of TERMINAL_GOVERNED_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }''',
    '''    expect(sql).toContain('AND NOT');
    expect(sql).toContain("mi_sup.governed_status IN ('active', 'stale')");
    expect(sql).toContain('mi_sup.controlling_item_id = mi_sup.id');''',
)

for path in [
    "apps/api/src/context/context-compiler-v2.service.spec.ts",
    "apps/meriv2-orchestrator/src/meri/context-compiler-v2.service.spec.ts",
]:
    replace_once(
        path,
        '''    clientId: null,
    status: 'active',
    sections:''',
        '''    clientId: null,
    status: 'active',
    legacyStatus: 'active',
    governedStatus: 'active',
    sections:''',
    )
    replace_once(
        path,
        '''    expect(select).toContain('memory_class AS "memoryClass"');
    expect(select).toContain('approved_by_user_id AS "approvedByUserId"');''',
        '''    expect(select).toContain('memory_class AS "memoryClass"');
    expect(select).toContain('approved_by_user_id AS "approvedByUserId"');
    expect(select).toContain('status AS "legacyStatus"');
    expect(select).toContain('governed_status AS "governedStatus"');''',
    )

api_anchor = '''  it('shadow persists both traces, returns unchanged v1, and records comparison evidence', async () => {'''
api_test = '''  it('legacy active cannot override governed revoked', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const { prisma } = makePrisma([
      {
        ...APPROVED_FIRM_ROW,
        status: 'active',
        legacyStatus: 'active',
        governedStatus: 'revoked',
      },
    ]);
    const packet = await new ContextCompilerService(prisma).compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'in-editor',
      layers: ['firm-identity'],
    });
    expect(packet.version).toBe(2);
    if (packet.version !== 2) throw new Error('expected v2');
    expect(packet.items).toEqual([]);
    expect(packet.exclusions).toEqual([
      expect.objectContaining({ id: APPROVED_FIRM_ROW.id, reason: 'revoked' }),
    ]);
  });

'''
replace_once("apps/api/src/context/context-compiler-v2.service.spec.ts", api_anchor, api_test + api_anchor)

orch_anchor = '''  it('tenant umbrella without the exact surface canary stays on v1 under global enforce', async () => {'''
orch_test = '''  it('Strategy uses governed lifecycle rather than legacy status', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const { prisma } = makePrisma([
      {
        ...ROW,
        status: 'active',
        legacyStatus: 'active',
        governedStatus: 'superseded',
      },
    ]);
    const packet = await new OrchestratorContextCompilerService(prisma).compile({
      tenantId: 't1',
      userId: 'u1',
      surface: 'strategy',
      layers: ['firm-identity'],
    });
    expect(packet.version).toBe(2);
    if (packet.version !== 2) throw new Error('expected v2');
    expect(packet.items).toEqual([]);
    expect(packet.exclusions).toEqual([
      expect.objectContaining({ id: ROW.id, reason: 'superseded' }),
    ]);
  });

'''
replace_once(
    "apps/meriv2-orchestrator/src/meri/context-compiler-v2.service.spec.ts",
    orch_anchor,
    orch_test + orch_anchor,
)

replace_once(
    "apps/workspace/src/generation/context-compiler.canonical-memory.spec.ts",
    '''  visibility: 'tenant',
  status: 'active',
  sections:''',
    '''  visibility: 'tenant',
  status: 'active',
  legacyStatus: 'active',
  governedStatus: 'active',
  sections:''',
)
replace_once(
    "apps/workspace/src/generation/context-compiler.canonical-memory.spec.ts",
    '''    expect(packet.version).toBe(2);
    expect(packet.items).toEqual([''',
    '''    expect(packet.version).toBe(2);
    expect(h.sql.find((text) => text.includes('FROM memory_items'))).toContain(
      'governed_status AS "governedStatus"',
    );
    expect(packet.items).toEqual([''',
)
workspace_anchor = '''  it('a tenant umbrella without the exact Workspace surface canary remains on v1', async () => {'''
workspace_test = '''  it('Workspace excludes a governed terminal row when legacy status is active', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const h = harness();
    const original = ROW.governedStatus;
    ROW.governedStatus = 'expired';
    try {
      const packet = await h.service.compileForClerkOwner({
        tenantId: 't1',
        surface: 'workspace-gen',
        layers: ['firm-playbook'],
      });
      expect(packet.version).toBe(2);
      if (packet.version !== 2) throw new Error('expected v2');
      expect(packet.items).toEqual([]);
      expect(packet.exclusions).toEqual([
        expect.objectContaining({ id: ROW.id, reason: 'expired' }),
      ]);
    } finally {
      ROW.governedStatus = original;
    }
  });

'''
replace_once(
    "apps/workspace/src/generation/context-compiler.canonical-memory.spec.ts",
    workspace_anchor,
    workspace_test + workspace_anchor,
)

replace_once(
    "apps/api/src/meri/meri-context-packet-view.spec.ts",
    '''        authority: 'model_inferred',
        selectionTier: 'episodic_inferred',''',
    '''        authority: 'model_inferred',
        status: 'stale',
        legacyStatus: 'active',
        selectionTier: 'episodic_inferred',''',
)
replace_once(
    "apps/api/src/meri/meri-context-packet-view.spec.ts",
    '''        authority: 'client_approved',
        selectionTier: 'explicit',''',
    '''        authority: 'client_approved',
        status: 'active',
        legacyStatus: 'active',
        selectionTier: 'explicit',''',
)
replace_once(
    "apps/api/src/meri/meri-context-packet-view.spec.ts",
    '''        authority: 'model_inferred',
        selection: 'automatic',''',
    '''        authority: 'model_inferred',
        status: 'stale',
        selection: 'automatic',''',
)
replace_once(
    "apps/api/src/meri/meri-context-packet-view.spec.ts",
    '''        authority: 'client_approved',
        selection: 'explicit',''',
    '''        authority: 'client_approved',
        status: 'active',
        selection: 'explicit',''',
)
replace_once(
    "apps/web/src/components/trust/ContextInspector.test.tsx",
    '''      authority: 'human-approved',
      rationale:''',
    '''      authority: 'human-approved',
      status: 'active',
      rationale:''',
)
replace_once(
    "apps/web/src/components/trust/ContextInspector.test.tsx",
    '''      clientName: 'Acme',
      selection: 'explicit',''',
    '''      clientName: 'Acme',
      status: 'stale',
      selection: 'explicit',''',
)
replace_once(
    "apps/web/src/components/trust/ContextInspector.test.tsx",
    '''    expect(screen.getByText('Client policy position')).toBeTruthy();''',
    '''    expect(screen.getByText('Client policy position')).toBeTruthy();
    expect(screen.getByText('Lifecycle · Active')).toBeTruthy();
    expect(screen.getByText('Lifecycle · Stale — review due')).toBeTruthy();''',
)
ui_anchor = '''  it('labels the new v2 exclusion reasons rather than showing a raw slug', () => {'''
ui_test = '''  it('renders an unknown lifecycle without echoing an internal slug', () => {
    render(
      <ContextInspector
        packet={{
          items: [
            {
              id: 'mi-status',
              label: 'Unknown lifecycle',
              type: 'firm-soul',
              scope: 'firm',
              status: 'future_internal_state',
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByText(/Context used/i));
    expect(screen.getByText('Lifecycle · Unknown')).toBeTruthy();
    expect(screen.queryByText(/future_internal_state/)).toBeNull();
  });

'''
replace_once(
    "apps/web/src/components/trust/ContextInspector.test.tsx",
    ui_anchor,
    ui_test + ui_anchor,
)

replace_once(
    ".github/workflows/memory-governance-ci.yml",
    '''# Durable Phase 1-8 acceptance matrix.''',
    '''# Durable Phase 1-9 acceptance matrix.''',
)
replace_once(
    ".github/workflows/memory-governance-ci.yml",
    '''          src/meri/governed-meri-tools.proxy.spec.ts
          src/meri/meri-context-packet.controller.spec.ts''',
    '''          src/meri/governed-meri-tools.proxy.spec.ts
          src/meri/meri-context-packet-view.spec.ts
          src/meri/meri-context-packet.controller.spec.ts''',
)
replace_once(
    ".github/workflows/memory-governance-ci.yml",
    '''      - name: Test Phase 8 core persistence rollout and surface policy
        run: >
          pnpm --filter @capiro/meriv2-core exec jest --ci --runInBand
          src/context/truthful-compiler.spec.ts''',
    '''      - name: Test Phase 9 governed lifecycle, persistence rollout and surface policy
        run: >
          pnpm --filter @capiro/meriv2-core exec jest --ci --runInBand
          src/memory/governance.spec.ts
          src/context/truthful-compiler.spec.ts''',
)

print("PHASE9_APPLY_OK")
