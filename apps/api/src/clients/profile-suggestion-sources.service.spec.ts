jest.mock('../engagement/engagement.service.js', () => ({ EngagementService: class {} }));
jest.mock('./profile-subject.js', () => ({ requireProfileSubject: jest.fn() }));
jest.mock('./profile-shared-evidence.js', () => ({ assertSharedProfileEvidence: jest.fn() }));
jest.mock('../meri/hardenedWebTransport.js', () => ({
  withGuardedWebResponse: jest.fn(),
  readBodyWithSizeLimit: jest.fn(),
}));
import { NotFoundException } from '@nestjs/common';
import { ProfileSuggestionSourcesService } from './profile-suggestion-sources.service.js';
import { requireProfileSubject } from './profile-subject.js';
import { assertSharedProfileEvidence } from './profile-shared-evidence.js';
import { withGuardedWebResponse, readBodyWithSizeLimit } from '../meri/hardenedWebTransport.js';

const ctx = { tenantId: 'fixture-tenant', userId: 'fixture-user' } as never;
const subject = { kind: 'client' as const, id: 'fixture-client' };
function fixture() {
  const tx = {
    engagementAttachment: {
      findFirstOrThrow: jest
        .fn()
        .mockResolvedValue({ prospectId: 'original-prospect', fileName: 'Shared brochure' }),
    },
  };
  const prisma = { withTenantUser: jest.fn((_tenant, _actor, callback) => callback(tx)) };
  const extractAttachmentText = jest.fn().mockResolvedValue({ text: 'Shared source text' });
  return {
    service: new ProfileSuggestionSourcesService(
      prisma as never,
      { extractAttachmentText } as never,
    ),
    tx,
    extractAttachmentText,
  };
}
describe('registration source readers', () => {
  beforeEach(() => jest.resetAllMocks());
  it('uses the hardened DNS/redirect/stream owner with bounded reads', async () => {
    const scope = {} as never;
    const response = new Response('<p>Fixture engineering services</p>', {
      headers: { 'content-type': 'text/html' },
    });
    jest
      .mocked(readBodyWithSizeLimit)
      .mockResolvedValue(new TextEncoder().encode('<p>Fixture engineering services</p>'));
    jest
      .mocked(withGuardedWebResponse)
      .mockImplementation(async (_url, callback) =>
        callback(response, 'https://fixture.example/about', scope),
      );
    expect(await fixture().service.website('https://fixture.example')).toMatchObject({
      source: 'website',
      url: 'https://fixture.example/about',
      text: 'Fixture engineering services',
    });
    expect(withGuardedWebResponse).toHaveBeenCalledWith(
      'https://fixture.example',
      expect.any(Function),
      expect.objectContaining({ deadlineMs: 12000, maxRedirects: 3 }),
    );
    expect(readBodyWithSizeLimit).toHaveBeenCalledWith(response, 500000, scope);
  });
  it('reads converted documents through their original owner without paid extraction or writes', async () => {
    const f = fixture();
    expect(await f.service.document(ctx, subject, 'document')).toMatchObject({
      attachmentId: 'document',
      text: 'Shared source text',
    });
    expect(f.extractAttachmentText).toHaveBeenCalledWith(ctx, 'document', {
      prospectId: 'original-prospect',
      readOnly: true,
      allowPaidExtraction: false,
      signal: undefined,
    });
    expect(requireProfileSubject).toHaveBeenCalledTimes(2);
    expect(assertSharedProfileEvidence).toHaveBeenCalledTimes(2);
  });
  it('does not return source text when access changes during extraction', async () => {
    jest
      .mocked(assertSharedProfileEvidence)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new NotFoundException());
    await expect(fixture().service.document(ctx, subject, 'document')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('does not read a document denied by its current owner', async () => {
    jest.mocked(requireProfileSubject).mockRejectedValue(new NotFoundException());
    const f = fixture();
    await expect(f.service.document(ctx, subject, 'document')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(f.extractAttachmentText).not.toHaveBeenCalled();
  });
});
