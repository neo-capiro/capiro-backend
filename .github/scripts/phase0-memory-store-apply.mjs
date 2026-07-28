import fs from 'node:fs';

const file = 'apps/api/src/memory/memory-store.service.ts';
let source = fs.readFileSync(file, 'utf8');

function replaceOnce(search, replacement) {
  if (!source.includes(search)) {
    throw new Error(`Expected MemoryStoreService anchor not found: ${search.slice(0, 180)}`);
  }
  source = source.replace(search, replacement);
}

replaceOnce(
  `import {\n  clientMemoryAllowed,\n  fetchDeniedClientIds,\n  wallExclusionSql,\n} from './memory-wall.helpers.js';\n`,
  `import {\n  clientMemoryAllowed,\n  fetchDeniedClientIds,\n  wallExclusionSql,\n} from './memory-wall.helpers.js';\nimport { evaluateMemoryMutation } from './memory-mutation-auth.js';\n`,
);

replaceOnce(
  `  /** confirm: re-affirm an item is still true (blueprint §3.5 "Confirm"). */\n  async confirmMemory(itemId: string): Promise<MemoryVerbResult> {\n    const ctx = this.tenantCtx.require();\n    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {\n      const rows = await tx.$queryRaw<Array<{ title: string }>>\`\n        SELECT title FROM memory_items\n        WHERE id = \${itemId}::uuid AND tenant_id = \${ctx.tenantId}::uuid\n          AND (visibility = 'tenant' OR owner_user_id = \${ctx.userId}::uuid)\n          AND status <> 'revoked'\n        LIMIT 1\n      \`;\n      if (!rows[0]) return { found: false };\n      await tx.$executeRaw\`\n        UPDATE memory_items SET last_confirmed_at = now(), updated_at = now()\n        WHERE id = \${itemId}::uuid\n      \`;\n      return { found: true, title: rows[0].title };\n    });\n  }\n`,
  `  /** confirm: re-affirm an item is still true (blueprint §3.5 "Confirm"). */\n  async confirmMemory(itemId: string): Promise<MemoryVerbResult> {\n    const ctx = this.tenantCtx.require();\n    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {\n      const rows = await tx.$queryRaw<\n        Array<{\n          title: string;\n          visibility: string;\n          owner_user_id: string | null;\n          client_id: string | null;\n          status: string;\n          legal_hold: boolean;\n        }>\n      >\`\n        SELECT title, visibility, owner_user_id, client_id, status, legal_hold\n        FROM memory_items\n        WHERE id = \${itemId}::uuid AND tenant_id = \${ctx.tenantId}::uuid\n          AND status <> 'revoked'\n        LIMIT 1\n      \`;\n      const row = rows[0];\n      if (!row) return { found: false };\n      const decision = evaluateMemoryMutation(\n        ctx,\n        {\n          visibility: row.visibility,\n          ownerUserId: row.owner_user_id,\n          clientId: row.client_id,\n          status: row.status,\n          legalHold: row.legal_hold,\n        },\n        'confirm',\n      );\n      if (!decision.allowed) return { found: false };\n      await tx.$executeRaw\`\n        UPDATE memory_items SET last_confirmed_at = now(), updated_at = now()\n        WHERE id = \${itemId}::uuid AND tenant_id = \${ctx.tenantId}::uuid AND status <> 'revoked'\n      \`;\n      return { found: true, title: row.title };\n    });\n  }\n`,
);

replaceOnce(
  `      const rows = await tx.$queryRaw<Array<{ title: string; slug: string; legal_hold: boolean }>>\`\n        SELECT title, slug, legal_hold FROM memory_items\n        WHERE id = \${itemId}::uuid AND tenant_id = \${ctx.tenantId}::uuid\n          AND (visibility = 'tenant' OR owner_user_id = \${ctx.userId}::uuid)\n          AND status <> 'revoked'\n        LIMIT 1\n      \`;\n      const row = rows[0];\n      if (!row) return { found: false };\n      if (row.legal_hold) return { found: true, blockedByLegalHold: true, title: row.title };\n\n      await tx.$executeRaw\`\n        UPDATE memory_items\n        SET status = 'revoked', revoked_at = now(), revoked_by = \${ctx.userId}::uuid, updated_at = now()\n        WHERE id = \${itemId}::uuid\n      \`;\n`,
  `      const rows = await tx.$queryRaw<\n        Array<{\n          title: string;\n          slug: string;\n          visibility: string;\n          owner_user_id: string | null;\n          client_id: string | null;\n          status: string;\n          legal_hold: boolean;\n        }>\n      >\`\n        SELECT title, slug, visibility, owner_user_id, client_id, status, legal_hold\n        FROM memory_items\n        WHERE id = \${itemId}::uuid AND tenant_id = \${ctx.tenantId}::uuid\n          AND status <> 'revoked'\n        LIMIT 1\n      \`;\n      const row = rows[0];\n      if (!row) return { found: false };\n      const decision = evaluateMemoryMutation(\n        ctx,\n        {\n          visibility: row.visibility,\n          ownerUserId: row.owner_user_id,\n          clientId: row.client_id,\n          status: row.status,\n          legalHold: row.legal_hold,\n        },\n        'forget',\n      );\n      if (!decision.allowed) {\n        return decision.reason === 'legal_hold'\n          ? { found: true, blockedByLegalHold: true, title: row.title }\n          : { found: false };\n      }\n\n      await tx.$executeRaw\`\n        UPDATE memory_items\n        SET status = 'revoked', revoked_at = now(), revoked_by = \${ctx.userId}::uuid, updated_at = now()\n        WHERE id = \${itemId}::uuid AND tenant_id = \${ctx.tenantId}::uuid AND status <> 'revoked'\n      \`;\n`,
);

replaceOnce(
  `          legal_hold: boolean;\n        }>\n      >\`\n        SELECT type, slug, title, client_id, owner_user_id, visibility, entity_id, tags, legal_hold\n        FROM memory_items\n        WHERE id = \${itemId}::uuid AND tenant_id = \${ctx.tenantId}::uuid\n          AND (visibility = 'tenant' OR owner_user_id = \${ctx.userId}::uuid)\n          AND status <> 'revoked'\n        LIMIT 1\n      \`;\n      const old = rows[0];\n      if (!old) return { found: false as const };\n      if (old.legal_hold)\n        return { found: true as const, blockedByLegalHold: true, title: old.title };\n`,
  `          legal_hold: boolean;\n          status: string;\n        }>\n      >\`\n        SELECT type, slug, title, client_id, owner_user_id, visibility, entity_id, tags, legal_hold, status\n        FROM memory_items\n        WHERE id = \${itemId}::uuid AND tenant_id = \${ctx.tenantId}::uuid\n          AND status <> 'revoked'\n        LIMIT 1\n      \`;\n      const old = rows[0];\n      if (!old) return { found: false as const };\n      const decision = evaluateMemoryMutation(\n        ctx,\n        {\n          visibility: old.visibility,\n          ownerUserId: old.owner_user_id,\n          clientId: old.client_id,\n          status: old.status,\n          legalHold: old.legal_hold,\n        },\n        'correct',\n      );\n      if (!decision.allowed) {\n        return decision.reason === 'legal_hold'\n          ? { found: true as const, blockedByLegalHold: true, title: old.title }\n          : { found: false as const };\n      }\n`,
);

replaceOnce(
  `        UPDATE memory_items SET status = 'superseded', updated_at = now() WHERE id = \${itemId}::uuid\n`,
  `        UPDATE memory_items SET status = 'superseded', updated_at = now()\n        WHERE id = \${itemId}::uuid AND tenant_id = \${ctx.tenantId}::uuid AND status <> 'revoked'\n`,
);

fs.writeFileSync(file, source);
console.log('MemoryStoreService mutation authorization applied.');
