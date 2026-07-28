import fs from 'node:fs';

const file = 'apps/api/src/meri/meri.service.ts';
let source = fs.readFileSync(file, 'utf8');
function replaceOnce(search, replacement) {
  if (!source.includes(search)) throw new Error(`Legacy memory anchor not found: ${search.slice(0, 180)}`);
  source = source.replace(search, replacement);
}

replaceOnce(
  `        select: { id: true, scope: true, ownerUserId: true, key: true, value: true },\n      });\n      if (!row) throw new NotFoundException('Memory not found');\n      if (row.scope === 'user_private' && row.ownerUserId !== ctx.userId) {\n        throw new NotFoundException('Memory not found');\n      }\n      const held = await tx.$queryRaw<Array<{ legal_hold: boolean }>>\`\n`,
  `        select: {\n          id: true,\n          scope: true,\n          ownerUserId: true,\n          clientId: true,\n          key: true,\n          value: true,\n        },\n      });\n      if (!row) throw new NotFoundException('Memory not found');\n      const held = await tx.$queryRaw<Array<{ legal_hold: boolean }>>\`\n`,
);
replaceOnce(
  `      if (held[0]?.legal_hold) {\n        throw new ForbiddenException('This memory is under legal hold and cannot be deleted.');\n      }\n      await tx.clioMemory.deleteMany({ where: { id: memoryId, tenantId: ctx.tenantId } });\n`,
  `      const decision = evaluateMemoryMutation(\n        ctx,\n        {\n          scope: row.scope,\n          ownerUserId: row.ownerUserId,\n          clientId: row.clientId,\n          legalHold: held[0]?.legal_hold ?? false,\n        },\n        'forget',\n      );\n      if (!decision.allowed) {\n        if (decision.reason === 'legal_hold') {\n          throw new ForbiddenException('This memory is under legal hold and cannot be deleted.');\n        }\n        throw new NotFoundException('Memory not found');\n      }\n      await tx.clioMemory.deleteMany({\n        where: {\n          id: memoryId,\n          tenantId: ctx.tenantId,\n          scope: row.scope,\n          ownerUserId: row.ownerUserId,\n        },\n      });\n`,
);
replaceOnce(
  `          scope: true,\n          ownerUserId: true,\n          key: true,\n          value: true,\n          metadata: true,\n`,
  `          scope: true,\n          ownerUserId: true,\n          clientId: true,\n          key: true,\n          value: true,\n          metadata: true,\n`,
);
replaceOnce(
  `      if (!row) throw new NotFoundException('Memory not found');\n      if (row.scope === 'user_private' && row.ownerUserId !== ctx.userId) {\n        throw new NotFoundException('Memory not found');\n      }\n      const held = await tx.$queryRaw<Array<{ legal_hold: boolean }>>\`\n`,
  `      if (!row) throw new NotFoundException('Memory not found');\n      const held = await tx.$queryRaw<Array<{ legal_hold: boolean }>>\`\n`,
);
replaceOnce(
  `      if (held[0]?.legal_hold) {\n        throw new ForbiddenException('This memory is under legal hold and cannot be edited.');\n      }\n      const meta =\n`,
  `      const decision = evaluateMemoryMutation(\n        ctx,\n        {\n          scope: row.scope,\n          ownerUserId: row.ownerUserId,\n          clientId: row.clientId,\n          legalHold: held[0]?.legal_hold ?? false,\n        },\n        'edit',\n      );\n      if (!decision.allowed) {\n        if (decision.reason === 'legal_hold') {\n          throw new ForbiddenException('This memory is under legal hold and cannot be edited.');\n        }\n        throw new NotFoundException('Memory not found');\n      }\n      const meta =\n`,
);
replaceOnce(
  `        where: { id: memoryId, tenantId: ctx.tenantId },\n        data: {\n          value: next,\n`,
  `        where: {\n          id: memoryId,\n          tenantId: ctx.tenantId,\n          scope: row.scope,\n          ownerUserId: row.ownerUserId,\n        },\n        data: {\n          value: next,\n`,
);

fs.writeFileSync(file, source);
console.log('Legacy clio-memory mutation authorization applied.');
