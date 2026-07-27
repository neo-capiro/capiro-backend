import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { MemoLinkDto } from '../src/feed/action-item.controller.js';

/** Gate H a-5: the `content` field added to MemoLinkDto for reading a saved memo back. */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
function validate(value: unknown) {
  return pipe.transform(value, { type: 'body', metatype: MemoLinkDto, data: '' });
}

describe('MemoLinkDto content field (Gate H a-5)', () => {
  it('accepts a normal-length memo', async () => {
    await expect(
      validate({ documentAttachmentId: 'att-1', title: 'Memo', content: '# Heading\n\nBody.' }),
    ).resolves.toBeDefined();
  });

  it('accepts the payload with content omitted (metadata-only update)', async () => {
    await expect(validate({ documentAttachmentId: 'att-1', title: 'Memo' })).resolves.toBeDefined();
  });

  it('rejects content over 100,000 characters', async () => {
    await expect(validate({ content: 'x'.repeat(100_001) })).rejects.toThrow(BadRequestException);
  });

  it('accepts content at exactly 100,000 characters', async () => {
    await expect(validate({ content: 'x'.repeat(100_000) })).resolves.toBeDefined();
  });

  it('rejects an extra, non-whitelisted property (existing DTO posture, unaffected by the new field)', async () => {
    await expect(validate({ content: 'ok', bogus: true })).rejects.toThrow(BadRequestException);
  });
});
