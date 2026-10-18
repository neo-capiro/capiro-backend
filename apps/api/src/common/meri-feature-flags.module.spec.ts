import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script, createContext } from 'node:vm';
import ts from 'typescript';
import { MeriFeatureFlagsModule } from './meri-feature-flags.module.js';
import { MeriFeatureFlagsService } from '../meri/meri-feature-flags.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriV3AdminService } from '../capiro-admin/meriv3-admin.service.js';
import * as flagRules from './tenant-flags.js';
import * as nest from '@nestjs/common';
import { MERIV3_CHAT_FLAG } from './meriv3-flags.js';

const root = resolve(__dirname, '../../../..');
const baseline = '1f2655fe964cb2a01343d3bcb560de60fa5f69be';
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');
const original = (path: string) => execFileSync('git', ['show', `${baseline}:${path}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 }).toString();

// These fixture facades exercise real Nest shared-import/reexport behavior.
// They do not replace or qualify the full Meri/Mobile/Admin feature modules.
@Module({ imports: [MeriFeatureFlagsModule], exports: [MeriFeatureFlagsModule] })
class RuntimeFlagFacade {}
@Module({ imports: [MeriFeatureFlagsModule], exports: [MeriFeatureFlagsModule] })
class MobileFlagFacade {}

function v2Writer(prisma: unknown, flags: MeriFeatureFlagsService) {
  const text = source('apps/api/src/capiro-admin/capiro-admin.service.ts');
  const file = ts.createSourceFile('admin.ts', text, ts.ScriptTarget.Latest, true);
  const owner = file.statements.find((n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === 'CapiroAdminService')!;
  const method = owner.members.find((n) => ts.isMethodDeclaration(n) && n.name.getText(file) === 'setMeriV2Flag')!.getText(file);
  const js = ts.transpileModule(`import { BadRequestException, NotFoundException } from '@nestjs/common';
    import { adminSettableMeriFlags } from './rules'; export class Writer { ${method} }`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as any };
  new Script(js).runInContext(createContext({ module, exports: module.exports,
    require(id: string) { if (id === '@nestjs/common') return nest; if (id === './rules') return flagRules; throw Error(`Unexpected port ${id}`); } }));
  const writer = new module.exports.Writer();
  writer.prisma = prisma; writer.meriFlags = flags; writer.logger = { log() {} };
  return writer;
}

describe('canonical tenant feature-flag provider and preserved consumers', () => {
  it('constructs one real cache across direct imports/reexports without any runtime provider', async () => {
    const prisma = { withTenant: jest.fn() };
    const module = await Test.createTestingModule({ imports: [MeriFeatureFlagsModule, RuntimeFlagFacade, MobileFlagFacade], providers: [MeriV3AdminService] })
      .overrideProvider(PrismaService).useValue(prisma).compile();
    await module.init();
    const flags = module.get(MeriFeatureFlagsService);
    expect(module.select(MeriFeatureFlagsModule).get(MeriFeatureFlagsService, { strict: true })).toBe(flags);
    expect(module.select(RuntimeFlagFacade).get(MeriFeatureFlagsService)).toBe(flags);
    expect(module.select(MobileFlagFacade).get(MeriFeatureFlagsService)).toBe(flags);
    expect((module.get(MeriV3AdminService) as any).flags).toBe(flags);
    const entries = [...(module as any).container.getModules().values()] as any[];
    expect(entries.filter((entry) => entry.providers.has(MeriFeatureFlagsService))).toHaveLength(1);
    expect(entries.map((entry) => entry.metatype?.name)).not.toContain('MeriModule');
    expect(prisma.withTenant).not.toHaveBeenCalled();
    await module.close();
  });

  it.each(['v2', 'v3'])('invalidates the shared hot cache only after the actual %s writer commits', async (kind) => {
    const flag = kind === 'v2' ? flagRules.MERIV2_FLAGS.inEditorAssistant : MERIV3_CHAT_FLAG;
    let settings: any = { unrelated: 'preserve', clioFeatureFlags: { [flag]: true, other: true } };
    let pending: any; let release!: () => void;
    let prepared!: () => void;
    const ready = new Promise<void>((resolve) => { prepared = resolve; });
    const events: string[] = [];
    const tx = { tenant: {
      findUnique: async () => ({ slug: 'synthetic', settings }),
      update: async ({ data }: any) => { pending = data.settings; events.push('staged'); },
    }, auditLog: { create: async () => { events.push('audit'); } } };
    const prisma = {
      withTenant: async (id: string, fn: any) => { expect(id).toBe('tenant-a'); events.push('read'); return fn({ tenant: { findFirst: async () => ({ settings }) } }); },
      withSystem: async (fn: any) => { const value = await fn(tx); await new Promise<void>((resolve) => { release = resolve; prepared(); }); settings = pending; events.push('commit'); return value; },
    };
    const module = await Test.createTestingModule({ imports: [MeriFeatureFlagsModule], providers: [MeriV3AdminService] })
      .overrideProvider(PrismaService).useValue(prisma).compile();
    const flags = module.get(MeriFeatureFlagsService);
    expect(await flags.isEnabled('tenant-a', flag, true)).toBe(true);
    const invalidation = jest.spyOn(flags, 'invalidate');
    const write = kind === 'v3'
      ? module.get(MeriV3AdminService).setEnabled({ tenantId: 'operator-tenant', userId: 'operator', role: 'capiro_admin' } as any, 'tenant-a', false)
      : v2Writer(prisma, flags).setMeriV2Flag('tenant-a', flag, false);
    await Promise.race([ready, write.then(() => { throw Error('Writer returned before the held commit'); })]);
    expect(release).toBeDefined();
    expect(invalidation).not.toHaveBeenCalled();
    expect(await flags.isEnabled('tenant-a', flag, true)).toBe(true);
    release(); const receipt = await write;
    expect(receipt.clioFeatureFlags).toMatchObject({ [flag]: false, other: true });
    expect(invalidation).toHaveBeenCalledTimes(1); expect(invalidation).toHaveBeenCalledWith('tenant-a');
    expect(await flags.isEnabled('tenant-a', flag, true)).toBe(false);
    expect(settings).toMatchObject({ unrelated: 'preserve', clioFeatureFlags: { [flag]: false, other: true } });
    expect(events.indexOf('commit')).toBeGreaterThan(events.indexOf('staged'));
    expect(events.filter((event) => event === 'read')).toHaveLength(2);
    await module.close();
  });

  it('preserves tenant isolation, TTL boundary and unchanged in-flight invalidation behavior', async () => {
    jest.useFakeTimers(); jest.setSystemTime(1000);
    let resolveRead!: (value: unknown) => void;
    const reads: string[] = [];
    const prisma = { withTenant: async (id: string, fn: any) => fn({ tenant: { findFirst: async () => {
      reads.push(id);
      if (id === 'pending') return new Promise((resolve) => { resolveRead = resolve; });
      return { settings: { clioFeatureFlags: { f: id === 'a' } } };
    } } }) };
    const flags = new MeriFeatureFlagsService(prisma as any);
    try {
      expect(await flags.isEnabled('a', 'f', false)).toBe(true);
      expect(await flags.isEnabled('b', 'f', true)).toBe(false);
      jest.setSystemTime(60999); expect(await flags.isEnabled('a', 'f', false)).toBe(true);
      expect(reads).toEqual(['a', 'b']);
      jest.setSystemTime(61000); await flags.isEnabled('a', 'f', false); expect(reads).toEqual(['a', 'b', 'a']);
      const pending = flags.isEnabled('pending', 'f', false); flags.invalidate('pending');
      resolveRead({ settings: { clioFeatureFlags: { f: true } } }); expect(await pending).toBe(true);
      expect(await flags.isEnabled('pending', 'f', false)).toBe(true);
      expect(reads.filter((id) => id === 'pending')).toHaveLength(1);
      // Existing cache has no generation/CAS for an in-flight pre-invalidation read.
    } finally { jest.useRealTimers(); }
  });

  it('pins unchanged service/caller bytes and one provider declaration in the actual module metadata', () => {
    for (const path of ['apps/api/src/meri/meri-feature-flags.service.ts', 'apps/api/src/mobile/meri-mobile.service.ts',
      'apps/api/src/capiro-admin/capiro-admin.service.ts', 'apps/api/src/capiro-admin/meriv3-admin.service.ts',
      'apps/api/src/workspace-assistant/workspace-assistant.module.ts']) expect(source(path)).toBe(original(path));
    const meri = source('apps/api/src/meri/meri.module.ts');
    expect(meri).toContain('    MeriFeatureFlagsModule,');
    expect(meri).toContain('exports: [MeriToolsService, MeriFeatureFlagsModule]');
    expect(meri).not.toContain('    MeriFeatureFlagsService,');
    for (const path of ['apps/api/src/mobile/meri-mobile.module.ts', 'apps/api/src/capiro-admin/capiro-admin.module.ts']) {
      expect(source(path)).toContain('MeriFeatureFlagsModule');
      expect(source(path)).not.toMatch(/\bMeriModule\b/);
    }
  });
});
