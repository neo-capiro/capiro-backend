import { assertMeriContext, DefaultScopingWrapper, ScopingError } from './scoping-wrapper';
import type { MeriContext } from '../registry/types';

const valid: MeriContext = {
  tenantId: 't',
  userId: 'u',
  clerkUserId: 'c',
  role: 'standard_user',
};

describe('assertMeriContext', () => {
  it('passes for a complete context', () => {
    expect(() => assertMeriContext(valid)).not.toThrow();
  });

  it('throws for null/undefined', () => {
    expect(() => assertMeriContext(null)).toThrow(ScopingError);
    expect(() => assertMeriContext(undefined)).toThrow(ScopingError);
  });

  it.each(['tenantId', 'userId', 'clerkUserId', 'role'] as const)(
    'throws when %s is blank',
    (field) => {
      const ctx: MeriContext = { ...valid, [field]: '' };
      expect(() => assertMeriContext(ctx)).toThrow(ScopingError);
    },
  );
});

describe('DefaultScopingWrapper', () => {
  it('runs the fn for a valid context', async () => {
    const w = new DefaultScopingWrapper();
    await expect(w.enforce(valid, async () => 'ok')).resolves.toBe('ok');
  });

  it('throws before running the fn for an invalid context', async () => {
    const w = new DefaultScopingWrapper();
    let ran = false;
    await expect(
      w.enforce({ ...valid, tenantId: '' }, async () => {
        ran = true;
        return 'ok';
      }),
    ).rejects.toBeInstanceOf(ScopingError);
    expect(ran).toBe(false);
  });
});
