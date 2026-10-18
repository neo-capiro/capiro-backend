import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script, createContext } from 'node:vm';
import ts from 'typescript';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { authorizeResearchPortfolioConversation } from '../research-portfolios/research-portfolio-artifact-authority.js';
import { assertCurrentClientVisible, loadOwnedActiveClioConversation } from './application-authority-resource.helpers.js';

const root = resolve(__dirname, '../../../..');
const baseline = 'a65ae3c8a9f1f0cf96d4f7d2ae30aad2fff172ff';
const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' } as TenantContext;
const clientId = '33333333-3333-4333-8333-333333333333';
const conversationId = '44444444-4444-4444-8444-444444444444';
const oldSource = execFileSync('git', ['show', `${baseline}:apps/api/src/meri/meri.service.ts`], { cwd: root, maxBuffer: 8 * 1024 * 1024 }).toString();
const newSource = readFileSync(resolve(root, 'apps/api/src/meri/meri.service.ts'), 'utf8');
function members(source: string, className: string) {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  const owner = file.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === className)!;
  return { file, owner, methods: new Map(owner.members.filter(ts.isMethodDeclaration).map((m) => [m.name.getText(file), m.getText(file)])) };
}
const old = members(oldSource, 'MeriService');
const current = members(newSource, 'MeriService');
function queryOwner(methods: Map<string, string>) {
  const source = `import { NotFoundException } from '@nestjs/common';
    import { authorizeResearchPortfolioConversation } from './portfolio';
    import { loadOwnedActiveClioConversation, assertCurrentClientVisible } from './resources';
    export class Owner { ${['ensureConversation', 'ensureClientVisible'].map((name) => methods.get(name)).join('\n')} }`;
  const module = { exports: {} as any };
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Script(js).runInContext(createContext({ module, exports: module.exports, require(id: string) {
    if (id === '@nestjs/common') return { NotFoundException };
    if (id === './portfolio') return { authorizeResearchPortfolioConversation };
    if (id === './resources') return { loadOwnedActiveClioConversation, assertCurrentClientVisible };
    throw new Error(`Unexpected runtime port ${id}`);
  } }));
  return new module.exports.Owner();
}

function fixture(scenario: string) {
  const events: any[] = [];
  const row: any = { id: conversationId, tenantId: ctx.tenantId, userId: ctx.userId, clientId, archivedAt: null, metadata: {} };
  const client: any = { id: clientId, tenantId: ctx.tenantId, status: 'active' };
  if (scenario === 'foreign tenant') row.tenantId = clientId;
  if (scenario === 'foreign owner') row.userId = clientId;
  if (scenario === 'archived') row.archivedAt = new Date(1);
  if (scenario === 'archived client') client.status = 'archived';
  if (scenario.startsWith('portfolio')) {
    row.clientId = null;
    const bounded = { kind: 'research_portfolio', researchPortfolioId: conversationId, researchPortfolioName: 'Synthetic', researchPortfolioRevision: 1 };
    row.metadata.researchPortfolioScope = { ...bounded, scopeVersion: createHash('sha256').update(JSON.stringify(bounded)).digest('hex') };
    if (scenario === 'portfolio forged receipt') row.metadata.researchPortfolioScope.scopeVersion = 'a'.repeat(64);
    if (scenario === 'portfolio client mismatch') row.clientId = clientId;
  }
  const tx = {
    clioConversation: { findFirst: async (args: any) => {
      events.push(['conversation', args]);
      if (scenario === 'infrastructure failure') throw new Error('synthetic DB failure');
      return scenario !== 'missing' && Object.entries(args.where).every(([key, value]) => row[key] === value) ? row : null;
    } },
    client: { findFirst: async (args: any) => {
      events.push(['client', args]);
      return scenario !== 'missing client' && client.id === args.where.id && client.tenantId === args.where.tenantId && client.status !== args.where.status.not ? { id: client.id } : null;
    } },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { events.push(['lock', strings.join('?'), values]); return 0; },
    tenantMembership: { findFirst: async (args: any) => { events.push(['membership', args]); return scenario === 'portfolio member revoked' ? null : { id: 'member' }; } },
    researchPortfolio: { findFirst: async (args: any) => { events.push(['portfolio', args]); return scenario === 'portfolio grant revoked' ? null : { id: conversationId, grants: [{ role: 'viewer' }], clientLinks: [] }; } },
  };
  const prisma = { withTenant: async (id: string, fn: any) => {
    events.push(['tenant', id]); expect(id).toBe(ctx.tenantId);
    try { const value = await fn(tx); events.push(['commit']); return value; }
    catch (error) { events.push(['rollback']); throw error; }
  } };
  return { events, prisma };
}
async function result(fn: () => Promise<unknown>) {
  try { return { value: await fn() }; }
  catch (error) { return { error: { name: (error as Error).name, message: (error as Error).message, status: (error as any).getStatus?.() } }; }
}

describe('frozen original resource behavior and retained legacy delegates', () => {
  it.each(['owned', 'missing', 'foreign tenant', 'foreign owner', 'archived', 'infrastructure failure',
    'portfolio allowed', 'portfolio forged receipt', 'portfolio client mismatch', 'portfolio member revoked', 'portfolio grant revoked'])
  ('preserves original tenant query, portfolio checks, result/error and transaction order: %s', async (scenario) => {
    const before = fixture(scenario); const after = fixture(scenario); const delegated = fixture(scenario);
    const original = queryOwner(old.methods); original.prisma = before.prisma;
    const remaining = queryOwner(current.methods); remaining.prisma = delegated.prisma;
    const expected = await result(() => original.ensureConversation(ctx, conversationId));
    expect(await result(() => loadOwnedActiveClioConversation(after.prisma as any, ctx, conversationId))).toEqual(expected);
    expect(await result(() => remaining.ensureConversation(ctx, conversationId))).toEqual(expected);
    expect(after.events).toEqual(before.events); expect(delegated.events).toEqual(before.events);
    expect(before.events[1]).toEqual(['conversation', { where: { id: conversationId, tenantId: ctx.tenantId, userId: ctx.userId, archivedAt: null }, include: { client: { select: { id: true, name: true } } } }]);
  });

  it.each(['owned', 'missing client', 'archived client'])('preserves exact client visibility and legacy404: %s', async (scenario) => {
    const before = fixture(scenario); const after = fixture(scenario); const delegated = fixture(scenario);
    const original = queryOwner(old.methods); original.prisma = before.prisma;
    const remaining = queryOwner(current.methods); remaining.prisma = delegated.prisma;
    const expected = await result(() => original.ensureClientVisible(ctx, clientId));
    expect(await result(() => assertCurrentClientVisible(after.prisma as any, ctx, clientId))).toEqual(expected);
    expect(await result(() => remaining.ensureClientVisible(ctx, clientId))).toEqual(expected);
    expect(after.events).toEqual(before.events); expect(delegated.events).toEqual(before.events);
    expect(before.events[1]).toEqual(['client', { where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } }, select: { id: true } }]);
  });

  it('preserves every other complete Meri method and original positional constructor arguments', () => {
    const moved = new Set(['applicationAuthorityIdentity', 'applicationAuthorityContext', 'ensureConversation', 'ensureClientVisible']);
    for (const [name, body] of old.methods) if (!moved.has(name)) expect(current.methods.get(name)).toBe(body);
    expect([...current.methods.keys()].sort()).toEqual([...old.methods.keys()].filter((name) => !name.startsWith('applicationAuthority')).sort());
    const original = old.owner.members.find(ts.isConstructorDeclaration)!;
    const remaining = current.owner.members.find(ts.isConstructorDeclaration)!;
    expect(original.parameters.slice(-2).map((p) => p.name.getText(old.file))).toEqual(['applicationAuthorityTenant', 'applicationAuthorityScope']);
    expect(remaining.parameters.map((p) => p.getText(current.file))).toEqual(original.parameters.slice(0, -2).map((p) => p.getText(old.file)));
    const controllerBefore = members(execFileSync('git', ['show', `${baseline}:apps/api/src/meri/meri.controller.ts`], { cwd: root }).toString(), 'MeriController');
    const controllerAfter = members(readFileSync(resolve(root, 'apps/api/src/meri/meri.controller.ts'), 'utf8'), 'MeriController');
    for (const [name, body] of controllerBefore.methods) if (!name.startsWith('applicationAuthority')) expect(controllerAfter.methods.get(name)).toBe(body);
    expect([...controllerAfter.methods.keys()].sort()).toEqual([...controllerBefore.methods.keys()].filter((name) => !name.startsWith('applicationAuthority')).sort());
  });
});
