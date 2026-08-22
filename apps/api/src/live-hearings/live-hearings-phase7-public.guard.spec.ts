import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { LiveHearingsPhase7PublicGuard } from './live-hearings-phase7-public.guard.js';

describe('LiveHearingsPhase7PublicGuard', () => {
  it('allows canonical public hearings', async () => {
    const prisma = {
      committeeHearing: {
        findUnique: jest.fn().mockResolvedValue({ id: 'h-1', visibility: 'public' }),
      },
    };
    const guard = new LiveHearingsPhase7PublicGuard(prisma as never);
    await expect(guard.assertPublic('h-1')).resolves.toBeUndefined();
  });

  it('rejects non-public transcript reads', async () => {
    const prisma = {
      committeeHearing: {
        findUnique: jest.fn().mockResolvedValue({ id: 'h-private', visibility: 'private' }),
      },
    };
    const guard = new LiveHearingsPhase7PublicGuard(prisma as never);
    await expect(guard.assertPublic('h-private')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('404s unknown hearing ids', async () => {
    const prisma = { committeeHearing: { findUnique: jest.fn().mockResolvedValue(null) } };
    const guard = new LiveHearingsPhase7PublicGuard(prisma as never);
    await expect(guard.assertPublic('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
