from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}: found {count}\n--- old ---\n{old[:500]}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


# ---------------------------------------------------------------------------
# c1 — additive schema/index expansion. Keep the legacy key until the later
# contract release; this PR must remain rollback-safe for old containers.
# ---------------------------------------------------------------------------
schema = ROOT / "apps/api/prisma/schema.prisma"
replace_once(
    schema,
    '  @@unique([userId, peCode], map: "program_element_watch_user_pe_code_key")\n'
    '  @@index([tenantId, peCode], map: "program_element_watch_tenant_pe_code_idx")',
    '  // Phase C expand step: keep the legacy user+PE key until every API/sync\n'
    '  // container runs tenant-aware code. The legacy key is removed only in a\n'
    '  // separately approved contract migration after the live smoke gate.\n'
    '  @@unique([userId, peCode], map: "program_element_watch_user_pe_code_key")\n'
    '  @@unique([tenantId, userId, peCode], map: "program_element_watch_tenant_user_pe_code_key")\n'
    '  @@index([tenantId, peCode], map: "program_element_watch_tenant_pe_code_idx")',
)

migration_dir = ROOT / "apps/api/prisma/migrations/20260728230000_add_tenant_scoped_pe_watch_key"
migration_dir.mkdir(parents=True, exist_ok=False)
(migration_dir / "migration.sql").write_text(
    '''-- Phase C expand migration: add the tenant-aware natural key while the\n-- legacy (user_id, pe_code) key remains in place for rollback safety.\n--\n-- The legacy key is intentionally NOT dropped here. Dropping it is a separate\n-- contract release after all API and sync-job task definitions use the new code.\n\nDO $$\nBEGIN\n  IF EXISTS (\n    SELECT 1\n    FROM "program_element_watch"\n    GROUP BY "tenant_id", "user_id", "pe_code"\n    HAVING COUNT(*) > 1\n  ) THEN\n    RAISE EXCEPTION\n      'program_element_watch contains duplicate tenant/user/PE rows; aborting tenant-key expansion';\n  END IF;\nEND\n$$;\n\nCREATE UNIQUE INDEX "program_element_watch_tenant_user_pe_code_key"\n  ON "program_element_watch"("tenant_id", "user_id", "pe_code");\n''',
    encoding="utf-8",
)

# ---------------------------------------------------------------------------
# c2 — explicit tenant predicates and no tenant-moving conflict behavior.
# ---------------------------------------------------------------------------
service = ROOT / "apps/api/src/program-element/program-element-read.service.ts"
replace_once(
    service,
    "import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';",
    "import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';",
)
replace_once(
    service,
    "const MAX_RELEVANCE_PROBES = 50;\n",
    '''const MAX_RELEVANCE_PROBES = 50;\n\nconst LEGACY_PE_WATCH_CONSTRAINT = 'program_element_watch_user_pe_code_key';\n\n/**\n * During the expand/contract window the legacy (user_id, pe_code) key still\n * exists so old containers can roll back safely. A user who already watches a\n * PE in another tenant will therefore hit that legacy key until the later\n * contract migration. Detect only that named constraint and fail closed: never\n * rewrite tenant_id and never reveal which other tenant owns the existing row.\n */\nfunction isLegacyPeWatchConstraintConflict(error: unknown): boolean {\n  const candidates: unknown[] = [String(error)];\n  if (error && typeof error === 'object') {\n    const record = error as Record<string, unknown>;\n    candidates.push(record.message, record.code);\n    if (record.meta && typeof record.meta === 'object') {\n      candidates.push(...Object.values(record.meta as Record<string, unknown>));\n    }\n  }\n  return candidates.some(\n    (value) => typeof value === 'string' && value.includes(LEGACY_PE_WATCH_CONSTRAINT),\n  );\n}\n''',
)
replace_once(
    service,
    "    const userId = ctx?.userId ?? null;\n",
    "    const userId = ctx?.userId ?? null;\n    const tenantId = ctx?.tenantId ?? null;\n",
)
replace_once(
    service,
    "    const watchedExpr = userId\n"
    "      ? Prisma.sql`EXISTS (SELECT 1 FROM program_element_watch pw WHERE pw.pe_code = pe.pe_code AND pw.user_id = ${userId}::uuid)`\n"
    "      : Prisma.sql`FALSE`;",
    "    const watchedExpr = userId && tenantId\n"
    "      ? Prisma.sql`EXISTS (SELECT 1 FROM program_element_watch pw WHERE pw.tenant_id = ${tenantId}::uuid AND pw.user_id = ${userId}::uuid AND pw.pe_code = pe.pe_code)`\n"
    "      : Prisma.sql`FALSE`;",
)
replace_once(
    service,
    "          SELECT COUNT(*)::int AS count FROM program_element_watch WHERE user_id = ${ctx.userId}::uuid\n",
    "          SELECT COUNT(*)::int AS count\n"
    "          FROM program_element_watch\n"
    "          WHERE tenant_id = ${ctx.tenantId}::uuid\n"
    "            AND user_id = ${ctx.userId}::uuid\n",
)
replace_once(
    service,
    "        WHERE user_id = ${ctx.userId}::uuid\n"
    "          AND pe_code = ${peCode}\n",
    "        WHERE tenant_id = ${ctx.tenantId}::uuid\n"
    "          AND user_id = ${ctx.userId}::uuid\n"
    "          AND pe_code = ${peCode}\n",
)
replace_once(
    service,
    "          where: { peCode: { in: peCodes } },\n"
    "          select: { peCode: true },",
    "          where: { tenantId: ctx.tenantId, peCode: { in: peCodes } },\n"
    "          select: { peCode: true },",
)
old_set_watching = '''  async setWatching(peCode: string, watching: boolean, ctx: TenantContext) {\n    const programElement = await this.prisma.programElement.findUnique({\n      where: { peCode },\n      select: { peCode: true },\n    });\n    if (!programElement) throw new NotFoundException(`Program element ${peCode} not found`);\n\n    return this.prisma.withTenant(ctx.tenantId, async (tx) => {\n      if (watching) {\n        const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`\n          INSERT INTO program_element_watch (user_id, tenant_id, pe_code)\n          VALUES (${ctx.userId}::uuid, ${ctx.tenantId}::uuid, ${peCode})\n          ON CONFLICT (user_id, pe_code)\n          DO UPDATE SET tenant_id = EXCLUDED.tenant_id\n          RETURNING id\n        `);\n\n        const watchId = inserted[0]?.id ?? null;\n\n        await tx.auditLog.create({\n          data: {\n            tenantId: ctx.tenantId,\n            actorUserId: ctx.userId,\n            actorRole: ctx.role,\n            action: 'program_element.watch.set',\n            entityType: 'program_element_watch',\n            entityId: watchId,\n            after: { peCode, watching: true },\n          },\n        });\n\n        return { peCode, watching: true };\n      }\n\n      const removed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`\n        DELETE FROM program_element_watch\n        WHERE user_id = ${ctx.userId}::uuid\n          AND pe_code = ${peCode}\n        RETURNING id\n      `);\n\n      await tx.auditLog.create({\n        data: {\n          tenantId: ctx.tenantId,\n          actorUserId: ctx.userId,\n          actorRole: ctx.role,\n          action: 'program_element.watch.set',\n          entityType: 'program_element_watch',\n          entityId: removed[0]?.id ?? null,\n          after: { peCode, watching: false },\n        },\n      });\n\n      return { peCode, watching: false };\n    });\n  }\n'''
new_set_watching = '''  async setWatching(peCode: string, watching: boolean, ctx: TenantContext) {\n    const programElement = await this.prisma.programElement.findUnique({\n      where: { peCode },\n      select: { peCode: true },\n    });\n    if (!programElement) throw new NotFoundException(`Program element ${peCode} not found`);\n\n    return this.prisma.withTenant(ctx.tenantId, async (tx) => {\n      if (watching) {\n        let inserted: Array<{ id: string }>;\n        try {\n          inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`\n            INSERT INTO program_element_watch (tenant_id, user_id, pe_code)\n            VALUES (${ctx.tenantId}::uuid, ${ctx.userId}::uuid, ${peCode})\n            ON CONFLICT (tenant_id, user_id, pe_code)\n            DO UPDATE SET pe_code = EXCLUDED.pe_code\n            RETURNING id\n          `);\n        } catch (error) {\n          if (isLegacyPeWatchConstraintConflict(error)) {\n            throw new ConflictException({\n              statusCode: 409,\n              code: 'PE_WATCH_TENANT_KEY_ROLLOUT_PENDING',\n              message:\n                'This watch cannot be added while the tenant-isolation rollout is in progress. No existing watch was changed.',\n            });\n          }\n          throw error;\n        }\n\n        const watchId = inserted[0]?.id ?? null;\n\n        await tx.auditLog.create({\n          data: {\n            tenantId: ctx.tenantId,\n            actorUserId: ctx.userId,\n            actorRole: ctx.role,\n            action: 'program_element.watch.set',\n            entityType: 'program_element_watch',\n            entityId: watchId,\n            after: { tenantId: ctx.tenantId, peCode, watching: true },\n          },\n        });\n\n        return { peCode, watching: true };\n      }\n\n      const removed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`\n        DELETE FROM program_element_watch\n        WHERE tenant_id = ${ctx.tenantId}::uuid\n          AND user_id = ${ctx.userId}::uuid\n          AND pe_code = ${peCode}\n        RETURNING id\n      `);\n\n      await tx.auditLog.create({\n        data: {\n          tenantId: ctx.tenantId,\n          actorUserId: ctx.userId,\n          actorRole: ctx.role,\n          action: 'program_element.watch.set',\n          entityType: 'program_element_watch',\n          entityId: removed[0]?.id ?? null,\n          after: { tenantId: ctx.tenantId, peCode, watching: false },\n        },\n      });\n\n      return { peCode, watching: false };\n    });\n  }\n'''
replace_once(service, old_set_watching, new_set_watching)

# ---------------------------------------------------------------------------
# c3 — pure, tenant-keyed alert aggregation. No SES client in tests.
# ---------------------------------------------------------------------------
helper = ROOT / "apps/api/src/program-element/pe-alerts/tenant-watch-aggregation.ts"
helper.write_text(
    '''export interface PeAlertWatchRow {\n  userId: string;\n  tenantId: string;\n  peCode: string;\n  email: string;\n}\n\nexport interface PeAlertPreferenceRow {\n  userId: string;\n  tenantId: string;\n  mode: string;\n}\n\nexport interface PeAlertCanary {\n  all: boolean;\n  ids: ReadonlySet<string>;\n}\n\nexport interface TenantScopedPeAlertAggregate {\n  key: string;\n  userId: string;\n  tenantId: string;\n  email: string;\n  watched: Set<string>;\n  mode: string;\n  enabled: boolean;\n  canaryEligible: boolean;\n}\n\n/**\n * Build one digest audience per tenant+user. The same user and PE in two tenants\n * must remain two independent aggregates, preferences and canary decisions.\n */\nexport function aggregateTenantScopedPeAlertWatches(\n  watches: readonly PeAlertWatchRow[],\n  preferences: readonly PeAlertPreferenceRow[],\n  canary: PeAlertCanary,\n): TenantScopedPeAlertAggregate[] {\n  const modeByKey = new Map(\n    preferences.map((pref) => [`${pref.tenantId}:${pref.userId}`, pref.mode] as const),\n  );\n  const aggregates = new Map<\n    string,\n    Omit<TenantScopedPeAlertAggregate, 'mode' | 'enabled' | 'canaryEligible'>\n  >();\n\n  for (const watch of watches) {\n    const key = `${watch.tenantId}:${watch.userId}`;\n    const aggregate = aggregates.get(key) ?? {\n      key,\n      userId: watch.userId,\n      tenantId: watch.tenantId,\n      email: watch.email,\n      watched: new Set<string>(),\n    };\n    aggregate.watched.add(watch.peCode);\n    aggregates.set(key, aggregate);\n  }\n\n  return [...aggregates.values()]\n    .map((aggregate) => {\n      const mode = modeByKey.get(aggregate.key) ?? 'daily';\n      return {\n        ...aggregate,\n        mode,\n        enabled: mode !== 'off',\n        canaryEligible: canary.all || canary.ids.has(aggregate.tenantId),\n      };\n    })\n    .sort((a, b) => a.key.localeCompare(b.key));\n}\n''',
    encoding="utf-8",
)

alert_script = ROOT / "apps/api/scripts/send-pe-alert-emails.ts"
replace_once(
    alert_script,
    "import {\n  lastSuccessfulWatermark,\n",
    "import { aggregateTenantScopedPeAlertWatches } from '../src/program-element/pe-alerts/tenant-watch-aggregation.js';\nimport {\n  lastSuccessfulWatermark,\n",
)
replace_once(
    alert_script,
    '''      const prefs = await tx.peAlertEmailPref.findMany({\n        select: { userId: true, tenantId: true, mode: true },\n      });\n      const prefByUser = new Map(prefs.map((p) => [`${p.tenantId}:${p.userId}`, p.mode]));\n\n      interface UserAgg {\n        tenantId: string;\n        email: string;\n        watched: Set<string>;\n      }\n      const users = new Map<string, UserAgg>();\n      for (const w of watches) {\n        const key = `${w.tenantId}:${w.userId}`;\n        const agg = users.get(key) ?? {\n          tenantId: w.tenantId,\n          email: w.user.email,\n          watched: new Set<string>(),\n        };\n        agg.watched.add(w.peCode);\n        users.set(key, agg);\n      }\n      summary.users_considered = users.size;\n\n      const queued: QueuedEmail[] = [];\n      for (const [key, agg] of users) {\n        const mode = prefByUser.get(key) ?? 'daily';\n        if (mode === 'off') continue;\n        if (!canary.all && !canary.ids.has(agg.tenantId)) continue;\n''',
    '''      const prefs = await tx.peAlertEmailPref.findMany({\n        select: { userId: true, tenantId: true, mode: true },\n      });\n      const users = aggregateTenantScopedPeAlertWatches(\n        watches.map((watch) => ({\n          userId: watch.userId,\n          tenantId: watch.tenantId,\n          peCode: watch.peCode,\n          email: watch.user.email,\n        })),\n        prefs,\n        canary,\n      );\n      summary.users_considered = users.length;\n\n      const queued: QueuedEmail[] = [];\n      for (const agg of users) {\n        if (!agg.enabled || !agg.canaryEligible) continue;\n''',
)

# ---------------------------------------------------------------------------
# Tests: behavior, migration/schema safety, and alert isolation.
# ---------------------------------------------------------------------------
watch_spec = ROOT / "apps/api/src/program-element/program-element-watch.tenant-isolation.spec.ts"
watch_spec.write_text(
    '''import { ConflictException } from '@nestjs/common';\nimport { describe, expect, jest, test } from '@jest/globals';\nimport type { TenantContext } from '@capiro/shared';\nimport { ProgramElementReadService } from './program-element-read.service.js';\n\nconst PE = '0603270A';\nconst USER = '00000000-0000-0000-0000-000000000002';\nconst TENANT_A = '00000000-0000-0000-0000-000000000001';\nconst TENANT_B = '00000000-0000-0000-0000-000000000003';\n\nconst ctx = (tenantId: string): TenantContext => ({\n  tenantId,\n  tenantSlug: tenantId === TENANT_A ? 'tenant-a' : 'tenant-b',\n  userId: USER,\n  clerkUserId: 'user_test',\n  role: 'standard_user',\n});\n\ninterface SqlSnapshot {\n  text: string;\n  values: unknown[];\n}\n\nfunction snapshot(query: unknown): SqlSnapshot {\n  const sql = query as { strings?: readonly string[]; values?: readonly unknown[] };\n  return {\n    text: [...(sql.strings ?? [])].join('?'),\n    values: [...(sql.values ?? [])],\n  };\n}\n\nfunction makePrisma(options: { legacyCollision?: boolean } = {}) {\n  const rows = new Map<string, string>();\n  const queries: SqlSnapshot[] = [];\n  const auditLogs: Array<Record<string, unknown>> = [];\n\n  const txQueryRaw = jest.fn(async (query: unknown) => {\n    const sql = snapshot(query);\n    queries.push(sql);\n    const tenantId = sql.values.find((value) => value === TENANT_A || value === TENANT_B) as\n      | string\n      | undefined;\n    const userId = sql.values.find((value) => value === USER) as string | undefined;\n    const peCode = sql.values.find((value) => value === PE) as string | undefined;\n    const key = tenantId && userId && peCode ? `${tenantId}:${userId}:${peCode}` : null;\n\n    if (/INSERT INTO program_element_watch/.test(sql.text)) {\n      if (options.legacyCollision) {\n        throw {\n          code: 'P2010',\n          meta: {\n            code: '23505',\n            message:\n              'duplicate key value violates unique constraint "program_element_watch_user_pe_code_key"',\n          },\n        };\n      }\n      if (!key) throw new Error('test SQL did not carry tenant/user/PE');\n      const id = rows.get(key) ?? `watch-${rows.size + 1}`;\n      rows.set(key, id);\n      return [{ id }];\n    }\n    if (/DELETE FROM program_element_watch/.test(sql.text)) {\n      if (!key) throw new Error('test SQL did not carry tenant/user/PE');\n      const id = rows.get(key);\n      rows.delete(key);\n      return id ? [{ id }] : [];\n    }\n    if (/SELECT id[\\s\\S]*FROM program_element_watch/.test(sql.text)) {\n      if (!key) throw new Error('test SQL did not carry tenant/user/PE');\n      const id = rows.get(key);\n      return id ? [{ id }] : [];\n    }\n    return [];\n  });\n\n  const prisma = {\n    __state: { rows, queries, auditLogs },\n    programElement: {\n      findUnique: jest.fn(async () => ({ peCode: PE })),\n    },\n    $queryRaw: jest.fn(async () => []),\n    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>\n      fn({\n        $queryRaw: txQueryRaw,\n        auditLog: {\n          create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {\n            auditLogs.push(data);\n            return data;\n          }),\n        },\n        programElementWatch: { findMany: jest.fn(async () => []) },\n        clientCapability: { findMany: jest.fn(async () => []) },\n      }),\n    ),\n  };\n  return prisma;\n}\n\nfunction makeService(prisma: ReturnType<typeof makePrisma>) {\n  const service = new ProgramElementReadService(\n    prisma as never,\n    { predict: jest.fn(async () => null) } as never,\n  );\n  (service as unknown as {\n    detailCache: { set: (key: string, value: Record<string, unknown>) => void };\n  }).detailCache.set(PE, { peCode: PE, title: 'Test PE' });\n  return service;\n}\n\ndescribe('ProgramElementWatch tenant isolation', () => {\n  test('same user and PE maintain independent tenant states; unwatch is tenant-local', async () => {\n    const prisma = makePrisma();\n    const service = makeService(prisma);\n\n    await service.setWatching(PE, true, ctx(TENANT_A));\n    await service.setWatching(PE, true, ctx(TENANT_B));\n    expect(prisma.__state.rows.size).toBe(2);\n\n    expect((await service.getProgramElement(PE, ctx(TENANT_A))).currentUserIsWatching).toBe(true);\n    expect((await service.getProgramElement(PE, ctx(TENANT_B))).currentUserIsWatching).toBe(true);\n\n    await service.setWatching(PE, false, ctx(TENANT_A));\n    expect((await service.getProgramElement(PE, ctx(TENANT_A))).currentUserIsWatching).toBe(false);\n    expect((await service.getProgramElement(PE, ctx(TENANT_B))).currentUserIsWatching).toBe(true);\n\n    const inserts = prisma.__state.queries.filter((query) =>\n      query.text.includes('INSERT INTO program_element_watch'),\n    );\n    expect(inserts).toHaveLength(2);\n    for (const insert of inserts) {\n      expect(insert.text).toContain('ON CONFLICT (tenant_id, user_id, pe_code)');\n      expect(insert.text).not.toContain('DO UPDATE SET tenant_id');\n    }\n    const deletes = prisma.__state.queries.filter((query) =>\n      query.text.includes('DELETE FROM program_element_watch'),\n    );\n    expect(deletes[0]?.text).toMatch(/WHERE tenant_id = .*AND user_id = .*AND pe_code =/s);\n\n    expect(prisma.__state.auditLogs.map((entry) => entry.tenantId)).toEqual([\n      TENANT_A,\n      TENANT_B,\n      TENANT_A,\n    ]);\n    expect(\n      prisma.__state.auditLogs.map((entry) => (entry.after as { tenantId?: string }).tenantId),\n    ).toEqual([TENANT_A, TENANT_B, TENANT_A]);\n  });\n\n  test('detail and watched-only finder carry explicit tenant and user predicates', async () => {\n    const prisma = makePrisma();\n    const service = makeService(prisma);\n\n    await service.getProgramElement(PE, ctx(TENANT_A));\n    await service.listProgramElements({ watched: 'true' }, ctx(TENANT_A));\n\n    const detail = prisma.__state.queries.find((query) =>\n      /SELECT id[\\s\\S]*FROM program_element_watch/.test(query.text),\n    );\n    expect(detail?.text).toMatch(/WHERE tenant_id = .*AND user_id = .*AND pe_code =/s);\n    expect(detail?.values).toEqual(expect.arrayContaining([TENANT_A, USER, PE]));\n\n    const finder = prisma.__state.queries.find((query) => query.text.includes('pw.tenant_id'));
    expect(finder?.text).toContain('pw.tenant_id =');\n    expect(finder?.text).toContain('pw.user_id =');\n    expect(finder?.values).toEqual(expect.arrayContaining([TENANT_A, USER]));\n  });\n\n  test('legacy-key collision fails closed without moving a row or writing an audit event', async () => {\n    const prisma = makePrisma({ legacyCollision: true });\n    const service = makeService(prisma);\n\n    const promise = service.setWatching(PE, true, ctx(TENANT_B));\n    await expect(promise).rejects.toBeInstanceOf(ConflictException);\n    await expect(promise).rejects.toMatchObject({\n      response: expect.objectContaining({ code: 'PE_WATCH_TENANT_KEY_ROLLOUT_PENDING' }),\n    });\n    expect(prisma.__state.rows.size).toBe(0);\n    expect(prisma.__state.auditLogs).toHaveLength(0);\n  });\n});\n''',
    encoding="utf-8",
)

alert_spec = ROOT / "apps/api/scripts/send-pe-alert-emails.watch-isolation.spec.ts"
alert_spec.write_text(
    '''import { describe, expect, test } from '@jest/globals';\nimport { aggregateTenantScopedPeAlertWatches } from '../src/program-element/pe-alerts/tenant-watch-aggregation.js';\n\nconst USER = 'user-1';\nconst PE = '0603270A';\nconst A = 'tenant-a';\nconst B = 'tenant-b';\n\ndescribe('send-pe-alert-emails tenant watch aggregation', () => {\n  const watches = [\n    { userId: USER, tenantId: A, peCode: PE, email: 'user@example.com' },\n    { userId: USER, tenantId: B, peCode: PE, email: 'user@example.com' },\n  ];\n\n  test('same user and PE in two tenants creates two independent aggregates', () => {\n    const result = aggregateTenantScopedPeAlertWatches(watches, [], {\n      all: true,\n      ids: new Set(),\n    });\n\n    expect(result).toHaveLength(2);\n    expect(result.map((row) => row.key)).toEqual([`${A}:${USER}`, `${B}:${USER}`]);\n    expect(result.every((row) => row.watched.has(PE))).toBe(true);\n  });\n\n  test('canary eligibility is evaluated per tenant', () => {\n    const result = aggregateTenantScopedPeAlertWatches(watches, [], {\n      all: false,\n      ids: new Set([B]),\n    });\n    const byTenant = new Map(result.map((row) => [row.tenantId, row]));\n\n    expect(byTenant.get(A)?.canaryEligible).toBe(false);\n    expect(byTenant.get(B)?.canaryEligible).toBe(true);\n  });\n\n  test('off preference in tenant A does not disable tenant B', () => {\n    const result = aggregateTenantScopedPeAlertWatches(\n      watches,\n      [\n        { userId: USER, tenantId: A, mode: 'off' },\n        { userId: USER, tenantId: B, mode: 'daily' },\n      ],\n      { all: true, ids: new Set() },\n    );\n    const byTenant = new Map(result.map((row) => [row.tenantId, row]));\n\n    expect(byTenant.get(A)?.enabled).toBe(false);\n    expect(byTenant.get(B)?.enabled).toBe(true);\n  });\n});\n''',
    encoding="utf-8",
)

migration_spec = ROOT / "apps/api/scripts/lib/pe-watch-tenant-isolation.spec.ts"
migration_spec.write_text(
    '''import { readFileSync, readdirSync, statSync } from 'node:fs';\nimport { resolve } from 'node:path';\nimport { describe, expect, test } from '@jest/globals';\n\nfunction apiRoot(): string {\n  const cwd = process.cwd();\n  return cwd.replace(/\\\\/g, '/').endsWith('/apps/api') ? cwd : resolve(cwd, 'apps/api');\n}\n\nfunction apiFile(path: string): string {\n  return readFileSync(resolve(apiRoot(), path), 'utf8');\n}\n\nfunction migrationSql(): string {\n  const root = resolve(apiRoot(), 'prisma/migrations');\n  const files: string[] = [];\n  const walk = (dir: string): void => {\n    for (const name of readdirSync(dir)) {\n      const path = resolve(dir, name);\n      if (statSync(path).isDirectory()) walk(path);\n      else if (name === 'migration.sql') files.push(path);\n    }\n  };\n  walk(root);\n  return files.map((path) => readFileSync(path, 'utf8')).join('\n');\n}\n\ndescribe('Phase C PE-watch expand/contract safety', () => {\n  test('schema keeps legacy and tenant-aware keys during the expand/code-switch release', () => {\n    const schema = apiFile('prisma/schema.prisma');\n    expect(schema).toContain(\n      '@@unique([userId, peCode], map: "program_element_watch_user_pe_code_key")',\n    );\n    expect(schema).toContain(\n      '@@unique([tenantId, userId, peCode], map: "program_element_watch_tenant_user_pe_code_key")',\n    );\n  });\n\n  test('expansion migration aborts duplicates, adds only the new key, and never weakens RLS', () => {\n    const sql = apiFile(\n      'prisma/migrations/20260728230000_add_tenant_scoped_pe_watch_key/migration.sql',\n    );\n    expect(sql).toMatch(/GROUP BY "tenant_id", "user_id", "pe_code"/);\n    expect(sql).toMatch(/HAVING COUNT\(\*\) > 1/);\n    expect(sql).toContain('program_element_watch_tenant_user_pe_code_key');\n    expect(sql).toMatch(/CREATE UNIQUE INDEX/);\n    expect(sql).not.toMatch(/DROP (INDEX|CONSTRAINT)/i);\n    expect(sql).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);\n  });\n\n  test('all application watch paths use explicit tenant predicates and never move tenant_id', () => {\n    const source = apiFile('src/program-element/program-element-read.service.ts');\n    expect(source).toContain('pw.tenant_id = ${tenantId}::uuid');\n    expect(source).toContain('WHERE tenant_id = ${ctx.tenantId}::uuid');\n    expect(source).toContain(\n      'where: { tenantId: ctx.tenantId, peCode: { in: peCodes } }',\n    );\n    expect(source).toContain('ON CONFLICT (tenant_id, user_id, pe_code)');\n    expect(source).not.toContain('DO UPDATE SET tenant_id = EXCLUDED.tenant_id');\n    expect(source).toMatch(\n      /DELETE FROM program_element_watch[\\s\\S]*WHERE tenant_id = \$\{ctx\.tenantId\}::uuid[\\s\\S]*AND user_id = \$\{ctx\.userId\}::uuid[\\s\\S]*AND pe_code = \$\{peCode\}/,\n    );\n  });\n\n  test('existing migrations still enable and force tenant RLS for the watch table', () => {\n    const sql = migrationSql();\n    expect(sql).toMatch(\n      /ALTER TABLE\s+"?program_element_watch"?\s+ENABLE ROW LEVEL SECURITY/i,\n    );\n    expect(sql).toMatch(\n      /ALTER TABLE\s+"?program_element_watch"?\s+FORCE ROW LEVEL SECURITY/i,\n    );\n    expect(sql).toMatch(/CREATE POLICY[\\s\\S]{0,800}program_element_watch/i);\n  });\n});\n''',
    encoding="utf-8",
)

runbook = ROOT / "docs/runbooks/program-element-watch-tenant-isolation-rollout.md"
runbook.parent.mkdir(parents=True, exist_ok=True)
runbook.write_text(
    '''# Program Element Watch Tenant-Isolation Rollout\n\n## Purpose\n\nMove `program_element_watch` from the legacy `(user_id, pe_code)` identity to\n`(tenant_id, user_id, pe_code)` without moving rows between tenants or making an\nold-container rollback unsafe.\n\n## Release 1 — Expand schema\n\n1. Run the duplicate preflight from\n   `20260728230000_add_tenant_scoped_pe_watch_key/migration.sql`.\n2. Apply the migration. It adds `program_element_watch_tenant_user_pe_code_key`.\n3. Confirm `program_element_watch_user_pe_code_key` still exists.\n4. Confirm the table still has RLS enabled and forced.\n\nNo application behavior changes are required before this release.\n\n## Release 2 — Switch code\n\nDeploy the Phase C API and sync-job image. The code:\n\n- reads watches with explicit tenant, user and PE predicates;\n- inserts against `(tenant_id, user_id, pe_code)`;\n- never updates `tenant_id` to resolve a conflict;\n- deletes with tenant, user and PE predicates;\n- groups alert recipients by `tenantId:userId`; and\n- writes the mutated tenant into the audit record.\n\nWhile the legacy unique key still exists, adding the same user+PE in a second\ntenant is expected to return `409 PE_WATCH_TENANT_KEY_ROLLOUT_PENDING`. That is\na safe temporary state: no existing row is moved or disclosed.\n\nDo not continue until every running API, worker and scheduled sync task uses the\nnew image SHA.\n\n## Release 3 — Contract schema (separate PR/migration)\n\nOnly after the Release 2 live smoke gate:\n\n1. Remove the legacy Prisma declaration\n   `@@unique([userId, peCode], map: "program_element_watch_user_pe_code_key")`.\n2. Add a new migration that drops only\n   `program_element_watch_user_pe_code_key`.\n3. Apply it in a disposable database and staging first.\n4. Verify one user can hold the same PE watch in two tenants.\n5. Verify unwatching tenant A leaves tenant B unchanged.\n6. Verify alert preferences and canary eligibility remain tenant-local.\n\nThis Phase C implementation PR intentionally does **not** include the contract\nmigration, because `prisma migrate deploy` would otherwise apply expand and\ncontract together and eliminate the rollback window.\n\n## Rollback\n\n- Before Release 3, old application code can be restored because both keys exist.\n- After Release 3, old application code is unsafe. Recreate the legacy key before\n  rollback or roll forward with tenant-aware code.\n\n## Prohibited operations\n\n- Never rewrite `tenant_id` to resolve a duplicate.\n- Never delete by user+PE without tenant.\n- Never disable or bypass RLS for interactive API paths.\n- Never drop the legacy key until all old containers are gone.\n''',
    encoding="utf-8",
)

# Targeted verification command and script typecheck coverage.
package_path = ROOT / "apps/api/package.json"
package_json = json.loads(package_path.read_text(encoding="utf-8"))
package_json["scripts"]["verify:pe-phase-c"] = (
    "jest --runInBand --detectOpenHandles --forceExit "
    "src/program-element/program-element-read.service.spec.ts "
    "src/program-element/program-element-watch.tenant-isolation.spec.ts "
    "scripts/send-pe-alert-emails.watch-isolation.spec.ts "
    "scripts/lib/pe-watch-tenant-isolation.spec.ts"
)
package_path.write_text(json.dumps(package_json, indent=2) + "\n", encoding="utf-8")

tsconfig_path = ROOT / "apps/api/tsconfig.pe-phase-a.json"
tsconfig = json.loads(tsconfig_path.read_text(encoding="utf-8"))
for include in [
    "scripts/send-pe-alert-emails.ts",
    "scripts/send-pe-alert-emails.watch-isolation.spec.ts",
    "scripts/lib/pe-watch-tenant-isolation.spec.ts",
    "src/program-element/pe-alerts/tenant-watch-aggregation.ts",
]:
    if include not in tsconfig["include"]:
        tsconfig["include"].append(include)
tsconfig_path.write_text(json.dumps(tsconfig, indent=2) + "\n", encoding="utf-8")

print("PHASE_C_PATCH_APPLIED")
