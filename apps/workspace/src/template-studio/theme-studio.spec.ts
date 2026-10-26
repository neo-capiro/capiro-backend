import { ConflictException, NotFoundException } from '@nestjs/common';
import { ThemeStudioService } from './theme-studio.service.js';

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
