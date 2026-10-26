import { ConflictException, NotFoundException } from '@nestjs/common';
import { ThemeStudioService } from './theme-studio.service.js';
import { validate } from 'class-validator';
import { SaveThemeDraftDto, ThemeVersionExpectationDto } from './dto/theme.dto.js';
import { ThemeStudioController } from './theme-studio.controller.js';

function fixture(status = 'draft') {
  let row = {
    id: 'version',
    themeId: 'theme',
    tenantId: 'tenant',
    status,
    settings: { paperColor: '#fff' },
    settingsHash: 'old-hash',
  };
  let race = () => {};
  const db = {
    wsTheme: {
      findFirst: jest.fn(async ({ where }) =>
        where.id === 'theme' && where.tenantId === 'tenant' ? { id: 'theme' } : null,
      ),
    },
    wsThemeVersion: {
      findFirst: jest.fn(async ({ where }) =>
        where.id === row.id && where.themeId === row.themeId ? { ...row } : null,
      ),
      update: jest.fn(async ({ where, data }) => {
        race();
        if (Object.entries(where).some(([k, v]) => row[k as keyof typeof row] !== v))
          throw { code: 'P2025' };
        row = { ...row, ...data };
        return { ...row };
      }),
    },
  };
  return {
    db,
    service: new ThemeStudioService(db as never),
    current: () => row,
    race: (fn: () => void) => {
      race = fn;
    },
    change: (fields: Partial<typeof row>) => {
      row = { ...row, ...fields };
    },
  };
}

describe('Theme version conditional writes', () => {
  it('saves tenant draft and hashes its real settings', async () => {
    const f = fixture();
    const result = await f.service.saveDraft('tenant', 'theme', 'version', {
      settings: { paperColor: '#aaa' },
    });
    expect(result.settings).toEqual({ paperColor: '#aaa' });
    expect(result.settingsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.db.wsThemeVersion.update.mock.calls[0]![0].where).toEqual({
      id: 'version',
      themeId: 'theme',
      tenantId: 'tenant',
      status: 'draft',
      settingsHash: 'old-hash',
    });
  });
  it.each(['published', 'retired'])('refuses %s edits without a write', async (status) => {
    const f = fixture(status);
    await expect(
      f.service.saveDraft('tenant', 'theme', 'version', { settings: {} }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.db.wsThemeVersion.update).not.toHaveBeenCalled();
  });
  it.each(['other-tenant', 'missing'])('does not expose %s parent', async (tenant) => {
    const f = fixture();
    await expect(f.service.getVersion(tenant, 'theme', 'version')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(f.db.wsThemeVersion.findFirst).not.toHaveBeenCalled();
  });
  it('refuses mismatched version parent', async () => {
    const f = fixture();
    f.change({ themeId: 'elsewhere' });
    await expect(f.service.getVersion('tenant', 'theme', 'version')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('does not overwrite a version published between read and save', async () => {
    const f = fixture();
    f.race(() => f.change({ status: 'published' }));
    await expect(
      f.service.saveDraft('tenant', 'theme', 'version', { settings: {} }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.current().settings).toEqual({ paperColor: '#fff' });
  });
  it('does not publish settings changed after the checked read', async () => {
    const f = fixture();
    f.race(() => f.change({ settingsHash: 'new-hash' }));
    await expect(
      f.service.publishVersion('tenant', 'theme', 'version', 'member'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.current().status).toBe('draft');
  });
  it('allows current tenant member to publish then retire', async () => {
    const f = fixture();
    expect((await f.service.publishVersion('tenant', 'theme', 'version', 'member')).status).toBe(
      'published',
    );
    expect((await f.service.retireVersion('tenant', 'theme', 'version', 'member')).status).toBe(
      'retired',
    );
  });
  it('refuses concurrent retirement and preserves a changed parent', async () => {
    const f = fixture('published');
    f.race(() => f.change({ themeId: 'different' }));
    await expect(
      f.service.retireVersion('tenant', 'theme', 'version', 'member'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.current().status).toBe('published');
  });
  it('does not hide database failures', async () => {
    const f = fixture();
    f.db.wsThemeVersion.update.mockRejectedValueOnce(new Error('write failed'));
    await expect(
      f.service.saveDraft('tenant', 'theme', 'version', { settings: {} }),
    ).rejects.toThrow('write failed');
  });
});

const expectedActions: Array<
  [string, (service: ThemeStudioService, hash: string) => Promise<unknown>]
> = [
  [
    'save',
    (service, expectedSettingsHash) =>
      service.saveDraft('tenant', 'theme', 'version', { settings: {}, expectedSettingsHash }),
  ],
  [
    'publish',
    (service, expectedSettingsHash) =>
      service.publishVersion('tenant', 'theme', 'version', 'member', { expectedSettingsHash }),
  ],
  [
    'retire',
    (service, expectedSettingsHash) =>
      service.retireVersion('tenant', 'theme', 'version', 'member', { expectedSettingsHash }),
  ],
];
describe('Theme displayed-settings precondition', () => {
  it('admits omitted/matching request preconditions and refuses null or malformed hashes', async () => {
    for (const dto of [
      new ThemeVersionExpectationDto(),
      Object.assign(new SaveThemeDraftDto(), { settings: {} }),
    ]) {
      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
      Object.assign(dto, { expectedSettingsHash: 'a'.repeat(64) });
      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
      for (const invalid of [null, '', 'short', 'A'.repeat(64), 1]) {
        Object.assign(dto, { expectedSettingsHash: invalid });
        expect(
          (await validate(dto)).some((error) => error.property === 'expectedSettingsHash'),
        ).toBe(true);
      }
    }
  });
  it('forwards lifecycle request bodies through the existing controller', () => {
    const service = { publishVersion: jest.fn(), retireVersion: jest.fn() };
    const controller = new ThemeStudioController(service as never);
    const dto = { expectedSettingsHash: 'a'.repeat(64) },
      ctx = { tenantId: 'tenant', clerkUserId: 'member', role: null };
    controller.publishVersion(ctx, 'theme', 'version', dto);
    controller.retireVersion(ctx, 'theme', 'version', dto);
    expect(service.publishVersion).toHaveBeenCalledWith(
      'tenant',
      'theme',
      'version',
      'member',
      dto,
    );
    expect(service.retireVersion).toHaveBeenCalledWith('tenant', 'theme', 'version', 'member', dto);
  });
  it.each(expectedActions)('refuses stale displayed hash before %s writes', async (name, act) => {
    const f = fixture(name === 'retire' ? 'published' : 'draft');
    await expect(act(f.service, 'stale-hash')).rejects.toBeInstanceOf(ConflictException);
    expect(f.db.wsThemeVersion.update).not.toHaveBeenCalled();
  });
  it.each(expectedActions)('accepts exact displayed hash for %s', async (name, act) => {
    const f = fixture(name === 'retire' ? 'published' : 'draft');
    await expect(act(f.service, f.current().settingsHash)).resolves.toBeDefined();
  });
});
