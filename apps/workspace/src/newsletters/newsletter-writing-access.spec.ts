import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { NewsletterService } from './newsletter.service.js';

const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', clerkUserId: 'synthetic-owner' };
const id = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const input = { prompt: 'Summarize', text: 'Synthetic source material', kind: 'paragraph' };
const result = { content: [{ type: 'text', text: 'Synthetic generated text' }] };

afterEach(() => jest.restoreAllMocks());

it('withholds writing output when client access is revoked during the provider response', async () => {
  let wallAllowed = true;
  const document = {
    findFirst: jest.fn().mockResolvedValue({
      id,
      tenantId: ctx.tenantId,
      ownerId: ctx.clerkUserId,
      config: { clientId },
      design: { sections: [] },
    }),
  };
  const source = {
    resolveUserId: jest.fn().mockResolvedValue('synthetic-core-user'),
    getClient: jest.fn(async () => ({ wallAllowed })),
  };
  const credentials = {
    resolveAnthropic: jest
      .fn()
      .mockResolvedValue({ secret: 'synthetic-test-key', model: 'synthetic-model' }),
  };
  const service = new NewsletterService(
    { wsNewsletterDocument: document } as never,
    source as never,
    credentials as never,
    {} as never,
  );
  const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => result,
  } as Response);
  await expect(service.write(ctx, id, input)).resolves.toEqual({
    text: 'Synthetic generated text',
  });

  let release!: (value: typeof result) => void;
  let reading!: () => void;
  const responseBody = new Promise<typeof result>((resolve) => {
    release = resolve;
  });
  const readingBody = new Promise<void>((resolve) => {
    reading = resolve;
  });
  fetcher.mockResolvedValueOnce({
    ok: true,
    json: () => {
      reading();
      return responseBody;
    },
  } as Response);
  const pending = service.write(ctx, id, input);
  await readingBody;
  wallAllowed = false;
  const refused = expect(pending).rejects.toBeInstanceOf(NotFoundException);
  release(result);
  await refused;
  expect(fetcher).toHaveBeenCalledTimes(2); // One synthetic fetch per explicit request, no retry.
  expect(document.findFirst).toHaveBeenLastCalledWith({ where: { id, tenantId: ctx.tenantId } });
  expect(source.getClient).toHaveBeenLastCalledWith(ctx.tenantId, 'synthetic-core-user', clientId);
  expect(source.getClient).toHaveBeenCalledTimes(4);
});
