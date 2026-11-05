import { ProfileIdentityClaimsService } from './profile-identity-claims.service.js';
const ctx = { tenantId: 'tenant-one', userId: 'actor-one' } as never;
function fixture() {
  const events = { append: jest.fn().mockResolvedValue({ id: 'event-id' }) };
  const assertions = { append: jest.fn().mockResolvedValue({ id: 'assertion-id' }) };
  const identity = { linkTenantIdentity: jest.fn() };
  return {
    service: new ProfileIdentityClaimsService(
      events as never,
      assertions as never,
      identity as never,
    ),
    events,
    assertions,
    identity,
  };
}
describe('confirmed identity relationship provenance', () => {
  it('keeps public-source relationship claims tenant scoped and explicitly human confirmed', async () => {
    const f = fixture();
    const claim = {
      kind: 'former_name' as const,
      name: 'Earlier Example',
      sourceUrl: 'https://fixture.example/about',
      quote: 'Fixture was formerly Earlier Example.',
    };
    await f.service.retain(ctx, 'canonical-id', [claim]);
    expect(f.identity.linkTenantIdentity).toHaveBeenCalledWith(
      'tenant-one',
      expect.objectContaining({
        entityId: 'canonical-id',
        aliases: [expect.objectContaining({ value: claim.name, verifiedAt: null })],
      }),
    );
    expect(f.events.append).toHaveBeenCalledWith(
      'tenant-one',
      expect.objectContaining({
        accessScope: { kind: 'tenant' },
        evidenceLocator: { url: claim.sourceUrl },
      }),
    );
    expect(f.assertions.append).toHaveBeenCalledWith(
      'tenant-one',
      expect.objectContaining({
        subjectId: 'canonical-id',
        authority: 'human_confirmed',
        predicate: 'identity_former_name',
        evidence: [expect.objectContaining({ excerpt: claim.quote, sourceText: claim.quote })],
      }),
    );
  });
  it('keeps private uploaded-document excerpts in the existing user scope', async () => {
    const f = fixture();
    const claim = {
      kind: 'parent' as const,
      name: 'Parent Example',
      attachmentId: 'attachment-id',
      quote: 'Fixture is owned by Parent Example.',
    };
    await f.service.retain(ctx, 'canonical-id', [claim]);
    expect(f.events.append).toHaveBeenCalledWith(
      'tenant-one',
      expect.objectContaining({
        sourceType: 'profile_identity_document',
        sourceId: 'attachment-id',
        accessScope: { kind: 'user', userId: 'actor-one', clientIds: [] },
        evidenceLocator: { attachmentId: 'attachment-id' },
      }),
    );
    expect(f.identity.linkTenantIdentity).not.toHaveBeenCalled();
  });

  it('keeps document aliases and former names out of tenant-wide identity search', async () => {
    const f = fixture();
    for (const kind of ['alias', 'former_name'] as const)
      await f.service.retain(ctx, 'canonical-id', [
        {
          kind,
          name: 'Private Source Name',
          attachmentId: 'attachment-id',
          quote: 'Fixture was previously Private Source Name.',
        },
      ]);
    expect(f.identity.linkTenantIdentity).not.toHaveBeenCalled();
    expect(f.assertions.append).toHaveBeenCalledTimes(2);
    expect(f.events.append).toHaveBeenLastCalledWith(
      'tenant-one',
      expect.objectContaining({
        accessScope: { kind: 'user', userId: 'actor-one', clientIds: [] },
      }),
    );
  });
});
