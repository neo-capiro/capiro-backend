import { ClientKbService } from './client-kb.service.js';

it('awaited source indexing preserves configured disabled state and propagates real index failure', async () => {
  const service = Object.create(ClientKbService.prototype) as ClientKbService;
  let enabled = false;
  const indexAttachment = jest.fn().mockRejectedValue(new Error('actual index failure'));
  Object.assign(service, { config: { get: () => enabled }, indexAttachment });
  await service.indexAttachmentIfEnabled('tenant', 'document');
  expect(indexAttachment).not.toHaveBeenCalled();
  enabled = true;
  await expect(service.indexAttachmentIfEnabled('tenant', 'document')).rejects.toThrow(
    'actual index failure',
  );
  expect(indexAttachment).toHaveBeenCalledTimes(1);
});
