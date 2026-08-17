import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import {
  MERI_CONVERSATION_STORE_ERROR,
  MERI_PROVIDER_CONFIGURATION_ERROR,
  MERI_STREAM_SETUP_ERROR,
  classifyMeriStreamSetupError,
  createDeferredMeriSseWriter,
  meriProviderConfigurationError,
  writeMeriStreamErrorFrame,
} from './meri-stream-preflight.helpers.js';

describe('classifyMeriStreamSetupError', () => {
  test('maps a missing/invalid provider credential to MERI_PROVIDER_CONFIGURATION_ERROR', () => {
    expect(classifyMeriStreamSetupError(new Error('ANTHROPIC_API_KEY not configured'))).toEqual({
      status: 503,
      code: MERI_PROVIDER_CONFIGURATION_ERROR,
      message: 'Meri is missing a usable AI provider configuration for this tenant.',
    });
    expect(classifyMeriStreamSetupError(meriProviderConfigurationError())).toEqual({
      status: 503,
      code: MERI_PROVIDER_CONFIGURATION_ERROR,
      message: 'Meri is missing a usable AI provider configuration for this tenant.',
    });
  });

  test('maps a conversation-schema / Prisma mismatch to MERI_CONVERSATION_STORE_ERROR', () => {
    const prisma = Object.assign(new Error('The column `summary_up_to_message_id` does not exist'), {
      code: 'P2022',
    });
    expect(classifyMeriStreamSetupError(prisma)).toEqual({
      status: 500,
      code: MERI_CONVERSATION_STORE_ERROR,
      message: 'Meri could not load this conversation. The conversation store may be out of date.',
    });
  });

  test('preserves an already-classified HttpException', () => {
    const err = new ServiceUnavailableException({
      statusCode: 503,
      code: 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED',
      message: 'This action is disabled in the engagement-api shadow runtime.',
    });
    expect(classifyMeriStreamSetupError(err)).toEqual({
      status: 503,
      code: 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED',
      message: 'This action is disabled in the engagement-api shadow runtime.',
    });
    expect(classifyMeriStreamSetupError(new BadRequestException('Message body is empty'))).toEqual({
      status: 400,
      code: MERI_STREAM_SETUP_ERROR,
      message: 'Message body is empty',
    });
  });
});

describe('createDeferredMeriSseWriter', () => {
  test('does not set SSE headers until the first frame is written', () => {
    const res = {
      setHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      status: jest.fn(),
    };
    const sse = createDeferredMeriSseWriter(res);
    expect(sse.started()).toBe(false);
    expect(res.setHeader).not.toHaveBeenCalled();
    sse.write('data: {"type":"start"}\n\n');
    expect(sse.started()).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.write).toHaveBeenCalledWith('data: {"type":"start"}\n\n');
  });

  test('writes a structured in-stream error instead of a generic HTTP 500 body', () => {
    const frames: string[] = [];
    writeMeriStreamErrorFrame(
      (data) => frames.push(data),
      {
        status: 503,
        code: MERI_PROVIDER_CONFIGURATION_ERROR,
        message: 'Meri is missing a usable AI provider configuration for this tenant.',
      },
    );
    expect(frames[0]).toContain(MERI_PROVIDER_CONFIGURATION_ERROR);
    expect(frames[0]).not.toContain('Internal server error');
    expect(frames[1]).toContain('"type":"done"');
  });
});
