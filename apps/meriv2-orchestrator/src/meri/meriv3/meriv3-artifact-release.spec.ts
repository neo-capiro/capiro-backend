import { MeriV3AssistantService } from './meriv3-assistant.service.js';
import { MeriV3ManagedMcpAssistantService } from './meriv3-managed-mcp-assistant.service.js';
import type { MeriV3ChatStreamEvent } from './meriv3.types.js';

function make() {
  const discard = jest.fn(async () => ({ deleted: 1 }));
  const service = new MeriV3ManagedMcpAssistantService(
    { registry: { list: () => [], get: () => undefined } } as never,
    {} as never,
    {} as never,
    {} as never,
    { get: jest.fn(() => 'http://api.test') } as never,
    { schemas: jest.fn(async () => []), executeRead: jest.fn() } as never,
    { available: jest.fn(async () => true), execute: jest.fn(), discard } as never,
  );
  return { service, discard };
}

const chartEvent: Extract<MeriV3ChatStreamEvent, { type: 'artifact' }> = {
  type: 'artifact',
  artifact: { id: 'chart-1', title: 'Funding trajectory', kind: 'analysis_chart' },
};

describe('MeriV3 artifact release ordering', () => {
  afterEach(() => jest.restoreAllMocks());

  test('buffers artifacts until the base assurance gate returns them as releasable', async () => {
    jest
      .spyOn(MeriV3AssistantService.prototype, 'run')
      .mockImplementation(async (_ctx, _dto, opts) => {
        opts?.onEvent?.(chartEvent);
        opts?.onEvent?.({ type: 'text', text: 'Verified answer.' });
        return {
          reply: 'Verified answer.',
          runtime: 'meriv3',
          model: 'test',
          reasoningMode: 'standard',
          reasoningEffort: 'medium',
          artifacts: [chartEvent.artifact],
        };
      });
    const events: MeriV3ChatStreamEvent[] = [];
    const { service, discard } = make();

    await service.run(
      {} as never,
      { messages: [{ role: 'user', text: 'Chart the funding trajectory.' }] },
      { onEvent: (event) => events.push(event) },
    );

    expect(events.map((event) => event.type)).toEqual(['text', 'artifact']);
    expect(events[1]).toEqual(chartEvent);
    expect(discard).not.toHaveBeenCalled();
  });

  test('does not release a held chart and immediately discards its unlinked artifact', async () => {
    jest
      .spyOn(MeriV3AssistantService.prototype, 'run')
      .mockImplementation(async (_ctx, _dto, opts) => {
        opts?.onEvent?.(chartEvent);
        opts?.onEvent?.({ type: 'text', text: 'I could not safely release this answer.' });
        return {
          reply: 'I could not safely release this answer.',
          runtime: 'meriv3',
          model: 'test',
          reasoningMode: 'deep',
          reasoningEffort: 'high',
        };
      });
    const events: MeriV3ChatStreamEvent[] = [];
    const { service, discard } = make();

    await service.run(
      {} as never,
      { messages: [{ role: 'user', text: 'Chart exact enacted funding.' }] },
      { onEvent: (event) => events.push(event) },
    );

    expect(events).toEqual([{ type: 'text', text: 'I could not safely release this answer.' }]);
    expect(discard).toHaveBeenCalledWith(['chart-1']);
  });

  test('deduplicates released artifacts and discards only withheld analysis charts', async () => {
    const withheld = {
      type: 'artifact' as const,
      artifact: { id: 'chart-2', title: 'Other chart', kind: 'analysis_chart' },
    };
    const unrelated = {
      type: 'artifact' as const,
      artifact: { id: 'doc-1', title: 'Document', kind: 'document' },
    } as Extract<MeriV3ChatStreamEvent, { type: 'artifact' }>;
    jest
      .spyOn(MeriV3AssistantService.prototype, 'run')
      .mockImplementation(async (_ctx, _dto, opts) => {
        opts?.onEvent?.(chartEvent);
        opts?.onEvent?.(chartEvent);
        opts?.onEvent?.(withheld);
        opts?.onEvent?.(unrelated);
        return {
          reply: 'Done.',
          runtime: 'meriv3',
          model: 'test',
          reasoningMode: 'standard',
          reasoningEffort: 'medium',
          artifacts: [chartEvent.artifact],
        };
      });
    const events: MeriV3ChatStreamEvent[] = [];
    const { service, discard } = make();

    await service.run(
      {} as never,
      { messages: [{ role: 'user', text: 'Compare the values.' }] },
      { onEvent: (event) => events.push(event) },
    );

    expect(events).toEqual([chartEvent]);
    expect(discard).toHaveBeenCalledWith(['chart-2']);
  });

  test('cleanup failure does not convert a held safe response into an error', async () => {
    jest
      .spyOn(MeriV3AssistantService.prototype, 'run')
      .mockImplementation(async (_ctx, _dto, opts) => {
        opts?.onEvent?.(chartEvent);
        return {
          reply: 'Held.',
          runtime: 'meriv3',
          model: 'test',
          reasoningMode: 'deep',
          reasoningEffort: 'high',
        };
      });
    const { service, discard } = make();
    discard.mockRejectedValueOnce(new Error('cleanup unavailable'));
    await expect(
      service.run(
        {} as never,
        { messages: [{ role: 'user', text: 'Chart it.' }] },
        { onEvent: () => undefined },
      ),
    ).resolves.toEqual(expect.objectContaining({ reply: 'Held.' }));
  });

  test('an assistant-loop failure discards buffered analysis charts before rethrowing', async () => {
    jest
      .spyOn(MeriV3AssistantService.prototype, 'run')
      .mockImplementation(async (_ctx, _dto, opts) => {
        opts?.onEvent?.(chartEvent);
        throw new Error('provider stream failed');
      });
    const { service, discard } = make();

    await expect(
      service.run(
        {} as never,
        { messages: [{ role: 'user', text: 'Chart the trend.' }] },
        { onEvent: () => undefined },
      ),
    ).rejects.toThrow('provider stream failed');
    expect(discard).toHaveBeenCalledWith(['chart-1']);
  });
});
