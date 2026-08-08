import { MeetingCapturePersistenceService } from './meeting-capture-persistence.service.js';

describe('MeetingCapturePersistenceService', () => {
  it('exposes only the four Notetaker persistence operations', () => {
    const methods = Object.getOwnPropertyNames(MeetingCapturePersistenceService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    expect(methods).toEqual([
      'createAttachmentFromBuffer',
      'createMeetingNote',
      'deleteAttachment',
      'generateMeetingDebriefDraft',
    ]);
  });

  it('delegates without widening the input or changing lifecycle behavior', async () => {
    const engagement = {
      createAttachmentFromBuffer: jest.fn().mockResolvedValue({ id: 'a1' }),
      deleteAttachment: jest.fn().mockResolvedValue({ ok: true }),
      generateMeetingDebriefDraft: jest.fn().mockResolvedValue({ recap: 'r' }),
      createMeetingNote: jest.fn().mockResolvedValue({ id: 'n1' }),
    };
    const service = new MeetingCapturePersistenceService(engagement as never);
    const ctx = { tenantId: 'tenant' } as never;

    await service.createAttachmentFromBuffer(ctx, { buffer: Buffer.from('x') } as never);
    await service.deleteAttachment(ctx, 'a1');
    await service.generateMeetingDebriefDraft(ctx, 'm1', { method: 'upload' } as never);
    await service.createMeetingNote(ctx, 'm1', { body: 'note' });

    expect(engagement.createAttachmentFromBuffer).toHaveBeenCalledTimes(1);
    expect(engagement.deleteAttachment).toHaveBeenCalledWith(ctx, 'a1');
    expect(engagement.generateMeetingDebriefDraft).toHaveBeenCalledTimes(1);
    expect(engagement.createMeetingNote).toHaveBeenCalledWith(ctx, 'm1', { body: 'note' });
  });
});
