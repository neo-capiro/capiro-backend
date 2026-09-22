import { MeriV3AssistantService } from './meriv3-assistant.service.js';

function harness() {
  const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  const service = Object.create(MeriV3AssistantService.prototype) as MeriV3AssistantService;
  Object.assign(service as object, { logger });
  const internals = service as unknown as {
    validateCitationExposure: (
      artifact: Record<string, unknown>,
      citations: unknown[],
      mode: 'off' | 'shadow' | 'enforce',
      surface: 'artifact',
      conversationId?: string,
    ) => Record<string, unknown>;
    validateCitationText: (
      text: string,
      citations: unknown[],
      mode: 'off' | 'shadow' | 'enforce',
      surface: 'page_write',
      conversationId?: string,
    ) => string;
    finalizeReply: (args: Record<string, unknown>) => { reply: string };
  };
  return { internals, logger };
}

const citation = {
  n: 1,
  type: 'source',
  id: 'source-1',
  title: 'Registered source',
  url: null,
  snippet: 'Evidence',
  tool: 'search_memory',
};

function expectIntegrity(
  logger: { warn: jest.Mock },
  surface: 'artifact' | 'page_write' | 'reply',
  mode: 'shadow' | 'enforce',
) {
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith('meri.citation_integrity', {
    conversationId: 'conversation-1',
    turnId: null,
    surface,
    dropped: [53],
    registered: 1,
    mode,
  });
}

describe('MeriV3 citation exposure', () => {
  it.each([
    ['off', 'Artifact claim [1] and orphan [53].'],
    ['shadow', 'Artifact claim [1] and orphan [53].'],
    ['enforce', 'Artifact claim [1] and orphan .'],
  ] as const)('handles artifact markers in %s mode', (mode, expected) => {
    const { internals, logger } = harness();
    const artifact = internals.validateCitationExposure(
      { title: 'Brief', bodyText: 'Artifact claim [1] and orphan [53].' },
      [citation],
      mode,
      'artifact',
      'conversation-1',
    );
    expect(artifact.bodyText).toBe(expected);
    if (mode === 'off') expect(logger.warn).not.toHaveBeenCalled();
    else expectIntegrity(logger, 'artifact', mode);
  });

  it.each([
    ['off', 'Draft claim [1] and orphan [53].'],
    ['shadow', 'Draft claim [1] and orphan [53].'],
    ['enforce', 'Draft claim [1] and orphan .'],
  ] as const)('handles page_write markers in %s mode', (mode, expected) => {
    const { internals, logger } = harness();
    expect(
      internals.validateCitationText(
        'Draft claim [1] and orphan [53].',
        [citation],
        mode,
        'page_write',
        'conversation-1',
      ),
    ).toBe(expected);
    if (mode === 'off') expect(logger.warn).not.toHaveBeenCalled();
    else expectIntegrity(logger, 'page_write', mode);
  });

  it.each(['off', 'shadow', 'enforce'] as const)('logs reply orphan markers only outside %s mode', (mode) => {
    const { internals, logger } = harness();
    const result = internals.finalizeReply({
      ctx: { tenantId: 'tenant-1', userId: 'user-1' },
      dto: { conversationId: 'conversation-1' },
      reply: 'Reply claim [1] and orphan [53].',
      citations: [citation],
      ledgerEntries: [],
      evidencePlan: {},
      assuranceRisk: { requiresBufferBeforeRelease: false },
      assuranceMode: 'off',
      evidenceAccuracyMode: mode,
      verificationAvailable: true,
      emit: jest.fn(),
    });
    expect(result.reply).toBe('Reply claim [1] and orphan .');
    if (mode === 'off') expect(logger.warn).not.toHaveBeenCalled();
    else expectIntegrity(logger, 'reply', mode);
  });
});
